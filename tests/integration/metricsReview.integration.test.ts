/**
 * Integration smoke for the Phase 7 reviewer-evidence endpoint.
 *
 * Verifies that:
 *   - GET /api/metrics still returns Prometheus text (no regression).
 *   - GET /api/metrics/review returns JSON with the expected reviewer payload.
 *   - The two handlers do not cross-wire (Prometheus path never returns JSON,
 *     JSON path never returns Prometheus text).
 */

import './setupEnv'; // Must be first to configure environment
import request from 'supertest';
import type { Application as ExpressApp } from 'express';
import type { App } from '../../src/app';
import { createTestApp } from './helpers/testServices';
import { __resetMetricsReviewCacheForTests } from '../../src/routes/metrics';

describe('Metrics endpoints', () => {
  let appInstance: App;
  let expressApp: ExpressApp;

  beforeAll(async () => {
    const testApp = await createTestApp();
    appInstance = testApp.appInstance;
    expressApp = testApp.expressApp;
  });

  afterAll(async () => {
    if (appInstance && typeof appInstance.shutdown === 'function') {
      await appInstance.shutdown();
    }
  });

  beforeEach(() => {
    __resetMetricsReviewCacheForTests();
  });

  describe('GET /api/metrics (Prometheus text)', () => {
    test('returns 200 with text/plain Content-Type', async () => {
      const response = await request(expressApp).get('/api/metrics').expect(200);
      expect(response.headers['content-type']).toMatch(/^text\/plain/);
    });

    test('body is Prometheus exposition format, not JSON', async () => {
      const response = await request(expressApp).get('/api/metrics').expect(200);
      const body = response.text;
      expect(typeof body).toBe('string');
      expect(body).toMatch(/# HELP/);
      expect(() => JSON.parse(body)).toThrow();
    });
  });

  describe('GET /api/metrics/review (JSON reviewer payload)', () => {
    test('returns 200 with application/json Content-Type', async () => {
      const response = await request(expressApp).get('/api/metrics/review').expect(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
    });

    test('payload has the documented reviewer-evidence shape', async () => {
      const response = await request(expressApp).get('/api/metrics/review').expect(200);
      const body = response.body;
      expect(body).toMatchObject({
        schema_version: 1,
        dlp_patterns_endpoint: '/api/compliance/dlp-patterns',
        link_to_evidence: 'EVALUATION.md',
      });
      expect(typeof body.served_at).toBe('string');
      expect(new Date(body.served_at).toString()).not.toBe('Invalid Date');
      expect(typeof body.payload_loaded_at).toBe('string');
      expect(typeof body.build_sha).toBe('string');
      expect(body.build_sha.length).toBeGreaterThan(0);
      expect(Array.isArray(body.proof_cards)).toBe(true);
      // metrics either parsed (object) or null with metrics_error string
      if (body.metrics_error === null) {
        expect(typeof body.metrics).toBe('object');
        expect(body.metrics).not.toBeNull();
      } else {
        expect(typeof body.metrics_error).toBe('string');
      }
    });

    test('proof_cards entries have component, card_path, status', async () => {
      const response = await request(expressApp).get('/api/metrics/review').expect(200);
      const cards: Array<{ component: string; card_path: string; status: string }> =
        response.body.proof_cards;
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        expect(typeof card.component).toBe('string');
        expect(card.card_path).toMatch(/^docs\/review\/proof-cards\/.+\.md$/);
        expect(typeof card.status).toBe('string');
      }
    });

    test('honors BUILD_SHA env var when set', async () => {
      const previous = process.env.BUILD_SHA;
      process.env.BUILD_SHA = 'integration-test-sha-abc123';
      __resetMetricsReviewCacheForTests();
      try {
        const response = await request(expressApp).get('/api/metrics/review').expect(200);
        expect(response.body.build_sha).toBe('integration-test-sha-abc123');
      } finally {
        if (previous === undefined) {
          delete process.env.BUILD_SHA;
        } else {
          process.env.BUILD_SHA = previous;
        }
      }
    });
  });

  describe('handlers do not cross-wire', () => {
    test('/api/metrics never returns application/json', async () => {
      const response = await request(expressApp).get('/api/metrics').expect(200);
      expect(response.headers['content-type']).not.toMatch(/^application\/json/);
    });

    test('/api/metrics/review never returns text/plain', async () => {
      const response = await request(expressApp).get('/api/metrics/review').expect(200);
      expect(response.headers['content-type']).not.toMatch(/^text\/plain/);
    });
  });
});
