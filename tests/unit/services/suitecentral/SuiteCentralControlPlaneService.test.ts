import { SuiteCentralControlPlaneService } from '../../../../src/services/suitecentral/controlPlane/SuiteCentralControlPlaneService';
import {
  SuiteCentralConflictError,
  SuiteCentralDependencyError,
  SuiteCentralForbiddenError,
  SuiteCentralNotFoundError,
  SuiteCentralValidationError,
} from '../../../../src/services/suitecentral/controlPlane/errors';
import type { Logger } from '../../../../src/utils/Logger';
import type { SuiteCentralControlPlaneContext } from '../../../../src/services/suitecentral/controlPlane/domain';

const SECRET = 'super-secret-value';

const tenantCtx: SuiteCentralControlPlaneContext = {
  actorUserId: 'user-1',
  targetTenantId: 'tenant-a',
  accessMode: 'tenant_admin',
  correlationId: 'corr-1',
};

const platformCtx: SuiteCentralControlPlaneContext = {
  ...tenantCtx,
  accessMode: 'platform_admin',
};

const environment = {
  id: 'env-1',
  tenantId: 'tenant-a',
  name: 'prod',
  baseUrl: 'https://api.suitecentral.example',
  environmentTier: 'production' as const,
  apiVersion: 'v1',
  timeoutMs: 30000,
  retryAttempts: 3,
  rateLimitConfig: null,
  securityConfig: null,
  featureConfig: null,
  version: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: '',
  updatedAt: '',
};

const credentialMeta = {
  id: 'cred-1',
  tenantId: 'tenant-a',
  environmentId: 'env-1',
  name: 'primary',
  clientId: 'client-abc',
  secretRef: 'suitecentral-deadbeef',
  companyId: null,
  scopes: [],
  isActive: true,
  rotatedAt: null,
  lastUsedAt: null,
  version: 1,
};

const credentialView = {
  id: 'cred-1',
  environmentId: 'env-1',
  name: 'primary',
  clientId: 'client-abc',
  companyId: null,
  scopes: [],
  isActive: true,
  secretConfigured: true,
  rotatedAt: null,
  lastUsedAt: null,
  version: 1,
};

const destination = {
  canonicalUrl: 'https://api.suitecentral.example',
  hostname: 'api.suitecentral.example',
  port: 443,
  addresses: [{ address: '93.184.216.34', family: 4 }],
};

describe('SuiteCentralControlPlaneService', () => {
  let events: string[];
  let repository: Record<string, jest.Mock>;
  let secretStore: Record<string, jest.Mock>;
  let outboundPolicy: Record<string, jest.Mock>;
  let connectorFactory: { create: jest.Mock };
  let outboundGovernance: Record<string, jest.Mock>;
  let monitoring: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  let logger: Logger;
  let service: SuiteCentralControlPlaneService;
  let connector: Record<string, jest.Mock>;

  beforeEach(() => {
    events = [];
    connector = {
      authenticate: jest.fn(async () => {
        events.push('connector-test');
        return true;
      }),
      read: jest.fn(async () => ({ id: 'sys-1', version: '2.0' })),
      bulkImport: jest.fn(async () => 'op-1'),
      getBulkOperationStatus: jest.fn(async () => ({ id: 'op-1', status: 'completed' })),
      setupWebhook: jest.fn(async () => 'wh-1'),
      removeWebhook: jest.fn(async () => true),
    };

    repository = {
      listEnvironments: jest.fn(async () => [environment]),
      findEnvironment: jest.fn(async (tenantId: string) => (tenantId === 'tenant-a' ? environment : undefined)),
      createEnvironment: jest.fn(async () => {
        events.push('persist-environment');
        return environment;
      }),
      updateEnvironment: jest.fn(async () => environment),
      createCredentialMetadata: jest.fn(async () => {
        events.push('insert-metadata');
        return credentialView;
      }),
      findCredentialMetadata: jest.fn(async (tenantId: string) =>
        tenantId === 'tenant-a' ? credentialMeta : undefined,
      ),
      listCredentials: jest.fn(async () => [credentialView]),
      rotateCredentialMetadata: jest.fn(async () => credentialView),
      deleteCredentialMetadata: jest.fn(async () => undefined),
      createTemplate: jest.fn(async () => ({ id: 't-1' })),
      listTemplates: jest.fn(async () => []),
      findTemplate: jest.fn(async (tenantId: string) => (tenantId === 'tenant-a' ? { id: 't-1' } : undefined)),
      findMonitoringConfig: jest.fn(async () => ({
        id: 'm-1',
        tenantId: 'tenant-a',
        environmentId: 'env-1',
        enabled: false,
        intervalMs: 60000,
        thresholds: null,
        version: 1,
      })),
      upsertMonitoringConfig: jest.fn(async () => ({
        id: 'm-1',
        tenantId: 'tenant-a',
        environmentId: 'env-1',
        enabled: true,
        intervalMs: 60000,
        thresholds: null,
        version: 2,
      })),
      listAllowedHosts: jest.fn(async () => []),
      createAllowedHost: jest.fn(async () => ({ id: 'h-1', hostname: 'a.example' })),
      revokeAllowedHost: jest.fn(async () => ({ id: 'h-1', status: 'revoked' })),
    };

    secretStore = {
      referenceFor: jest.fn(() => 'suitecentral-deadbeef'),
      store: jest.fn(async () => {
        events.push('store-secret');
        return 'suitecentral-deadbeef';
      }),
      rotate: jest.fn(async () => undefined),
      delete: jest.fn(async () => {
        events.push('delete-secret');
      }),
    };

    outboundPolicy = {
      validateBaseUrl: jest.fn(async () => {
        events.push('validate-base-url');
        return destination;
      }),
      validateWebhookTarget: jest.fn(async () => {
        events.push('validate-webhook-target');
        return destination;
      }),
    };

    connectorFactory = {
      create: jest.fn(async () => {
        events.push('factory-create');
        return connector;
      }),
    };

    outboundGovernance = {
      validateConnectorWrite: jest.fn(async (payload: unknown) => ({
        approved: true,
        approvalRequired: false,
        redactedPayload: payload,
        findings: [],
        auditMetadata: { blocked: false },
      })),
    };

    monitoring = {
      startEnvironment: jest.fn(),
      stopEnvironment: jest.fn(async () => undefined),
      getHealthHistory: jest.fn(() => [{ status: 'healthy', responseTimeMs: 5, checkedAt: '' }]),
      getUsage: jest.fn(() => ({ probes: 2, failures: 0, lastResponseTimeMs: 5, averageResponseTimeMs: 5 })),
      getActiveAlerts: jest.fn(() => []),
      resolveAlert: jest.fn(() => true),
    };

    audit = {
      attempt: jest.fn(async () => {
        events.push('audit-attempt');
      }),
      success: jest.fn(async () => {
        events.push('audit-success');
      }),
      failure: jest.fn(async () => {
        events.push('audit-failure');
      }),
    };

    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    service = new SuiteCentralControlPlaneService(
      repository as never,
      secretStore as never,
      outboundPolicy as never,
      connectorFactory as never,
      outboundGovernance as never,
      monitoring as never,
      audit as never,
      logger,
    );
  });

  describe('secret absence', () => {
    it('never leaks the client secret through createCredential', async () => {
      const result = await service.createCredential(tenantCtx, {
        environmentId: 'env-1',
        name: 'primary',
        clientId: 'client-abc',
        clientSecret: SECRET,
      });

      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(repository.createCredentialMetadata.mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify(audit.attempt.mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify(audit.success.mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(SECRET);
      // The secret reaches exactly one collaborator: the secret store.
      expect(secretStore.store).toHaveBeenCalledWith('tenant-a', expect.any(String), SECRET);
    });

    it('never leaks the client secret through rotateCredential', async () => {
      // Pre-read at v1, post-write read at v2 — the version this CAS wrote.
      repository.findCredentialMetadata
        .mockResolvedValueOnce(credentialMeta)
        .mockResolvedValueOnce({ ...credentialMeta, version: 2 });

      const result = await service.rotateCredential(tenantCtx, 'cred-1', 1, SECRET);

      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(repository.rotateCredentialMetadata.mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify(audit.attempt.mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify(audit.success.mock.calls)).not.toContain(SECRET);
    });

    it('never leaks the client secret through a thrown error', async () => {
      repository.createCredentialMetadata.mockRejectedValue(new Error('insert exploded'));
      secretStore.delete.mockResolvedValue(undefined);

      const error = await service
        .createCredential(tenantCtx, {
          environmentId: 'env-1',
          name: 'primary',
          clientId: 'client-abc',
          clientSecret: SECRET,
        })
        .catch((e: unknown) => e as Error);

      expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toContain(SECRET);
    });
  });

  describe('audit resourceId is never caller text', () => {
    // audit_logs.resource_id is NOT DLP-scanned — only `details` is. So a
    // caller-supplied name used as resourceId would be untrusted text in a
    // durable, ungoverned column. The name still travels, in governed details.
    it.each([
      [
        'createEnvironment',
        () => service.createEnvironment(tenantCtx, { name: `n ${SECRET}`, baseUrl: 'https://api.suitecentral.example' }),
        () => repository.createEnvironment.mock.calls[0][1],
      ],
      [
        'createTemplate',
        () => service.createTemplate(tenantCtx, { name: `n ${SECRET}`, sourceSystem: 'Squire' }),
        () => repository.createTemplate.mock.calls[0][1],
      ],
      [
        'createAllowedHost',
        () => service.createAllowedHost(platformCtx, { hostname: `h-${SECRET}` }),
        () => repository.createAllowedHost.mock.calls[0][0],
      ],
    ])('%s audits an opaque id, not the caller-supplied name', async (_n, call, persistedId) => {
      await call();

      const auditedResourceId = audit.attempt.mock.calls[0][3];
      expect(auditedResourceId).not.toContain(SECRET);
      // And it is the id actually persisted, so the row is still correlatable.
      expect(auditedResourceId).toBe(persistedId());
    });
  });

  describe('audit ordering', () => {
    it('audits the attempt BEFORE constructing a connector or touching the network', async () => {
      await service.testConnection(tenantCtx, 'env-1', 'cred-1');

      expect(events).toEqual(['audit-attempt', 'factory-create', 'connector-test', 'audit-success']);
    });

    it('blocks execution when the attempt audit cannot be written', async () => {
      audit.attempt.mockRejectedValue(new Error('audit backend down'));

      await expect(service.testConnection(tenantCtx, 'env-1', 'cred-1')).rejects.toThrow();

      // Fail closed: no connector, no network, no work performed unaudited.
      expect(connectorFactory.create).not.toHaveBeenCalled();
    });

    it('sanitizes an attempt-audit failure instead of letting it escape raw', async () => {
      // The audit backend and its governance scan are exactly the kind of
      // dependency that throws unstructured text, and this is the one call that
      // must fail closed — so its failure must not be the one that escapes.
      audit.attempt.mockRejectedValue(new Error(`DLP backend refused {"clientSecret":"${SECRET}"}`));

      const error = await service
        .testConnection(tenantCtx, 'env-1', 'cred-1')
        .catch((e: unknown) => e as Error & { code?: string });

      expect(error.code).toBe('operation_failed');
      expect(JSON.stringify({ m: error.message, s: error.stack })).not.toContain(SECRET);
    });

    it('does not fail a completed operation when only the success audit fails', async () => {
      // The work already happened — often irreversibly, in the ERP. Throwing here
      // would tell the caller to retry a completed side effect (duplicate
      // credential, duplicate bulk import) and would land in the failure path,
      // recording a FAILURE for an operation that succeeded.
      audit.success.mockRejectedValue(new Error('audit backend down'));

      await expect(service.testConnection(tenantCtx, 'env-1', 'cred-1')).resolves.toEqual({ ok: true });

      // And no failure row is written for a successful operation.
      expect(audit.failure).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'SuiteCentral success audit could not be written; operation DID complete',
        expect.objectContaining({ action: 'connection.test' }),
      );
    });

    it('still fails closed when the ATTEMPT audit cannot be written', async () => {
      // The asymmetry is the point: before the work, an unwritable audit blocks it.
      audit.attempt.mockRejectedValue(new Error('audit backend down'));

      await expect(service.testConnection(tenantCtx, 'env-1', 'cred-1')).rejects.toThrow();
      expect(connectorFactory.create).not.toHaveBeenCalled();
    });

    it('audits a failure with a stable code and rethrows the original error', async () => {
      connectorFactory.create.mockRejectedValue(new SuiteCentralNotFoundError('environment_not_found', 'nope'));

      await expect(service.testConnection(tenantCtx, 'env-1', 'cred-1')).rejects.toBeInstanceOf(
        SuiteCentralNotFoundError,
      );
      expect(audit.failure).toHaveBeenCalledWith(
        tenantCtx,
        expect.any(String),
        expect.any(String),
        expect.any(String),
        'environment_not_found',
        expect.any(Number),
      );
    });
  });

  describe('tenant ownership', () => {
    it('raises a typed 404 for a cross-tenant environment without touching secrets', async () => {
      const foreignCtx = { ...tenantCtx, targetTenantId: 'tenant-b' };

      await expect(service.getEnvironment(foreignCtx, 'env-1')).rejects.toBeInstanceOf(SuiteCentralNotFoundError);
      expect(secretStore.store).not.toHaveBeenCalled();
      expect(connectorFactory.create).not.toHaveBeenCalled();
    });

    it('raises a typed 404 for a cross-tenant credential', async () => {
      const foreignCtx = { ...tenantCtx, targetTenantId: 'tenant-b' };

      await expect(service.getCredential(foreignCtx, 'cred-1')).rejects.toBeInstanceOf(SuiteCentralNotFoundError);
    });

    it('scopes every repository read to the context tenant, never a caller-supplied id', async () => {
      await service.listEnvironments(tenantCtx);
      expect(repository.listEnvironments).toHaveBeenCalledWith('tenant-a');
    });
  });

  describe('destination validation', () => {
    it('validates the base URL BEFORE persisting a new environment', async () => {
      await service.createEnvironment(tenantCtx, { name: 'prod', baseUrl: 'https://api.suitecentral.example' });

      expect(events.indexOf('validate-base-url')).toBeLessThan(events.indexOf('persist-environment'));
    });

    it('validates the base URL before persisting a base-URL change', async () => {
      await service.updateEnvironment(tenantCtx, 'env-1', 1, { baseUrl: 'https://new.suitecentral.example' });

      expect(outboundPolicy.validateBaseUrl).toHaveBeenCalledWith('https://new.suitecentral.example');
    });

    it('does not re-validate when an update leaves the base URL alone', async () => {
      await service.updateEnvironment(tenantCtx, 'env-1', 1, { name: 'renamed' });

      expect(outboundPolicy.validateBaseUrl).not.toHaveBeenCalled();
    });

    it('validates the webhook target before the connector is constructed', async () => {
      await service.createWebhook(tenantCtx, 'env-1', 'cred-1', 'https://hooks.example/x', ['sync']);

      expect(events.indexOf('validate-webhook-target')).toBeLessThan(events.indexOf('factory-create'));
    });
  });

  describe('credential create ordering and cleanup', () => {
    it('stores the secret before inserting metadata', async () => {
      await service.createCredential(tenantCtx, {
        environmentId: 'env-1',
        name: 'primary',
        clientId: 'client-abc',
        clientSecret: SECRET,
      });

      expect(events.indexOf('store-secret')).toBeLessThan(events.indexOf('insert-metadata'));
    });

    it('derives the secret ref from the same profile id it persists', async () => {
      await service.createCredential(tenantCtx, {
        environmentId: 'env-1',
        name: 'primary',
        clientId: 'client-abc',
        clientSecret: SECRET,
      });

      const allocatedId = secretStore.store.mock.calls[0][1];
      const persistedId = repository.createCredentialMetadata.mock.calls[0][1];
      // If these ever diverge the stored secret becomes unresolvable.
      expect(persistedId).toBe(allocatedId);
    });

    it('deletes the orphaned secret when the metadata insert fails', async () => {
      repository.createCredentialMetadata.mockRejectedValue(new Error('insert exploded'));
      // Cleanup only runs once the row is proven absent.
      repository.findCredentialMetadata.mockResolvedValue(undefined);

      await expect(
        service.createCredential(tenantCtx, {
          environmentId: 'env-1',
          name: 'primary',
          clientId: 'client-abc',
          clientSecret: SECRET,
        }),
      ).rejects.toThrow();

      expect(events).toContain('delete-secret');
    });

    it('raises a dependency error when the orphaned-secret cleanup also fails', async () => {
      repository.createCredentialMetadata.mockRejectedValue(new Error('insert exploded'));
      repository.findCredentialMetadata.mockResolvedValue(undefined);
      secretStore.delete.mockRejectedValue(new Error('secret backend down'));

      await expect(
        service.createCredential(tenantCtx, {
          environmentId: 'env-1',
          name: 'primary',
          clientId: 'client-abc',
          clientSecret: SECRET,
        }),
      ).rejects.toBeInstanceOf(SuiteCentralDependencyError);
    });

    it('does not attach the secret-provider error as a cause a route could serialize', async () => {
      repository.createCredentialMetadata.mockRejectedValue(new Error('insert exploded'));
      // Unstructured provider text that quotes the request — and the secret.
      secretStore.delete.mockRejectedValue(new Error(`PUT failed for body {"value":"${SECRET}"}`));

      const error = await service
        .createCredential(tenantCtx, {
          environmentId: 'env-1',
          name: 'primary',
          clientId: 'client-abc',
          clientSecret: SECRET,
        })
        .catch((e: unknown) => e as Error & { cause?: unknown });

      expect(error.cause).toBeUndefined();
      expect(JSON.stringify({ m: error.message, s: error.stack, c: error.cause })).not.toContain(SECRET);
    });

    it('reports a delete-path cleanup failure under a delete-specific code', async () => {
      secretStore.delete.mockRejectedValue(new Error('secret backend down'));

      const error = await service
        .deleteCredential(tenantCtx, 'cred-1', 1)
        .catch((e: unknown) => e as { code?: string });

      // A create-path code here would misdirect an operator: the metadata row is
      // already gone and it is the secret that outlived it.
      expect(error.code).toBe('credential_delete_cleanup_failed');
    });
  });

  describe('partial-failure safety', () => {
    it('wins the version check BEFORE writing the rotated secret', async () => {
      const order: string[] = [];
      repository.rotateCredentialMetadata.mockImplementation(async () => {
        order.push('cas');
        return credentialView;
      });
      secretStore.rotate.mockImplementation(async () => {
        order.push('write-secret');
      });
      repository.findCredentialMetadata
        .mockResolvedValueOnce(credentialMeta)
        .mockResolvedValueOnce({ ...credentialMeta, version: 2 });

      await service.rotateCredential(tenantCtx, 'cred-1', 1, SECRET);

      // Secret-first let two concurrent rotations both write, with only one
      // winning CAS — the live secret was then whichever wrote last.
      expect(order).toEqual(['cas', 'write-secret']);
    });

    it('never writes a secret when the rotation loses the version check', async () => {
      repository.rotateCredentialMetadata.mockRejectedValue(new Error('version conflict'));

      await expect(service.rotateCredential(tenantCtx, 'cred-1', 1, SECRET)).rejects.toThrow();

      // A loser touching the secret store would resurrect a concurrently deleted
      // secret, orphaning it.
      expect(secretStore.rotate).not.toHaveBeenCalled();
    });

    it('removes a resurrected secret when a delete lands mid-rotation', async () => {
      // The CAS cannot stop a delete that commits at the NEW version while the
      // secret write is in flight — the DB and the secret provider share no
      // transaction. The rotation would then leave a secret with no owning row.
      repository.findCredentialMetadata
        .mockResolvedValueOnce(credentialMeta) // requireCredential, pre-rotation
        .mockResolvedValueOnce(undefined); // post-write: the row is gone

      await expect(service.rotateCredential(tenantCtx, 'cred-1', 1, SECRET)).rejects.toBeInstanceOf(
        SuiteCentralNotFoundError,
      );

      expect(secretStore.delete).toHaveBeenCalled();
    });

    it('cleans up a resurrected secret even when the rotation write REJECTED', async () => {
      // A rejected write is not proof nothing was written — the provider can
      // commit and then fail the response. Throwing straight out would skip the
      // orphan check and strand a committed secret with no owning row.
      secretStore.rotate.mockRejectedValue(new Error('gateway timeout'));
      repository.findCredentialMetadata
        .mockResolvedValueOnce(credentialMeta) // requireCredential
        .mockResolvedValueOnce(undefined); // post-write: row deleted concurrently

      await expect(service.rotateCredential(tenantCtx, 'cred-1', 1, SECRET)).rejects.toBeInstanceOf(
        SuiteCentralNotFoundError,
      );

      expect(secretStore.delete).toHaveBeenCalled();
    });

    it('reports a conflict when a concurrent rotation superseded this one', async () => {
      // The CAS serializes metadata, not the two secret writes: A and B can win
      // successive versions and still write their secrets in the opposite order.
      // We cannot prevent that across two stores, but we must not report success.
      repository.findCredentialMetadata
        .mockResolvedValueOnce(credentialMeta) // requireCredential
        .mockResolvedValueOnce({ ...credentialMeta, version: 9 }); // moved on

      const error = await service
        .rotateCredential(tenantCtx, 'cred-1', 1, SECRET)
        .catch((e: unknown) => e as { code?: string });

      expect(error.code).toBe('rotation_superseded');
    });

    it('detects supersession even when the repository re-read already saw the newer version', async () => {
      // rotateCredentialMetadata updates, then RE-READS to build its view. A
      // rotation landing in between makes that view report the other rotation's
      // version — so comparing the post-write row against `view.version` would
      // match and miss the supersession. The check must use the version this CAS
      // wrote: expectedVersion + 1.
      repository.rotateCredentialMetadata.mockResolvedValue({ ...credentialView, version: 9 });
      repository.findCredentialMetadata
        .mockResolvedValueOnce(credentialMeta) // requireCredential
        .mockResolvedValueOnce({ ...credentialMeta, version: 9 }); // post-write

      const error = await service
        .rotateCredential(tenantCtx, 'cred-1', 1, SECRET)
        .catch((e: unknown) => e as { code?: string });

      // expectedVersion 1 => this CAS wrote 2, but the row is at 9.
      expect(error.code).toBe('rotation_superseded');
    });

    it('reports success when this rotation is the one that landed', async () => {
      repository.findCredentialMetadata
        .mockResolvedValueOnce(credentialMeta) // requireCredential
        .mockResolvedValueOnce({ ...credentialMeta, version: 2 }); // exactly expectedVersion + 1

      await expect(service.rotateCredential(tenantCtx, 'cred-1', 1, SECRET)).resolves.toBeDefined();
    });

    it('surfaces the rotation failure when the row still exists', async () => {
      secretStore.rotate.mockRejectedValue(new Error('gateway timeout'));
      repository.findCredentialMetadata
        .mockResolvedValueOnce(credentialMeta)
        .mockResolvedValueOnce({ ...credentialMeta, version: 2 }); // our rotation, not superseded

      const error = await service
        .rotateCredential(tenantCtx, 'cred-1', 1, SECRET)
        .catch((e: unknown) => e as { code?: string });

      // Row intact: the caller needs the rotation error, not a 404.
      expect(error.code).toBe('secret_rotate_failed');
      expect(secretStore.delete).not.toHaveBeenCalled();
    });

    it('retains the secret when the credential row landed despite a thrown create', async () => {
      // createCredentialMetadata inserts then reads back; a failed read-back after
      // a committed insert throws with the row present.
      repository.createCredentialMetadata.mockRejectedValue(new Error('read-back failed'));
      repository.findCredentialMetadata.mockResolvedValue(credentialMeta);

      await expect(
        service.createCredential(tenantCtx, {
          environmentId: 'env-1',
          name: 'primary',
          clientId: 'client-abc',
          clientSecret: SECRET,
        }),
      ).rejects.toThrow();

      // Deleting here would strand the surviving row on a missing secret.
      expect(secretStore.delete).not.toHaveBeenCalled();
    });

    it('retains the secret when row existence cannot be proven', async () => {
      repository.createCredentialMetadata.mockRejectedValue(new Error('insert exploded'));
      repository.findCredentialMetadata.mockRejectedValue(new Error('db unreachable'));

      await expect(
        service.createCredential(tenantCtx, {
          environmentId: 'env-1',
          name: 'primary',
          clientId: 'client-abc',
          clientSecret: SECRET,
        }),
      ).rejects.toThrow();

      expect(secretStore.delete).not.toHaveBeenCalled();
    });

    it('removes a speculatively-written secret when store() rejects', async () => {
      // A provider can commit the write and still fail the response, so a
      // rejection is not proof nothing landed. The reference is deterministic, so
      // cleanup does not need the ref the failed call never returned.
      secretStore.store.mockRejectedValue(new Error('gateway timeout'));

      await expect(
        service.createCredential(tenantCtx, {
          environmentId: 'env-1',
          name: 'primary',
          clientId: 'client-abc',
          clientSecret: SECRET,
        }),
      ).rejects.toThrow();

      expect(secretStore.referenceFor).toHaveBeenCalledWith('tenant-a', expect.any(String));
      expect(secretStore.delete).toHaveBeenCalled();
    });

    it('collapses an unvetted upstream error code rather than auditing it verbatim', async () => {
      // Third-party libraries put free-form text in `.code`; it is persisted to
      // audit_logs.error_message verbatim.
      connectorFactory.create.mockRejectedValue(
        Object.assign(new Error('boom'), { code: `failed for {"secret":"${SECRET}"}` }),
      );

      await expect(service.testConnection(tenantCtx, 'env-1', 'cred-1')).rejects.toThrow();

      expect(audit.failure).toHaveBeenCalledWith(
        tenantCtx,
        expect.any(String),
        expect.any(String),
        expect.any(String),
        'operation_failed',
        expect.any(Number),
      );
      expect(JSON.stringify(audit.failure.mock.calls)).not.toContain(SECRET);
    });

    it('replaces a non-domain error rather than rethrowing raw provider text', async () => {
      // Connector/factory/secret-provider failures are unstructured third-party
      // text that can quote the request they failed on.
      connectorFactory.create.mockRejectedValue(new Error(`ERP refused: {"clientSecret":"${SECRET}"}`));

      const error = await service
        .testConnection(tenantCtx, 'env-1', 'cred-1')
        .catch((e: unknown) => e as Error & { code?: string; status?: number });

      expect(error.code).toBe('operation_failed');
      expect(error.status).toBe(500);
      expect(JSON.stringify({ m: error.message, s: error.stack })).not.toContain(SECRET);
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain(SECRET);
    });

    it('preserves domain errors unchanged so routes keep their status mapping', async () => {
      connectorFactory.create.mockRejectedValue(
        new SuiteCentralNotFoundError('environment_not_found', 'nope'),
      );

      await expect(service.testConnection(tenantCtx, 'env-1', 'cred-1')).rejects.toBeInstanceOf(
        SuiteCentralNotFoundError,
      );
    });

    it('rejects an interval above Node timer limits, which would coerce to ~1ms', async () => {
      await expect(
        service.setMonitoringConfig(tenantCtx, 'env-1', { enabled: true, intervalMs: 2 ** 31 }, 1),
      ).rejects.toBeInstanceOf(SuiteCentralValidationError);
      expect(repository.upsertMonitoringConfig).not.toHaveBeenCalled();
    });

    it('does not propagate secret-store provider text that may quote the secret', async () => {
      secretStore.store.mockRejectedValue(new Error(`PUT rejected for {"value":"${SECRET}"}`));

      const error = await service
        .createCredential(tenantCtx, {
          environmentId: 'env-1',
          name: 'primary',
          clientId: 'client-abc',
          clientSecret: SECRET,
        })
        .catch((e: unknown) => e as Error & { code?: string });

      expect(error.code).toBe('secret_store_unavailable');
      expect(JSON.stringify({ m: error.message, s: error.stack })).not.toContain(SECRET);
    });
  });

  describe('monitoring interval validation', () => {
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1000])(
      'refuses to persist an unsafe interval: %s',
      async (intervalMs) => {
        await expect(
          service.setMonitoringConfig(tenantCtx, 'env-1', { enabled: true, intervalMs }, 1),
        ).rejects.toBeInstanceOf(SuiteCentralValidationError);
        expect(repository.upsertMonitoringConfig).not.toHaveBeenCalled();
      },
    );

    it('refuses to start monitoring that is persisted as disabled', async () => {
      repository.findMonitoringConfig.mockResolvedValue({
        id: 'm-1',
        tenantId: 'tenant-a',
        environmentId: 'env-1',
        enabled: false,
        intervalMs: 60000,
        thresholds: null,
        version: 1,
      });

      await expect(service.startMonitoring(tenantCtx, 'env-1')).rejects.toBeInstanceOf(
        SuiteCentralConflictError,
      );
      expect(monitoring.startEnvironment).not.toHaveBeenCalled();
    });
  });

  describe('platform-scoped allowed hosts', () => {
    it.each([
      ['listAllowedHosts', () => service.listAllowedHosts(tenantCtx)],
      ['createAllowedHost', () => service.createAllowedHost(tenantCtx, { hostname: 'a.example' })],
      ['revokeAllowedHost', () => service.revokeAllowedHost(tenantCtx, 'h-1')],
    ])('refuses %s for a tenant admin', async (_name, call) => {
      await expect(call()).rejects.toBeInstanceOf(SuiteCentralForbiddenError);
    });

    it('allows a platform admin through', async () => {
      await expect(service.listAllowedHosts(platformCtx)).resolves.toEqual([]);
      await expect(service.createAllowedHost(platformCtx, { hostname: 'a.example' })).resolves.toBeDefined();
    });
  });

  describe('governed writes', () => {
    it('routes a bulk import through outbound governance before the connector', async () => {
      await service.bulkImport(tenantCtx, 'env-1', 'cred-1', 'customer', [{ id: '1' }]);

      expect(outboundGovernance.validateConnectorWrite).toHaveBeenCalled();
      expect(connector.bulkImport).toHaveBeenCalled();
    });

    it('does not reach the connector when governance blocks the payload', async () => {
      outboundGovernance.validateConnectorWrite.mockResolvedValue({
        approved: false,
        approvalRequired: false,
        redactedPayload: undefined,
        findings: ['ssn'],
        auditMetadata: { blocked: true },
      });

      await expect(
        service.bulkImport(tenantCtx, 'env-1', 'cred-1', 'customer', [{ id: '1' }]),
      ).rejects.toThrow();
      expect(connector.bulkImport).not.toHaveBeenCalled();
    });
  });

  describe('monitoring surface', () => {
    it('reads health only for the context tenant', async () => {
      await service.getHealthReport(tenantCtx);
      expect(monitoring.getHealthHistory).toHaveBeenCalledWith('tenant-a', 'env-1', expect.anything());
    });

    it('starts monitoring only after verifying the environment belongs to the tenant', async () => {
      const foreignCtx = { ...tenantCtx, targetTenantId: 'tenant-b' };

      await expect(service.startMonitoring(foreignCtx, 'env-1')).rejects.toBeInstanceOf(SuiteCentralNotFoundError);
      expect(monitoring.startEnvironment).not.toHaveBeenCalled();
    });

    it('persists enablement and starts the runtime when monitoring is turned on', async () => {
      await service.setMonitoringConfig(tenantCtx, 'env-1', { enabled: true, intervalMs: 60000 }, 1);

      expect(repository.upsertMonitoringConfig).toHaveBeenCalled();
      expect(monitoring.startEnvironment).toHaveBeenCalled();
    });

    it('stops the runtime when monitoring is turned off', async () => {
      repository.upsertMonitoringConfig.mockResolvedValue({
        id: 'm-1',
        tenantId: 'tenant-a',
        environmentId: 'env-1',
        enabled: false,
        intervalMs: 60000,
        thresholds: null,
        version: 2,
      });

      await service.setMonitoringConfig(tenantCtx, 'env-1', { enabled: false }, 1);

      expect(monitoring.stopEnvironment).toHaveBeenCalledWith('tenant-a', 'env-1');
    });
  });
});
