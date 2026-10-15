/**
 * NetSuite CRUD live integration test (V3).
 *
 * Exercises 8 jest cases + an afterAll tag-based cleanup sweep against the
 * sandbox identified in `docs/review/proof-cards/netsuite-connector.md`
 * (TSTDRV2698307):
 *   1. testConnection — first signed live HTTP request (BaseConnector.testConnection
 *      internally exercises authenticate() + getSystemInfo() so the returned
 *      status doubles as proof that both work)
 *   2. list customers
 *   3. create tagged test customer
 *   4. read created customer
 *   5. update created customer
 *   6. search by tag prefix (asserts the created record is in results)
 *   7. delete created customer
 *   8. read-after-delete returns null
 *   afterAll: tag-prefix sweep best-effort deletes any stragglers
 *
 * Cases 1-8 each issue at least one signed live HTTP request, so a green
 * run is end-to-end evidence that the OAuth1 helper produces signatures
 * NetSuite's SuiteTalk REST endpoint accepts.
 *
 * Skip-guard: requires NETSUITE_LIVE_TESTS=1 AND all 5 NETSUITE_* creds.
 * Suite-wide `connector.maxRetries = 1` (single attempt, no retries) to
 * avoid duplicate creates from retried 5xx after server-side success on
 * non-idempotent writes (create/update/delete). BaseConnector.retry treats
 * `maxRetries=0` as "0 attempts" (an unrecoverable broken state — Copilot
 * R4 caught this), so 1 is the floor: one attempt, no retry. Reads
 * (list/read/search) also forgo retries — acceptable trade since sandbox
 * 5xx is rare; if a read test flakes on a transient blip, re-run the workflow.
 *
 * This is the credential-tested integration that backs the production
 * Status claim on the netsuite-connector and oauth1-helper proof cards.
 */
import './setupEnv';
import { NetSuiteConnector } from '../../src/connectors/NetSuiteConnector';
import type { AuthService } from '../../src/services/AuthService';
import type { Logger } from '../../src/utils/Logger';
import type { DataRecord } from '../../src/types';
import { createMockOutboundGovernanceService } from '../governanceTestUtils';

const requiredEnvVars = [
  'NETSUITE_ACCOUNT_ID',
  'NETSUITE_CONSUMER_KEY',
  'NETSUITE_CONSUMER_SECRET',
  'NETSUITE_TOKEN_ID',
  'NETSUITE_TOKEN_SECRET',
] as const;

const missingEnvVars = requiredEnvVars.filter((name) => {
  const value = process.env[name];
  return !value || value.length === 0;
});

if (process.env.NETSUITE_LIVE_TESTS === '1' && missingEnvVars.length > 0) {
  console.warn(
    `Skipping NetSuite live CRUD tests. Missing environment variables: ${missingEnvVars.join(', ')}`,
  );
}

const shouldRunLive =
  process.env.NETSUITE_LIVE_TESTS === '1' && missingEnvVars.length === 0;
const describeLive = shouldRunLive ? describe : describe.skip;

// Tag every record this suite creates so the cleanup sweep can find them
// even if a per-test delete path didn't run (e.g. suite crashed mid-run).
// Includes pid + epoch so re-runs don't collide.
const TEST_TAG_PREFIX = `v3-crud-${process.pid}-${Date.now()}`;

// Bounded retry for the search case. NetSuite's search index can lag a
// recent create by a few seconds; without retry the search assertion is
// flaky even when create/read/update/delete are working. The loop delays
// AFTER each non-final attempt (the `i < attempts - 1` guard), so 5
// attempts produce 4 delays at 1s/2s/4s/8s = 15s total wait ceiling.
// (4 attempts would only give 3 delays = 1s/2s/4s = 7s, which doesn't
// match the ceiling Copilot R5 noted in the workflow doc.)
async function retryUntilTagged(
  fn: () => Promise<DataRecord[]>,
  needle: string,
  opts: { attempts?: number; baseMs?: number; maxMs?: number } = {},
): Promise<DataRecord[]> {
  const { attempts = 5, baseMs = 1_000, maxMs = 8_000 } = opts;
  let last: DataRecord[] = [];
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    const matched = last.some((r) => {
      const email = (r.fields as { email?: unknown } | undefined)?.email;
      return typeof email === 'string' && email.includes(needle);
    });
    if (matched) return last;
    if (i < attempts - 1) {
      const delay = Math.min(baseMs * 2 ** i, maxMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return last;
}

describeLive('NetSuiteConnector live CRUD (V3 credential test)', () => {
  jest.setTimeout(60_000);

  const accountId = process.env.NETSUITE_ACCOUNT_ID as string;
  const consumerKey = process.env.NETSUITE_CONSUMER_KEY as string;
  const consumerSecret = process.env.NETSUITE_CONSUMER_SECRET as string;
  const tokenId = process.env.NETSUITE_TOKEN_ID as string;
  const tokenSecret = process.env.NETSUITE_TOKEN_SECRET as string;
  // GitHub Actions surfaces an unset optional secret as an empty string, not
  // null/undefined — `??` would then pass '' through and produce malformed
  // URLs. Trim + truthy-fallback so both unset secrets and accidental
  // whitespace-only values collapse to the default. Per Copilot R4.
  const baseUrl =
    process.env.NETSUITE_BASE_URL?.trim() ||
    `https://${accountId}.suitetalk.api.netsuite.com`;

  const baseLogger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    child(): Logger {
      return this as unknown as Logger;
    },
  } as unknown as Logger;

  const authService = {
    authenticateOAuth1: async (cfg: { credentials: unknown }) => cfg.credentials,
  } as unknown as AuthService;

  // `connector` is set in beforeAll. If beforeAll throws (bad creds, NetSuite
  // outage, etc.), Jest skips the `it()` blocks, so per-test code never reads
  // it unset. The afterAll cleanup sweep is the only place that runs even
  // after a beforeAll failure — it carries an explicit null guard.
  // Tracked separately as a nullable so the guard can be meaningful;
  // `setupConnector()` returns the strict-typed instance for per-test reads.
  let connector: NetSuiteConnector | null = null;
  let createdId: string | null = null;
  const requireConnector = (): NetSuiteConnector => {
    if (!connector) throw new Error('connector unset — beforeAll did not complete');
    return connector;
  };

  beforeAll(async () => {
    // Construct + initialize into a local first; assign to the outer
    // `connector` only after init succeeds. That way an init failure leaves
    // `connector` null and afterAll's guard cleanly early-returns instead of
    // calling .delete()/.search() on a half-initialized instance and
    // masking the original beforeAll error.
    const local = new NetSuiteConnector(
      'live-netsuite-crud',
      baseLogger,
      authService,
      createMockOutboundGovernanceService(),
    );
    await local.initialize({
      type: 'oauth1',
      credentials: {
        accountId,
        consumerKey,
        consumerSecret,
        tokenId,
        tokenSecret,
        baseUrl,
      },
    });

    // Single attempt, no retries. The motivating concern is duplicate
    // creates from a retried 5xx after server-side success on non-idempotent
    // writes (create/update/delete); the trade-off is that reads also forgo
    // retries on transient blips. Sandbox 5xx is rare enough that this is
    // acceptable; re-run the workflow if a read test flakes.
    local.maxRetries = 1;

    connector = local;

    // No explicit authenticate() here: each connector method calls
    // ensureAuthenticated() lazily, AND BaseConnector.testConnection (case 1)
    // explicitly invokes authenticate() before getSystemInfo(). Doing it
    // here too would just duplicate the token-exchange round-trip — Copilot
    // R2 flagged the redundancy.
  });

  // Case 1 — testConnection internally calls authenticate() + getSystemInfo(),
  // so the returned `status` is already proof that both auth and the signed
  // getSystemInfo HTTP request worked. Asserting on `status.systemType` is
  // equivalent to dereferencing the system-info payload; calling
  // getSystemInfo() again here would double the live load for no extra
  // coverage (Copilot R1 noted this).
  it('1. passes testConnection and reports NetSuite as systemType', async () => {
    const status = await requireConnector().testConnection();
    expect(status.isConnected).toBe(true);
    expect(status.systemType).toBe('NetSuite');
  });

  // Case 2
  it('2. lists customer records (limit 5)', async () => {
    const customers = await requireConnector().list('customer', { limit: 5 });
    expect(Array.isArray(customers)).toBe(true);
  });

  // Case 3
  it('3. creates a tagged test customer', async () => {
    const newCustomer: DataRecord = {
      id: '',
      fields: {
        name: `${TEST_TAG_PREFIX} Customer`,
        email: `${TEST_TAG_PREFIX}@example.com`,
        phone: '555-1234',
      },
    };

    const created = await requireConnector().create('customer', newCustomer);
    expect(created.id).toBeTruthy();
    createdId = created.id ?? null;
  });

  // Case 4
  it('4. reads the created customer back by id', async () => {
    expect(createdId).toBeTruthy();
    const readBack = await requireConnector().read('customer', createdId as string);
    expect(readBack).not.toBeNull();
    expect(readBack?.id).toBe(createdId);
  });

  // Case 5
  it('5. updates the created customer', async () => {
    expect(createdId).toBeTruthy();
    const updated = await requireConnector().update('customer', createdId as string, {
      fields: {
        phone: '555-9999',
        email: `${TEST_TAG_PREFIX}-updated@example.com`,
      },
    });
    expect(updated.id).toBe(createdId);
  });

  // Case 6 — searches for the tagged customer with bounded retry (default
  // 5 attempts = 4 delays at 1s/2s/4s/8s, 15s ceiling). NetSuite's search
  // index can lag a recent create by a few seconds; the retry helper
  // tolerates that lag without making the test flaky. Stops
  // short of asserting createdId specifically since the indexer may surface
  // the record under a slightly different id form than create returned.
  it('6. searches and finds the tagged customer by email', async () => {
    const results = await retryUntilTagged(
      () =>
        requireConnector().search('customer', {
          filters: {
            email: { operator: 'contains', value: TEST_TAG_PREFIX },
          },
          limit: 10,
        }),
      TEST_TAG_PREFIX,
    );
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const tagged = results.filter((r) => {
      const email = (r.fields as { email?: unknown } | undefined)?.email;
      return typeof email === 'string' && email.includes(TEST_TAG_PREFIX);
    });
    expect(tagged.length).toBeGreaterThanOrEqual(1);
  });

  // Case 7
  it('7. deletes the test customer', async () => {
    expect(createdId).toBeTruthy();
    const ok = await requireConnector().delete('customer', createdId as string);
    expect(ok).toBe(true);
  });

  // Case 8
  it('8. read-after-delete returns null', async () => {
    expect(createdId).toBeTruthy();
    const verify = await requireConnector().read('customer', createdId as string);
    expect(verify).toBeNull();
    // Mark deleted so the cleanup sweep doesn't redundantly re-delete.
    createdId = null;
  });

  // afterAll cleanup sweep — best-effort; logs but does not fail.
  afterAll(async () => {
    // Jest runs afterAll even when beforeAll throws. If setup failed before
    // `connector` was published, there's nothing to clean up — early-return
    // so the cleanup path doesn't throw on null and mask the real failure.
    if (!connector) return;
    if (createdId) {
      try {
        await requireConnector().delete('customer', createdId);
      } catch (err) {
        console.warn(
          `Suite cleanup could not delete record ${createdId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    try {
      // Cleanup uses the same retry helper as case 6 but with a shorter
      // ceiling (2 attempts = 1 delay at 1.5s, ~1.5s total extra) —
      // best-effort, so we don't want to waste a lot of time waiting for
      // an index that may never show stragglers (i.e. cases all deleted
      // cleanly).
      const stragglers = await retryUntilTagged(
        () =>
          requireConnector().search('customer', {
            filters: {
              email: { operator: 'contains', value: TEST_TAG_PREFIX },
            },
            limit: 50,
          }),
        TEST_TAG_PREFIX,
        { attempts: 2, baseMs: 1_500 },
      );
      for (const record of stragglers) {
        if (!record.id) continue;
        try {
          await requireConnector().delete('customer', record.id);
        } catch (err) {
          console.warn(
            `Cleanup sweep could not delete ${record.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `Cleanup sweep search failed; manual cleanup may be needed for prefix ${TEST_TAG_PREFIX}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
});
