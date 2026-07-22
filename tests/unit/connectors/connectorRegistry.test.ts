import {
  CONNECTOR_REGISTRY,
  type ConnectorDeps,
  type ConnectorRegistration,
  getConnectorRegistration,
  listDIBoundConnectors,
  listFactoryWiredConnectors,
  listProductionConnectors,
  type ProductionStatus,
} from '../../../src/connectors/connectorRegistry';
import { Logger } from '../../../src/utils/Logger';
import { AuthService } from '../../../src/services/AuthService';
import type { OutboundGovernanceService } from '../../../src/services/governance/OutboundGovernanceService';

const VALID_STATUSES: ReadonlySet<ProductionStatus> = new Set([
  'production',
  'beta',
  'demo_only',
  'stub',
]);

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const PROOF_CARD_DIR = 'docs/review/proof-cards/';

describe('CONNECTOR_REGISTRY (PR 6A)', () => {
  it('contains 18 connectors (matches the AST-scanned partition in metrics.json)', () => {
    expect(CONNECTOR_REGISTRY).toHaveLength(18);
  });

  it('keys are unique', () => {
    const keys = CONNECTOR_REGISTRY.map((e) => e.key);
    const uniq = new Set(keys);
    expect(uniq.size).toBe(keys.length);
  });

  it('classNames are unique', () => {
    const names = CONNECTOR_REGISTRY.map((e) => e.className);
    const uniq = new Set(names);
    expect(uniq.size).toBe(names.length);
  });

  it('keys match the lowercase ASCII pattern', () => {
    for (const entry of CONNECTOR_REGISTRY) {
      expect(entry.key).toMatch(KEY_PATTERN);
    }
  });

  it('every productionStatus is one of the valid enum values', () => {
    for (const entry of CONNECTOR_REGISTRY) {
      expect(VALID_STATUSES.has(entry.productionStatus)).toBe(true);
    }
  });

  it('every entry declares a bulkRollbackStrategy', () => {
    const valid = new Set(['transactional', 'compensating', 'unsupported']);
    for (const entry of CONNECTOR_REGISTRY) {
      expect(valid.has(entry.bulkRollbackStrategy)).toBe(true);
    }
  });

  it('every production entry has a factory closure and a proofCardPath', () => {
    const productionEntries = CONNECTOR_REGISTRY.filter(
      (e) => e.productionStatus === 'production',
    );
    expect(productionEntries.length).toBeGreaterThan(0);
    for (const entry of productionEntries) {
      // PR 6A-2: factoryAvailable boolean replaced by `factory` closure presence.
      expect(typeof entry.factory).toBe('function');
      expect(entry.proofCardPath).toBeDefined();
      expect(entry.proofCardPath).toMatch(/^docs\/review\/proof-cards\/.+\.md$/);
    }
  });

  it('proofCardPath (when set) lives directly under docs/review/proof-cards/', () => {
    for (const entry of CONNECTOR_REGISTRY) {
      if (!entry.proofCardPath) continue;
      expect(entry.proofCardPath.startsWith(PROOF_CARD_DIR)).toBe(true);
      const remainder = entry.proofCardPath.slice(PROOF_CARD_DIR.length);
      expect(remainder).not.toContain('/');
      expect(remainder).toMatch(/\.md$/);
    }
  });

  it('classNames match the conventional <Name>Connector / <Name>ConnectorProd pattern', () => {
    for (const entry of CONNECTOR_REGISTRY) {
      expect(entry.className).toMatch(/^[A-Z][A-Za-z0-9]*(Connector|ConnectorProd)$/);
    }
  });

  it('credentialRequirements is always an array (possibly empty)', () => {
    for (const entry of CONNECTOR_REGISTRY) {
      expect(Array.isArray(entry.credentialRequirements)).toBe(true);
    }
  });

  it('the partition matches metrics.json: production=5 beta=1 demo_only=11 stub=1', () => {
    const partition: Record<ProductionStatus, number> = {
      production: 0,
      beta: 0,
      demo_only: 0,
      stub: 0,
    };
    for (const entry of CONNECTOR_REGISTRY) {
      partition[entry.productionStatus] += 1;
    }
    expect(partition).toEqual({ production: 5, beta: 1, demo_only: 11, stub: 1 });
  });
});

describe('connector registry helpers', () => {
  it('getConnectorRegistration returns the entry for a known key', () => {
    const ns = getConnectorRegistration('netsuite');
    expect(ns).toBeDefined();
    expect(ns?.className).toBe('NetSuiteConnector');
    expect(ns?.productionStatus).toBe('production');
  });

  it('getConnectorRegistration returns undefined for an unknown key', () => {
    expect(getConnectorRegistration('does-not-exist')).toBeUndefined();
  });

  it('listProductionConnectors returns only production-tier entries', () => {
    const list = listProductionConnectors();
    expect(list.length).toBe(5);
    for (const entry of list) {
      expect(entry.productionStatus).toBe('production');
    }
  });

  it('listFactoryWiredConnectors returns only entries with a factory closure', () => {
    const list = listFactoryWiredConnectors();
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      expect(typeof entry.factory).toBe('function');
    }
  });

  it('listDIBoundConnectors returns only entries with diBindingAvailable=true', () => {
    const list = listDIBoundConnectors();
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      expect(entry.diBindingAvailable).toBe(true);
    }
  });
});

describe('classRef wires up the actual connector class', () => {
  it('every entry references a class whose name matches its className field', () => {
    for (const entry of CONNECTOR_REGISTRY) {
      // The runtime `name` of a class constructor reflects the original
      // declaration name. Catches accidental misalignment if someone reorders
      // imports or copy-pastes a wrong classRef.
      const constructor = entry.classRef as { name?: string };
      expect(constructor.name).toBe(entry.className);
    }
  });
});

describe('factory closures (PR 6A-2)', () => {
  function buildDeps(): ConnectorDeps {
    const logger = new Logger('connectorRegistry.test');
    const authService = new AuthService(logger);
    // Non-null sentinel — connector constructors only check truthiness on this
    // dep at construction time; method calls would happen during initialize()
    // / authenticate() / CRUD, which the smoke test does not exercise.
    const outboundGovernance = {} as OutboundGovernanceService;
    return { logger, authService, outboundGovernance };
  }

  it('every factory closure returns an IConnector-shaped instance without throwing', () => {
    const deps = buildDeps();
    const wired = listFactoryWiredConnectors();
    expect(wired.length).toBeGreaterThan(0);
    for (const entry of wired) {
      const instance = entry.factory!(`${entry.key}-test`, deps);
      // IConnector contract requires these methods. We don't call them — the
      // smoke test only confirms construction shape.
      expect(typeof instance.initialize).toBe('function');
      expect(typeof instance.authenticate).toBe('function');
      expect(typeof instance.testConnection).toBe('function');
    }
  });

  it('every production-tier entry exposes a factory closure', () => {
    // Mirrors the audit gate: production tier ⇒ reachable through
    // ConnectorManager.createConnector() (PR 6A-2 / ADR-015).
    for (const entry of listProductionConnectors()) {
      expect(typeof entry.factory).toBe('function');
    }
  });
});

// Type-level test: ConnectorRegistration[] is assignable from CONNECTOR_REGISTRY.
// Compile error if the registry's element type drifts from the public type.
const _assignabilityCheck: readonly ConnectorRegistration[] = CONNECTOR_REGISTRY;
void _assignabilityCheck;
