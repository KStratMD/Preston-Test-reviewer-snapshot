import 'reflect-metadata';
import { ConnectorManager } from '../../../../src/services/integration/ConnectorManager';
import { Logger } from '../../../../src/utils/Logger';
import { AuthService } from '../../../../src/services/AuthService';
import type { OutboundGovernanceService } from '../../../../src/services/governance/OutboundGovernanceService';
import {
  CONNECTOR_REGISTRY,
  listFactoryWiredConnectors,
} from '../../../../src/connectors/connectorRegistry';

/**
 * PR 6A-2: ConnectorManager.createConnector consumes the registry. The
 * tests here confirm:
 *   - lookup is case-insensitive (matches the long-standing
 *     `systemType.toLowerCase()` invariant);
 *   - registry-factory-wired keys produce an IConnector;
 *   - keys without a factory closure (Squire, SuiteCentralConnectorProd)
 *     and unknown keys both throw "Unsupported system type" — the audit gate
 *     at scripts/audit-status-claims.mjs treats those as DI-only by design.
 */
describe('ConnectorManager (registry-driven)', () => {
  function build(): ConnectorManager {
    const logger = new Logger('ConnectorManager.test');
    const authService = new AuthService(logger);
    const outboundGovernance = {} as OutboundGovernanceService;
    return new ConnectorManager(logger, authService, outboundGovernance);
  }

  it('produces an IConnector for every registry-factory-wired key', async () => {
    const manager = build();
    for (const entry of listFactoryWiredConnectors()) {
      const connector = await manager.getConnector(entry.key, 'test');
      expect(typeof connector.initialize).toBe('function');
      expect(typeof connector.testConnection).toBe('function');
    }
  });

  it('throws "Unsupported system type" for every key without a factory closure', async () => {
    const manager = build();
    const noFactoryEntries = CONNECTOR_REGISTRY.filter((e) => e.factory === undefined);
    expect(noFactoryEntries.length).toBeGreaterThan(0);
    for (const entry of noFactoryEntries) {
      await expect(manager.getConnector(entry.key, 'test')).rejects.toThrow(
        /Unsupported system type/,
      );
    }
  });

  it('squire and suitecentral_prod (DI-only by design) are unreachable through ConnectorManager', async () => {
    // Both keys have inversify bindings but no registry factory closure.
    // Pinning them by name guards the documented exception list against
    // drift — if someone adds a `factory` to either entry, this test fails
    // and the contributor must either acknowledge the surface expansion
    // (update this assertion + the "DI-only" comments in the registry) or
    // back the change out.
    const manager = build();
    for (const key of ['squire', 'suitecentral_prod']) {
      const entry = CONNECTOR_REGISTRY.find((e) => e.key === key);
      expect(entry).toBeDefined();
      expect(entry!.factory).toBeUndefined();
      await expect(manager.getConnector(key, 'test')).rejects.toThrow(
        /Unsupported system type/,
      );
    }
  });

  it('throws "Unsupported system type" for an unknown key', async () => {
    const manager = build();
    await expect(manager.getConnector('does-not-exist', 'test')).rejects.toThrow(
      /Unsupported system type/,
    );
  });

  it('lookup is case-insensitive (mirrors the long-standing toLowerCase() contract)', async () => {
    const manager = build();
    const connector = await manager.getConnector('NETSUITE', 'test');
    expect(typeof connector.testConnection).toBe('function');
  });

  it('caches per-key/per-id so repeat calls return the same instance', async () => {
    const manager = build();
    const a = await manager.getConnector('netsuite', 'cache-key');
    const b = await manager.getConnector('netsuite', 'cache-key');
    expect(a).toBe(b);
  });
});
