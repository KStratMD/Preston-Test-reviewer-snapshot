/**
 * ComplianceRouter integration tests
 *
 * Covers:
 *   - GET /api/compliance/dlp-patterns (added in commit that introduced
 *     DLPService.getRegisteredPatterns() as the single source of truth for
 *     the C1 confidentiality panel on the compliance dashboard)
 *   - GET /api/compliance/soc2-mapping (regression-tests the wrong-path
 *     fix for src/services/security/DLPService.ts in BOTH the
 *     confidentiality and privacy entries)
 *
 * The DLP unit guard test (`tests/unit/services/security/DLPService.test.ts`)
 * pins the registry shape; this file pins the route layer that exposes it.
 */

import './setupEnv'; // Must be first to configure environment
import request from 'supertest';
import type { Application as ExpressApp } from 'express';
import { App } from '../../src/app';
import { createTestApp } from './helpers/testServices';
import { createTestToken } from '../../src/middleware/auth';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import type { DLPService } from '../../src/services/security/DLPService';
import type { Logger } from '../../src/utils/Logger';

jest.setTimeout(300000);

describe('ComplianceRouter integration', () => {
  let expressApp: ExpressApp;
  let appInstance: App;
  let complianceToken: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    appInstance = testApp.appInstance;
    expressApp = testApp.expressApp;

    complianceToken = createTestToken({
      id: 'compliance-test-user',
      username: 'compliance-tester',
      roles: ['admin'],
      permissions: ['compliance:read'],
    });
  });

  afterAll(async () => {
    if (appInstance && typeof appInstance.shutdown === 'function') {
      await appInstance.shutdown();
    }
  });

  describe('GET /api/compliance/dlp-patterns', () => {
    it('should return 401 without an Authorization header', async () => {
      const response = await request(expressApp).get('/api/compliance/dlp-patterns');

      expect(response.status).toBe(401);
    });

    it('should return 403 when the JWT lacks compliance permissions', async () => {
      const noPermsToken = createTestToken({
        id: 'no-perms',
        username: 'no-perms',
        roles: ['user'],
        permissions: [],
      });

      const response = await request(expressApp)
        .get('/api/compliance/dlp-patterns')
        .set('Authorization', `Bearer ${noPermsToken}`);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        success: false,
        error: expect.stringContaining('permissions'),
      });
    });

    it('should return the canonical 14 pattern types with metadata-only shape', async () => {
      const response = await request(expressApp)
        .get('/api/compliance/dlp-patterns')
        .set('Authorization', `Bearer ${complianceToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();

      const { count, patterns } = response.body.data;
      expect(count).toBe(14);
      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns).toHaveLength(14);

      const types = patterns.map((p: { type: string }) => p.type);
      expect(types).toEqual([
        'ssn',
        'credit_card',
        'email',
        'phone',
        'phone_intl',
        'medical_record_number',
        'api_key',
        'jwt_token',
        'ip_address',
        'bank_account',
        'date_of_birth',
        'passport',
        'drivers_license',
        'name',
      ]);

      // Metadata-only contract — the API must NOT leak detection internals.
      // Commit 2: also assert the new requiresFieldContext flag is present
      // and is a boolean on every entry (ultraplan review 2026-04-09
      // finding 8 — the existing not.toHaveProperty guards don't enforce
      // presence of the new field).
      for (const p of patterns) {
        expect(p).toHaveProperty('type');
        expect(p).toHaveProperty('displayName');
        expect(p).toHaveProperty('category');
        expect(p).toHaveProperty('severity');
        expect(p).toHaveProperty('requiresFieldContext');
        expect(typeof p.requiresFieldContext).toBe('boolean');
        expect(p).not.toHaveProperty('regex');
        expect(p).not.toHaveProperty('redact');
        expect(p).not.toHaveProperty('validate');
      }
    });

    it('should flag exactly the 6 field-gated patterns with requiresFieldContext: true', async () => {
      const response = await request(expressApp)
        .get('/api/compliance/dlp-patterns')
        .set('Authorization', `Bearer ${complianceToken}`);

      expect(response.status).toBe(200);
      const { patterns } = response.body.data;

      const gatedTypes = new Set(
        patterns
          .filter((p: { requiresFieldContext: boolean }) => p.requiresFieldContext)
          .map((p: { type: string }) => p.type)
      );
      expect(gatedTypes).toEqual(
        new Set(['phone_intl', 'bank_account', 'date_of_birth', 'passport', 'drivers_license', 'name'])
      );

      const unconditionalTypes = patterns
        .filter((p: { requiresFieldContext: boolean }) => !p.requiresFieldContext)
        .map((p: { type: string }) => p.type);
      expect(unconditionalTypes.length).toBe(8);
    });

    it('should return 500 and forward a real Error to the logger when the DLP service throws a non-Error value', async () => {
      // The router resolves both services as container singletons, so spying
      // on the container-bound instances intercepts the router's own calls.
      const dlpService = container.get<DLPService>(TYPES.DLPService);
      const logger = container.get<Logger>(TYPES.Logger);
      const patternsSpy = jest
        .spyOn(dlpService, 'getRegisteredPatterns')
        .mockImplementationOnce(() => {
          throw 'string failure'; // deliberate non-Error throw — exercises the wrap branch
        });
      const errorSpy = jest.spyOn(logger, 'error');

      try {
        const response = await request(expressApp)
          .get('/api/compliance/dlp-patterns')
          .set('Authorization', `Bearer ${complianceToken}`);

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ success: false, error: 'Internal server error' });

        // Logger.error only attaches its 2nd arg when it is an Error instance —
        // the route must wrap non-Error throws so the log carries the detail.
        expect(errorSpy).toHaveBeenCalledWith('DLP patterns query failed', expect.any(Error));
      } finally {
        patternsSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  describe('GET /api/compliance/soc2-mapping', () => {
    it('should return 403 without compliance permissions', async () => {
      const response = await request(expressApp).get('/api/compliance/soc2-mapping');

      // Without an Authorization header the auth middleware short-circuits
      // with 401 before the route's permission check; either is acceptable
      // as a "denied" outcome.
      expect([401, 403]).toContain(response.status);
    });

    it('should return SOC 2 mapping with the dynamic DLP pattern count', async () => {
      const response = await request(expressApp)
        .get('/api/compliance/soc2-mapping')
        .set('Authorization', `Bearer ${complianceToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.dlpPatternCount).toBe(14);
    });

    it('should reference the correct DLPService file path in confidentiality features', async () => {
      const response = await request(expressApp)
        .get('/api/compliance/soc2-mapping')
        .set('Authorization', `Bearer ${complianceToken}`);

      expect(response.status).toBe(200);
      const features = response.body.data.confidentiality.features;
      const dlpFeature = features.find((f: { feature: string }) =>
        f.feature.startsWith('DLP/PII Detection'),
      );

      expect(dlpFeature).toBeDefined();
      // Regression test: the file path returned by the API must point at the
      // security/-namespaced DLPService, not the older ai/-namespaced location.
      expect(dlpFeature.file).toBe('src/services/security/DLPService.ts');
      // Dynamic count must surface here too — no hardcoded literals allowed.
      expect(dlpFeature.feature).toBe('DLP/PII Detection (14 patterns)');
    });

    it('should reference the correct DLPService file path in privacy features', async () => {
      const response = await request(expressApp)
        .get('/api/compliance/soc2-mapping')
        .set('Authorization', `Bearer ${complianceToken}`);

      expect(response.status).toBe(200);
      const features = response.body.data.privacy.features;
      const gdprFeature = features.find((f: { feature: string }) =>
        f.feature.startsWith('GDPR/CCPA'),
      );

      expect(gdprFeature).toBeDefined();
      // Regression test for the SECOND stale ai/-namespaced DLPService path
      // that the original ultraplan plan missed (caught by Codex review).
      expect(gdprFeature.file).toBe('src/services/security/DLPService.ts');
    });

    it('should disclose the audit-log scope honestly (Phase 3 SOC 2 honesty)', async () => {
      const response = await request(expressApp)
        .get('/api/compliance/soc2-mapping')
        .set('Authorization', `Bearer ${complianceToken}`);

      expect(response.status).toBe(200);
      // PR 4A2 (#748) made the audit log persistent. The disclosure now states
      // 'persistent' and explains tenant attribution + outbound DLP redaction
      // (no longer mentions a roadmap/caveat).
      expect(response.body.data.scopeDisclosure).toEqual({
        auditLog: 'persistent',
        note: expect.stringContaining('persist'),
      });
      expect(response.body.data.scopeDisclosure.note).toContain('tenant attribution');
    });
  });
});
