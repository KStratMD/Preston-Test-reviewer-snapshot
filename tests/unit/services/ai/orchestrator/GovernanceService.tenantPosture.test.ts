/**
 * GovernanceService — per-tenant posture (PR-C3)
 *
 * Pins the contract introduced by PR-C3:
 *   - `getPostureForTenant(tenantId)` resolves the four `governance.*`
 *     keys from `tenant_configurations` and shapes them into a
 *     `TenantGovernancePosture`.
 *   - SYSTEM_IDENTITY / undefined / empty tenantId short-circuits to
 *     `DEFAULT_POSTURE` without ever touching the provider.
 *   - Any error from the provider (DB outage, encrypted-row strict
 *     violation, etc.) falls back to `DEFAULT_POSTURE` and does NOT
 *     poison the cache.
 *   - The 60s TTL cache returns cached postures within the window and
 *     re-reads after it expires.
 *   - `detectPII(data)` keeps its pre-C3 signature and forwards the
 *     pre-C3 hardcoded scan policy verbatim to DLPService (commit-2
 *     invariant requires `autoRedact:true` unconditionally). Per-tenant
 *     posture is consumed at the DECISION layer in `validateInput()` /
 *     `validateOutput()` instead — see those describe blocks below.
 *
 * Out of scope (deferred to PR-C3.1):
 *   - Migration of the other 8 DLP callsites enumerated in the PR-C3
 *     scoping report (MCPAggregator, OutboundGovernance, syncErrorAssist
 *     sites, WorkflowPayloadResolver, WorkflowCentralService).
 *   - The audit CI gate enforcing all `governance.*` reads route through
 *     `getPostureForTenant` (would false-positive against the 8 not-yet-
 *     migrated sites).
 */

import 'reflect-metadata';
import {
  DEFAULT_POSTURE,
  GOVERNANCE_POSTURE_CACHE_MAX_ENTRIES,
  GOVERNANCE_POSTURE_CACHE_TTL_MS,
  GovernanceService,
  type TenantConfigurationProvider,
  type TenantGovernancePosture,
} from '../../../../../src/services/ai/orchestrator/GovernanceService';
import { DLPService } from '../../../../../src/services/security/DLPService';
import type { Logger } from '../../../../../src/utils/Logger';
import type { TenantConfigurationRepository } from '../../../../../src/database/repositories/TenantConfigurationRepository';
import { SYSTEM_IDENTITY } from '../../../../../src/services/governance/identityContext';

type TcrStub = {
  getBooleanStrict: jest.Mock<Promise<boolean>, [string, string]>;
  getString: jest.Mock<Promise<string | null>, [string, string]>;
};

function makeStubTcr(): TcrStub {
  return {
    getBooleanStrict: jest.fn(),
    getString: jest.fn(),
  };
}

function makeProvider(tcr: TcrStub): {
  provider: TenantConfigurationProvider;
  providerCallCount: () => number;
} {
  let calls = 0;
  const provider: TenantConfigurationProvider = () => {
    calls += 1;
    return Promise.resolve(tcr as unknown as TenantConfigurationRepository);
  };
  return { provider, providerCallCount: () => calls };
}

function makeLogger(): Logger & {
  warn: jest.Mock;
  error: jest.Mock;
  info: jest.Mock;
  debug: jest.Mock;
} {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger & {
    warn: jest.Mock;
    error: jest.Mock;
    info: jest.Mock;
    debug: jest.Mock;
  };
}

describe('GovernanceService — per-tenant posture (PR-C3)', () => {
  describe('DEFAULT_POSTURE invariants', () => {
    it('is frozen so callers cannot mutate the shared default', () => {
      expect(Object.isFrozen(DEFAULT_POSTURE)).toBe(true);
    });

    it('matches the pre-C3 hardcoded literal so fallback is regression-equivalent', () => {
      // These values are the literal that previously lived inline in
      // `detectPII()` before PR-C3 introduced per-tenant posture. Drift
      // here would mean tenants without `governance.*` rows see a
      // behavior change after a deploy.
      expect(DEFAULT_POSTURE.allowPII).toBe(false);
      expect(DEFAULT_POSTURE.blockOnDetection).toBe(false);
      expect(DEFAULT_POSTURE.autoRedact).toBe(true);
      expect(DEFAULT_POSTURE.piiTypes).toEqual([]);
    });
  });

  describe('getPostureForTenant short-circuits', () => {
    it('returns DEFAULT_POSTURE for undefined tenantId without invoking the provider', async () => {
      const tcr = makeStubTcr();
      const { provider, providerCallCount } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const posture = await service.getPostureForTenant(undefined);

      expect(posture).toEqual(DEFAULT_POSTURE);
      expect(providerCallCount()).toBe(0);
      expect(tcr.getBooleanStrict).not.toHaveBeenCalled();
      expect(tcr.getString).not.toHaveBeenCalled();
    });

    it('returns DEFAULT_POSTURE for empty-string tenantId without invoking the provider', async () => {
      const tcr = makeStubTcr();
      const { provider, providerCallCount } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const posture = await service.getPostureForTenant('');

      expect(posture).toEqual(DEFAULT_POSTURE);
      expect(providerCallCount()).toBe(0);
    });

    it('returns DEFAULT_POSTURE for SYSTEM_IDENTITY.tenantId without invoking the provider', async () => {
      const tcr = makeStubTcr();
      const { provider, providerCallCount } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const posture = await service.getPostureForTenant(SYSTEM_IDENTITY.tenantId);

      expect(posture).toEqual(DEFAULT_POSTURE);
      expect(providerCallCount()).toBe(0);
    });
  });

  describe('getPostureForTenant resolves the four governance.* keys', () => {
    it('reads all four keys and shapes them into a posture', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockImplementation(async (_tid, key) => {
        if (key === 'governance.allow_pii') return true;
        if (key === 'governance.block_on_detection') return true;
        throw new Error(`unexpected boolean key ${key}`);
      });
      tcr.getString.mockImplementation(async (_tid, key) => {
        if (key === 'governance.auto_redact') return 'false';
        if (key === 'governance.pii_types_csv') return 'email, phone , ,credit_card';
        throw new Error(`unexpected string key ${key}`);
      });

      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const posture = await service.getPostureForTenant('tenant-a');

      expect(posture).toEqual<TenantGovernancePosture>({
        allowPII: true,
        blockOnDetection: true,
        autoRedact: false,
        piiTypes: ['email', 'phone', 'credit_card'],
      });
      // Every key is read exactly once.
      expect(tcr.getBooleanStrict).toHaveBeenCalledTimes(2);
      expect(tcr.getString).toHaveBeenCalledTimes(2);
    });

    it('PR-C3.1a R1 (Copilot R0) — pii_types_csv is lowercased at parse-time for case-insensitive consumer matching', async () => {
      // DLPService emits findings with lowercase `.type` ('ssn', 'email', etc.),
      // but tenants can write the CSV with mixed case ("SSN, Email"). Without
      // lowercase-at-parse, consumer filters would silently miss matches and
      // potentially leak PII into AI prompts / persisted logs.
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockImplementation(async (_tid, key) => {
        if (key === 'governance.auto_redact') return 'true';
        if (key === 'governance.pii_types_csv') return 'SSN, Email, PHONE_NUMBER';
        return null;
      });

      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const posture = await service.getPostureForTenant('tenant-case');

      // Lowercased; the comparison invariant downstream is `allowed.has(f.type)`
      // where DLP findings always have lowercase type values.
      expect(posture.piiTypes).toEqual(['ssn', 'email', 'phone_number']);
    });

    it('uses DEFAULT_POSTURE.autoRedact (true) when governance.auto_redact row is missing', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockResolvedValue(null);
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const posture = await service.getPostureForTenant('tenant-b');

      // Tri-state: null (missing) → DEFAULT (true), NOT collapsed to false
      // the way `getBoolean(...)` would.
      expect(posture.autoRedact).toBe(true);
      expect(posture.piiTypes).toEqual([]);
    });

    it('tolerates an unparseable auto_redact value by falling back to the default', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockImplementation(async (_tid, key) => {
        if (key === 'governance.auto_redact') return 'yes-please';
        return null;
      });
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const posture = await service.getPostureForTenant('tenant-c');

      // 'yes-please' is not 'true' or 'false' → DEFAULT (true), surfacing
      // operator typos in the safe direction rather than silently denying.
      expect(posture.autoRedact).toBe(true);
    });
  });

  describe('getPostureForTenant fails open to DEFAULT_POSTURE on errors', () => {
    it('falls back to DEFAULT_POSTURE when getBooleanStrict throws (e.g. encrypted-row violation)', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockImplementation(async (_tid, key) => {
        if (key === 'governance.allow_pii') {
          throw new Error('tenant_configurations.governance.allow_pii must be stored as plaintext');
        }
        return false;
      });
      tcr.getString.mockResolvedValue(null);
      const logger = makeLogger();
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(logger, new DLPService(makeLogger()), provider);

      const posture = await service.getPostureForTenant('tenant-d');

      expect(posture).toEqual(DEFAULT_POSTURE);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to resolve tenant governance posture'),
        expect.objectContaining({
          tenantId: 'tenant-d',
          error: expect.stringContaining('must be stored as plaintext'),
        }),
      );
    });

    it('does NOT cache the DEFAULT_POSTURE fallback (next call retries the provider)', async () => {
      const tcr = makeStubTcr();
      // Track per-key invocation count so the mock is deterministic
      // regardless of Promise.all evaluation order. First call to
      // `governance.allow_pii` throws; second call (the retry) returns
      // `true`. The other key returns `false` always.
      const callsByKey: Record<string, number> = {};
      tcr.getBooleanStrict.mockImplementation(async (_tid, key) => {
        callsByKey[key] = (callsByKey[key] ?? 0) + 1;
        if (key === 'governance.allow_pii' && callsByKey[key] === 1) {
          throw new Error('transient DB outage');
        }
        return key === 'governance.allow_pii';
      });
      tcr.getString.mockResolvedValue(null);
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const first = await service.getPostureForTenant('tenant-e');
      expect(first).toEqual(DEFAULT_POSTURE);

      const second = await service.getPostureForTenant('tenant-e');
      // Real values landed on retry — a cached failure would have pinned
      // DEFAULT_POSTURE for the full TTL.
      expect(second.allowPII).toBe(true);
    });
  });

  describe('cached entries are deeply frozen (no accidental cache poisoning)', () => {
    it('freezes the resolved posture and its piiTypes array', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(true);
      tcr.getString.mockImplementation(async (_tid, key) =>
        key === 'governance.pii_types_csv' ? 'email,phone' : null,
      );
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const posture = await service.getPostureForTenant('tenant-frozen');

      expect(Object.isFrozen(posture)).toBe(true);
      expect(Object.isFrozen(posture.piiTypes)).toBe(true);
      // Attempts to mutate the cached piiTypes throw in strict mode (which
      // ts-jest runs under) instead of silently corrupting subsequent calls.
      expect(() => (posture.piiTypes as string[]).push('credit_card')).toThrow();
    });
  });

  describe('concurrent posture-resolution dedup', () => {
    it('coalesces N simultaneous cache-miss calls into a single repository read', async () => {
      const tcr = makeStubTcr();
      // Slow getBooleanStrict so all 5 concurrent calls hit the same
      // in-flight Promise rather than serializing.
      tcr.getBooleanStrict.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(false), 20)),
      );
      tcr.getString.mockResolvedValue(null);
      const { provider, providerCallCount } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const results = await Promise.all([
        service.getPostureForTenant('tenant-concurrent'),
        service.getPostureForTenant('tenant-concurrent'),
        service.getPostureForTenant('tenant-concurrent'),
        service.getPostureForTenant('tenant-concurrent'),
        service.getPostureForTenant('tenant-concurrent'),
      ]);

      // All five return the same posture instance — shared via the
      // in-flight Promise.
      for (const r of results) {
        expect(r).toBe(results[0]);
      }
      // ONE provider call total; 2 getBooleanStrict + 2 getString reads
      // (NOT 10 + 10 the way naive cache-miss would have produced).
      expect(providerCallCount()).toBe(1);
      expect(tcr.getBooleanStrict).toHaveBeenCalledTimes(2);
      expect(tcr.getString).toHaveBeenCalledTimes(2);
    });

    it('clears the in-flight slot on success so a subsequent cache miss can re-resolve', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockResolvedValue(null);
      const { provider, providerCallCount } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      // First call populates the cache and clears the in-flight slot.
      await service.getPostureForTenant('tenant-A');
      expect(providerCallCount()).toBe(1);

      // Second call hits the cache (within TTL) — provider NOT called again.
      await service.getPostureForTenant('tenant-A');
      expect(providerCallCount()).toBe(1);
    });

    it('clears the in-flight slot on failure so the next call retries', async () => {
      const tcr = makeStubTcr();
      // First resolution attempt throws; second resolves cleanly.
      const callsByKey: Record<string, number> = {};
      tcr.getBooleanStrict.mockImplementation(async (_tid, key) => {
        callsByKey[key] = (callsByKey[key] ?? 0) + 1;
        if (key === 'governance.allow_pii' && callsByKey[key] === 1) {
          throw new Error('transient outage');
        }
        return key === 'governance.allow_pii';
      });
      tcr.getString.mockResolvedValue(null);
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const first = await service.getPostureForTenant('tenant-retry');
      expect(first).toEqual(DEFAULT_POSTURE);

      // Second call retries — in-flight slot was cleared in `finally`.
      const second = await service.getPostureForTenant('tenant-retry');
      expect(second.allowPII).toBe(true);
    });
  });

  describe('60s TTL cache', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns the cached posture within the TTL window without re-reading', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(true);
      tcr.getString.mockResolvedValue('phone');
      const { provider, providerCallCount } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const first = await service.getPostureForTenant('tenant-f');
      const second = await service.getPostureForTenant('tenant-f');

      expect(first).toBe(second);
      // Provider invoked once; the second call hit the cache.
      expect(providerCallCount()).toBe(1);
      expect(tcr.getBooleanStrict).toHaveBeenCalledTimes(2); // 2 keys × 1 read
      expect(tcr.getString).toHaveBeenCalledTimes(2);
    });

    it('re-reads after the TTL window expires', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockResolvedValue(null);
      const { provider, providerCallCount } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      await service.getPostureForTenant('tenant-g');
      // Advance past TTL.
      jest.advanceTimersByTime(GOVERNANCE_POSTURE_CACHE_TTL_MS + 1);
      await service.getPostureForTenant('tenant-g');

      expect(providerCallCount()).toBe(2);
      expect(tcr.getBooleanStrict).toHaveBeenCalledTimes(4); // 2 keys × 2 reads
    });

    it('FIFO-evicts the oldest tenant when inserting past the bound (Copilot R8)', async () => {
      // The eager-delete in R0 only fires when the SAME tenant is revisited.
      // R8 added FIFO eviction so a long-lived process touching many
      // distinct one-shot tenants doesn't let the Map grow unbounded.
      //
      // Test strategy (Copilot R11 perf fix): pre-populate `postureCache`
      // directly with 10k synthetic non-expired entries (preserving JS
      // Map insertion order) rather than invoking `getPostureForTenant`
      // 10k times. A single real getPostureForTenant() call then
      // exercises the FIFO-eviction branch in `resolvePostureFromRepository`.
      // Avoids ~10k async iterations + 40k repository-read mock calls per
      // test run.
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockResolvedValue(null);
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);
      const cachedMap = (service as unknown as {
        postureCache: Map<string, { posture: TenantGovernancePosture; expiresAt: number }>;
      }).postureCache;

      // Synthesize entries directly. `expiresAt` is set to a future
      // timestamp so the cache-miss eager-delete doesn't preempt the
      // FIFO eviction path we're testing.
      const farFuture = Date.now() + GOVERNANCE_POSTURE_CACHE_TTL_MS;
      for (let i = 0; i < GOVERNANCE_POSTURE_CACHE_MAX_ENTRIES; i++) {
        cachedMap.set(`tenant-${i}`, { posture: DEFAULT_POSTURE, expiresAt: farFuture });
      }
      expect(cachedMap.size).toBe(GOVERNANCE_POSTURE_CACHE_MAX_ENTRIES);

      // ONE real call past the bound must FIFO-evict the oldest entry
      // (tenant-0) while inserting tenant-newest.
      await service.getPostureForTenant('tenant-newest');
      expect(cachedMap.size).toBe(GOVERNANCE_POSTURE_CACHE_MAX_ENTRIES);
      expect(cachedMap.has('tenant-0')).toBe(false);
      expect(cachedMap.has('tenant-newest')).toBe(true);
      // Mid-range entry still present (only the oldest got dropped).
      expect(cachedMap.has(`tenant-${Math.floor(GOVERNANCE_POSTURE_CACHE_MAX_ENTRIES / 2)}`)).toBe(true);
    });

    it('caches separately per tenant', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockImplementation(async (tid, _key) => tid === 'tenant-allow');
      tcr.getString.mockResolvedValue(null);
      const { provider, providerCallCount } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const a = await service.getPostureForTenant('tenant-allow');
      const b = await service.getPostureForTenant('tenant-deny');

      expect(a.allowPII).toBe(true);
      expect(b.allowPII).toBe(false);
      // Distinct tenants each cost one provider call.
      expect(providerCallCount()).toBe(2);
    });
  });

  describe('detectPII preserves the commit-2 invariant regardless of posture', () => {
    // The DLPService policy MUST get `autoRedact: true` unconditionally.
    // Object-mode redaction relies on the value-based `redactedData` path
    // being populated; forwarding `posture.autoRedact: false` to DLPService
    // would silently break object-mode safety by leaving callers on the
    // legacy index-based path with placeholder offsets. C3 consumes the
    // tenant `autoRedact` flag at the validateInput()/validateOutput()
    // decision layer instead — see those tests below.
    it('always passes autoRedact:true to DLPService, even with a tenantId in flight', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      // Tenant explicitly opts out of auto-redaction — but this MUST NOT
      // reach DLPService.
      tcr.getString.mockImplementation(async (_tid, key) =>
        key === 'governance.auto_redact' ? 'false' : null,
      );
      const { provider } = makeProvider(tcr);

      const dlpService = new DLPService(makeLogger());
      const scanTextSpy = jest.spyOn(dlpService, 'scanText');
      const service = new GovernanceService(makeLogger(), dlpService, provider);

      // detectPII() does NOT accept a tenantId — posture is consumed in the
      // validateInput()/validateOutput() decision layer rather than at the
      // scan layer. Calling without a tenantId is the only legal shape.
      await service.detectPII('email me at alice@example.com');

      expect(scanTextSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          allowPII: false,
          piiTypes: [],
          autoRedact: true,
          blockOnDetection: false,
        }),
      );
    });
  });

  describe('validateInput consumes posture at the decision layer', () => {
    type Posture = TenantGovernancePosture;

    function makeServiceWithPosture(posture: Posture) {
      // The simplest way to pin posture into validateInput is to stub the
      // TCR provider — `getPostureForTenant('any-tenant')` then returns the
      // shaped posture deterministically.
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockImplementation(async (_tid, key) => {
        if (key === 'governance.allow_pii') return posture.allowPII;
        if (key === 'governance.block_on_detection') return posture.blockOnDetection;
        throw new Error(`unexpected bool key ${key}`);
      });
      tcr.getString.mockImplementation(async (_tid, key) => {
        if (key === 'governance.auto_redact') return posture.autoRedact ? 'true' : 'false';
        if (key === 'governance.pii_types_csv') return posture.piiTypes.join(',');
        return null;
      });
      const { provider } = makeProvider(tcr);
      const dlpService = new DLPService(makeLogger());
      const service = new GovernanceService(makeLogger(), dlpService, provider);
      return { service, dlpService };
    }

    const baseContext = {
      sessionId: 'sess',
      userId: 'user',
      tenantId: 'tenant-x',
      sourceSystem: 'test',
      targetSystem: 'test',
      timestamp: new Date('2026-05-21T14:00:00Z'),
    };

    it('flags pii_allowed_by_tenant and does NOT redact when posture.allowPII=true', async () => {
      const { service } = makeServiceWithPosture({
        allowPII: true,
        blockOnDetection: false,
        autoRedact: true,
        piiTypes: [],
      });

      const result = await service.validateInput(
        'contact alice@example.com',
        baseContext,
      );

      expect(result.approved).toBe(true);
      expect(result.flags).toContain('pii_detected');
      expect(result.flags).toContain('pii_allowed_by_tenant');
      // No redaction even though detection fired — tenant opted in.
      expect(result.flags).not.toContain('pii_auto_redacted');
      expect(result.redactedData).toBeUndefined();
    });

    it('redacts when posture.autoRedact=true (default) and config.autoRedactPII=true (default)', async () => {
      const { service } = makeServiceWithPosture({
        allowPII: false,
        blockOnDetection: false,
        autoRedact: true,
        piiTypes: [],
      });

      const result = await service.validateInput(
        'contact alice@example.com',
        baseContext,
      );

      expect(result.approved).toBe(true);
      expect(result.flags).toContain('pii_detected');
      expect(result.flags).toContain('pii_auto_redacted');
      expect(result.redactedData).toBeDefined();
    });

    it('does NOT redact when posture.autoRedact=false (per-tenant fine-grained override)', async () => {
      const { service } = makeServiceWithPosture({
        allowPII: false,
        blockOnDetection: false,
        autoRedact: false,
        piiTypes: [],
      });

      const result = await service.validateInput(
        'contact alice@example.com',
        baseContext,
      );

      // No redaction (tenant override) and no rejection (no block flag).
      expect(result.approved).toBe(true);
      expect(result.flags).toContain('pii_detected');
      expect(result.flags).not.toContain('pii_auto_redacted');
      expect(result.redactedData).toBeUndefined();
    });

    it('rejects when posture.blockOnDetection=true and posture.autoRedact=false', async () => {
      const { service } = makeServiceWithPosture({
        allowPII: false,
        blockOnDetection: true,
        autoRedact: false,
        piiTypes: [],
      });

      const result = await service.validateInput(
        'contact alice@example.com',
        baseContext,
      );

      expect(result.approved).toBe(false);
      expect(result.reason).toMatch(/PII detected in input data/);
      expect(result.riskLevel).toBe('high');
    });

    it('allowPII takes precedence over blockOnDetection (audit-only mode for opted-in tenants)', async () => {
      const { service } = makeServiceWithPosture({
        allowPII: true,
        blockOnDetection: true,
        autoRedact: true,
        piiTypes: [],
      });

      const result = await service.validateInput(
        'contact alice@example.com',
        baseContext,
      );

      // allowPII wins — request is approved despite blockOnDetection=true.
      expect(result.approved).toBe(true);
      expect(result.flags).toContain('pii_allowed_by_tenant');
    });

    it('falls back to DEFAULT_POSTURE (regression-equivalent) for SYSTEM_IDENTITY caller', async () => {
      const tcr = makeStubTcr();
      const { provider, providerCallCount } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const result = await service.validateInput('contact alice@example.com', {
        ...baseContext,
        tenantId: SYSTEM_IDENTITY.tenantId,
      });

      // No DB read for SYSTEM_IDENTITY; DEFAULT_POSTURE (autoRedact=true)
      // means default redaction path fires.
      expect(providerCallCount()).toBe(0);
      expect(result.approved).toBe(true);
      expect(result.flags).toContain('pii_detected');
      expect(result.flags).toContain('pii_auto_redacted');
    });

    it('applies piiTypes filter to restrict enforcement to allowlisted types (validateInput)', async () => {
      // Configure posture to redact ONLY 'email'. Input contains 'email' and 'phone'.
      // Only the email should be redacted, the phone number should remain.
      const { service } = makeServiceWithPosture({
        allowPII: false,
        blockOnDetection: false,
        autoRedact: true,
        piiTypes: ['email'],
      });

      const result = await service.validateInput(
        'contact email: alice@example.com, phone: 555-0199',
        baseContext,
      );

      expect(result.approved).toBe(true);
      expect(result.flags).toContain('pii_detected');
      expect(result.flags).toContain('pii_auto_redacted');
      expect(result.redactedData).toBeDefined();

      const redactedStr = String(result.redactedData);
      // Email is redacted
      expect(redactedStr).not.toContain('alice@example.com');
      // Phone is NOT redacted since phone was filtered out from enforcement
      expect(redactedStr).toContain('555-0199');
    });

    it('filters out all PII and flags pii_detected_but_filtered_by_posture when no detected types match allowlist (validateInput)', async () => {
      // Configure posture to enforce ONLY 'ssn'. Input contains only 'email'.
      // Since email is not 'ssn', it is filtered out.
      const { service } = makeServiceWithPosture({
        allowPII: false,
        blockOnDetection: true,
        autoRedact: true,
        piiTypes: ['ssn'],
      });

      const result = await service.validateInput(
        'contact alice@example.com',
        baseContext,
      );

      // Should be approved despite blockOnDetection=true, because email is filtered out.
      expect(result.approved).toBe(true);
      expect(result.flags).toContain('pii_detected_but_filtered_by_posture');
      expect(result.flags).not.toContain('pii_detected');
      expect(result.flags).not.toContain('pii_auto_redacted');
      expect(result.redactedData).toBeUndefined();
    });
  });

  describe('validateOutput consumes posture at the decision layer', () => {
    function makeService(allowPII: boolean, blockOnDetection: boolean) {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockImplementation(async (_tid, key) => {
        if (key === 'governance.allow_pii') return allowPII;
        if (key === 'governance.block_on_detection') return blockOnDetection;
        throw new Error(`unexpected bool key ${key}`);
      });
      tcr.getString.mockResolvedValue(null);
      const { provider } = makeProvider(tcr);
      const dlpService = new DLPService(makeLogger());
      return new GovernanceService(makeLogger(), dlpService, provider);
    }

    const baseContext = {
      sessionId: 'sess',
      tenantId: 'tenant-y',
      timestamp: new Date('2026-05-21T14:00:00Z'),
    };

    it('flags PII in output and approves when no block signal is set (default posture, autoRedact=true)', async () => {
      // DEFAULT_POSTURE has autoRedact=true → redacted form populated.
      const service = makeService(false, false);

      const result = await service.validateOutput(
        'agent returned alice@example.com',
        baseContext,
      );

      expect(result.approved).toBe(true);
      expect(result.flags).toContain('output_pii_detected');
      expect(result.flags).toContain('output_pii_auto_redacted');
      expect(result.redactedData).toBeDefined();
      // The sanitized form replaces the email value with the DLP redaction
      // marker; the original alice@example.com substring is gone.
      expect(String(result.redactedData)).not.toContain('alice@example.com');
    });

    it('rejects output when posture.blockOnDetection=true (no redaction on reject path)', async () => {
      const service = makeService(false, true);

      const result = await service.validateOutput(
        'agent returned alice@example.com',
        baseContext,
      );

      expect(result.approved).toBe(false);
      expect(result.reason).toMatch(/PII found in agent output/);
      // Rejection is mutually exclusive with redaction — callers route to
      // error handling and never read redactedData.
      expect(result.redactedData).toBeUndefined();
    });

    it('approves output when posture.allowPII=true even with blockOnDetection=true (audit-only mode)', async () => {
      const service = makeService(true, true);

      const result = await service.validateOutput(
        'agent returned alice@example.com',
        baseContext,
      );

      expect(result.approved).toBe(true);
      expect(result.flags).toContain('output_pii_detected');
      expect(result.flags).toContain('output_pii_allowed_by_tenant');
      // Audit-only mode does NOT redact — tenant opted in, raw output flows
      // back unchanged.
      expect(result.redactedData).toBeUndefined();
    });

    it('applies piiTypes filter to restrict enforcement to allowlisted types (validateOutput)', async () => {
      function makeServiceWithPosture(posture: TenantGovernancePosture) {
        const tcr = makeStubTcr();
        tcr.getBooleanStrict.mockImplementation(async (_tid, key) => {
          if (key === 'governance.allow_pii') return posture.allowPII;
          if (key === 'governance.block_on_detection') return posture.blockOnDetection;
          throw new Error(`unexpected bool key ${key}`);
        });
        tcr.getString.mockImplementation(async (_tid, key) => {
          if (key === 'governance.auto_redact') return posture.autoRedact ? 'true' : 'false';
          if (key === 'governance.pii_types_csv') return posture.piiTypes.join(',');
          return null;
        });
        const { provider } = makeProvider(tcr);
        const dlpService = new DLPService(makeLogger());
        return new GovernanceService(makeLogger(), dlpService, provider);
      }

      const service = makeServiceWithPosture({
        allowPII: false,
        blockOnDetection: false,
        autoRedact: true,
        piiTypes: ['email'],
      });

      const result = await service.validateOutput(
        'agent returned email: alice@example.com, phone: 555-0199',
        baseContext,
      );

      expect(result.approved).toBe(true);
      expect(result.flags).toContain('output_pii_detected');
      expect(result.flags).toContain('output_pii_auto_redacted');
      expect(result.redactedData).toBeDefined();

      const redactedStr = String(result.redactedData);
      expect(redactedStr).not.toContain('alice@example.com');
      expect(redactedStr).toContain('555-0199');
    });

    it('filters out all PII and flags output_pii_detected_but_filtered_by_posture when no detected types match allowlist (validateOutput)', async () => {
      function makeServiceWithPosture(posture: TenantGovernancePosture) {
        const tcr = makeStubTcr();
        tcr.getBooleanStrict.mockImplementation(async (_tid, key) => {
          if (key === 'governance.allow_pii') return posture.allowPII;
          if (key === 'governance.block_on_detection') return posture.blockOnDetection;
          throw new Error(`unexpected bool key ${key}`);
        });
        tcr.getString.mockImplementation(async (_tid, key) => {
          if (key === 'governance.auto_redact') return posture.autoRedact ? 'true' : 'false';
          if (key === 'governance.pii_types_csv') return posture.piiTypes.join(',');
          return null;
        });
        const { provider } = makeProvider(tcr);
        const dlpService = new DLPService(makeLogger());
        return new GovernanceService(makeLogger(), dlpService, provider);
      }

      const service = makeServiceWithPosture({
        allowPII: false,
        blockOnDetection: true,
        autoRedact: true,
        piiTypes: ['ssn'],
      });

      const result = await service.validateOutput(
        'agent returned email: alice@example.com',
        baseContext,
      );

      // Should be approved despite blockOnDetection=true because email is filtered out.
      expect(result.approved).toBe(true);
      expect(result.flags).toContain('output_pii_detected_but_filtered_by_posture');
      expect(result.flags).not.toContain('output_pii_detected');
      expect(result.flags).not.toContain('output_pii_auto_redacted');
      expect(result.redactedData).toBeUndefined();
    });
  });

  describe('output redaction symmetry — Codex R1', () => {
    // Pins the gap that Codex flagged on `55dedfca`: pre-fix, validateOutput
    // populated `output_pii_detected` and conditionally rejected, but never
    // assigned `redactedData`. Callers that read `outputCheck.redactedData`
    // would always see `undefined`, so tenants with `autoRedact:true` saw
    // input PII sanitized while raw output PII leaked through.
    it('populates redactedData on the approval path so callers can hand back the sanitized form', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false); // allow=false, block=false
      // governance.auto_redact='true' → posture.autoRedact stays true
      tcr.getString.mockImplementation(async (_tid, key) =>
        key === 'governance.auto_redact' ? 'true' : null,
      );
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const result = await service.validateOutput(
        { suggestion: 'Send report to alice@example.com' },
        {
          sessionId: 'sess',
          tenantId: 'tenant-output-redact',
          timestamp: new Date('2026-05-21T14:00:00Z'),
        },
      );

      expect(result.approved).toBe(true);
      expect(result.flags).toContain('output_pii_auto_redacted');
      expect(result.redactedData).toBeDefined();
      const redactedJson = JSON.stringify(result.redactedData);
      // Sanitized output no longer contains the email.
      expect(redactedJson).not.toContain('alice@example.com');
    });

    it('does NOT populate redactedData when tenant explicitly disables autoRedact (autoRedact=false)', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockImplementation(async (_tid, key) =>
        key === 'governance.auto_redact' ? 'false' : null,
      );
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      const result = await service.validateOutput(
        'agent returned alice@example.com',
        {
          sessionId: 'sess',
          tenantId: 'tenant-no-redact',
          timestamp: new Date('2026-05-21T14:00:00Z'),
        },
      );

      // Detected but tenant explicitly opted out — flag only, no redaction.
      expect(result.approved).toBe(true);
      expect(result.flags).toContain('output_pii_detected');
      expect(result.flags).not.toContain('output_pii_auto_redacted');
      expect(result.redactedData).toBeUndefined();
    });
  });

  describe('governanceFindings fallback coverage', () => {
    it('covers governanceFindings undefined fallback in validateInput', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockResolvedValue(null);
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      jest.spyOn(service, 'detectPII').mockResolvedValue({
        hasPII: true,
        piiTypes: [{
          type: 'email' as any,
          value: 'alice@example.com',
          confidence: 0.9,
          startIndex: 0,
          endIndex: 17,
          replacement: '[REDACTED]',
        }],
        confidence: 0.9,
        originalText: 'alice@example.com',
        redactedText: '[REDACTED]',
        redactedData: '[REDACTED]',
        governanceFindings: undefined, // trigger fallback
      });

      const result = await service.validateInput('alice@example.com', {
        sessionId: 'sess',
        tenantId: 'tenant-fallback',
        timestamp: new Date('2026-05-21T14:00:00Z'),
      });

      expect(result.approved).toBe(true);
      expect(result.flags).toContain('pii_detected');
      expect(result.flags).toContain('pii_auto_redacted');
      expect(result.redactedData).toBe('[REDACTED]');
    });

    it('covers governanceFindings undefined fallback in validateOutput', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockResolvedValue(null);
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      jest.spyOn(service, 'detectPII').mockResolvedValue({
        hasPII: true,
        piiTypes: [{
          type: 'email' as any,
          value: 'alice@example.com',
          confidence: 0.9,
          startIndex: 0,
          endIndex: 17,
          replacement: '[REDACTED]',
        }],
        confidence: 0.9,
        originalText: 'alice@example.com',
        redactedText: '[REDACTED]',
        redactedData: '[REDACTED]',
        governanceFindings: undefined, // trigger fallback
      });

      const result = await service.validateOutput('alice@example.com', {
        sessionId: 'sess',
        tenantId: 'tenant-fallback',
        timestamp: new Date('2026-05-21T14:00:00Z'),
      });

      expect(result.approved).toBe(true);
      expect(result.flags).toContain('output_pii_detected');
      expect(result.flags).toContain('output_pii_auto_redacted');
      expect(result.redactedData).toBe('[REDACTED]');
    });
  });

  describe('primitive (non-structured) input redaction (Copilot R2)', () => {
    // Copilot R2: dlpService.redactData(data, findings) returns primitives
    // (number/boolean) unchanged. For non-structured inputs, must fall back
    // to the adapter-produced redactedData/redactedText so the redacted-flag
    // and the surfaced value stay consistent.
    it('redacts numeric input via piiResult.redactedText, not raw dlpService.redactData passthrough', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockResolvedValue(null);
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      // Numeric primitive that "looks like" an SSN once string-coerced.
      // detectPII coerces via String(data) → scanText finds it; redactData(primitive, ...)
      // would return the primitive unchanged, leaking it while still flagging
      // pii_auto_redacted.
      jest.spyOn(service, 'detectPII').mockResolvedValue({
        hasPII: true,
        piiTypes: [{
          type: 'ssn' as any,
          value: '123456789',
          confidence: 0.95,
          startIndex: 0,
          endIndex: 9,
          replacement: '[REDACTED]',
        }],
        confidence: 0.95,
        originalText: '123456789',
        redactedText: '[REDACTED]',
        // governanceFindings populated AND useRawFindings true, but data is
        // primitive — fix should fall through to redactedText.
        governanceFindings: [{
          type: 'ssn',
          field: 'value',
          value: '123456789',
          confidence: 0.95,
          location: { path: 'value' },
          severity: 'critical',
          redactedValue: '[REDACTED]',
        }],
      });

      const result = await service.validateInput(123456789 as unknown as Record<string, unknown>, {
        sessionId: 'sess',
        tenantId: 'tenant-prim',
        timestamp: new Date('2026-05-21T14:00:00Z'),
      });

      expect(result.approved).toBe(true);
      expect(result.flags).toContain('pii_detected');
      expect(result.flags).toContain('pii_auto_redacted');
      // CRITICAL: redactedData must be the safe redacted string, NOT the raw 123456789 primitive.
      expect(result.redactedData).toBe('[REDACTED]');
      expect(result.redactedData).not.toBe(123456789);
    });

    it('redacts boolean input via piiResult.redactedText fallback', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockResolvedValue(null);
      const { provider } = makeProvider(tcr);
      const service = new GovernanceService(makeLogger(), new DLPService(makeLogger()), provider);

      jest.spyOn(service, 'detectPII').mockResolvedValue({
        hasPII: true,
        piiTypes: [{
          type: 'email' as any,
          value: 'true',
          confidence: 0.5,
          startIndex: 0,
          endIndex: 4,
          replacement: '[REDACTED]',
        }],
        confidence: 0.5,
        originalText: 'true',
        redactedText: '[REDACTED]',
        governanceFindings: [{
          type: 'email',
          field: 'value',
          value: 'true',
          confidence: 0.5,
          location: { path: 'value' },
          severity: 'medium',
          redactedValue: '[REDACTED]',
        }],
      });

      const result = await service.validateInput(true as unknown as Record<string, unknown>, {
        sessionId: 'sess',
        tenantId: 'tenant-prim',
        timestamp: new Date('2026-05-21T14:00:00Z'),
      });

      expect(result.approved).toBe(true);
      expect(result.flags).toContain('pii_auto_redacted');
      expect(result.redactedData).toBe('[REDACTED]');
      expect(result.redactedData).not.toBe(true);
    });
  });

  describe('redactData undefined fail-closed (applyPosturePIIDecision defense-in-depth)', () => {
    // Defense-in-depth: dlpService.redactData is a pure function but we still
    // fail-closed if it returns undefined for any reason on the structured
    // path. Without this branch, a future redactor regression could silently
    // surface raw PII while flagging the result as auto-redacted.
    it('fails closed when useRawFindings=true and dlpService.redactData returns undefined', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockResolvedValue(null);
      const { provider } = makeProvider(tcr);

      const dlp = new DLPService(makeLogger());
      // Spy redactData to return undefined regardless of input
      jest.spyOn(dlp, 'redactData').mockReturnValue(undefined as unknown as Record<string, unknown>);
      const service = new GovernanceService(makeLogger(), dlp, provider);

      jest.spyOn(service, 'detectPII').mockResolvedValue({
        hasPII: true,
        piiTypes: [{
          type: 'email' as any,
          value: 'test@example.com',
          confidence: 0.9,
          startIndex: 0,
          endIndex: 16,
          replacement: '[REDACTED]',
        }],
        confidence: 0.9,
        originalText: '{"email":"test@example.com"}',
        redactedText: '[REDACTED]',
        redactedData: { email: '[REDACTED]' },
        // governanceFindings POPULATED → useRawFindings=true → calls dlpService.redactData
        governanceFindings: [{
          type: 'email',
          field: 'email',
          value: 'test@example.com',
          confidence: 0.9,
          location: { path: 'email' },
          severity: 'medium',
          redactedValue: '[REDACTED]',
        }],
      });

      const result = await service.validateInput(
        { email: 'test@example.com' } as Record<string, unknown>,
        {
          sessionId: 'sess',
          tenantId: 'tenant-fail-closed',
          timestamp: new Date('2026-05-21T14:00:00Z'),
        },
      );

      // redactData returned undefined → fail-closed: reject with reason, no
      // redactedData set, NOT a leak of raw payload via flag-and-pass.
      expect(result.approved).toBe(false);
      expect(result.reason).toBe('PII detected in input data');
      expect(result.redactedData).toBeUndefined();
      expect(result.flags).toContain('pii_detected');
      // Critically: NO 'pii_auto_redacted' flag because we didn't actually redact
      expect(result.flags).not.toContain('pii_auto_redacted');
    });

    it('fails closed on validateOutput when redactData returns undefined', async () => {
      const tcr = makeStubTcr();
      tcr.getBooleanStrict.mockResolvedValue(false);
      tcr.getString.mockResolvedValue(null);
      const { provider } = makeProvider(tcr);

      const dlp = new DLPService(makeLogger());
      jest.spyOn(dlp, 'redactData').mockReturnValue(undefined as unknown as Record<string, unknown>);
      const service = new GovernanceService(makeLogger(), dlp, provider);

      jest.spyOn(service, 'detectPII').mockResolvedValue({
        hasPII: true,
        piiTypes: [{
          type: 'email' as any,
          value: 'test@example.com',
          confidence: 0.9,
          startIndex: 0,
          endIndex: 16,
          replacement: '[REDACTED]',
        }],
        confidence: 0.9,
        originalText: '{"email":"test@example.com"}',
        redactedText: '[REDACTED]',
        redactedData: { email: '[REDACTED]' },
        governanceFindings: [{
          type: 'email',
          field: 'email',
          value: 'test@example.com',
          confidence: 0.9,
          location: { path: 'email' },
          severity: 'medium',
          redactedValue: '[REDACTED]',
        }],
      });

      const result = await service.validateOutput(
        { email: 'test@example.com' } as Record<string, unknown>,
        {
          sessionId: 'sess',
          tenantId: 'tenant-fail-closed',
          timestamp: new Date('2026-05-21T14:00:00Z'),
        },
      );

      // Symmetric output-side fail-closed
      expect(result.approved).toBe(false);
      expect(result.reason).toBe('PII found in agent output');
      expect(result.redactedData).toBeUndefined();
      expect(result.flags).toContain('output_pii_detected');
      expect(result.flags).not.toContain('output_pii_auto_redacted');
    });
  });
});
