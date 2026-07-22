// PR-C3.1a R3 (Copilot) — `reflect-metadata` must load before any
// Inversify-decorated module evaluates. `SyncErrorAssistService` is
// decorated, so the side-effect import must precede its module load
// to avoid `Reflect.defineMetadata is not a function` on fresh jest
// workers (evaluation order is jest-file-order-dependent).
import 'reflect-metadata';
import { normalizeErrorRecordForPrompt as normalize } from '../../../../src/services/syncErrorAssist/SyncErrorAssistService';

describe('normalizeErrorRecordForPrompt', () => {
  it('maps webhook camelCase shape to NormalizedErrorRecord', () => {
    expect(normalize({
      tenantId: 'acme',
      errorRecordId: 'err-1',
      lastModified: '2026-05-10T00:00:00Z',
      errorType: 'sync',
      errorMessage: 'boom',
      sourcePayload: { foo: 'bar' },
      attemptCount: 2,
    })).toEqual({
      id: 'err-1',
      error_message: 'boom',
      error_context: { foo: 'bar' },
      attempt_count: 2,
    });
  });

  it('maps polling snake_case shape to NormalizedErrorRecord', () => {
    expect(normalize({
      id: 'err-2',
      error_message: 'bang',
      error_context: { x: 1 },
      attempt_count: 1,
    })).toEqual({
      id: 'err-2',
      error_message: 'bang',
      error_context: { x: 1 },
      attempt_count: 1,
    });
  });

  it('treats missing optional webhook fields as defaults', () => {
    expect(normalize({
      tenantId: 'acme',
      errorRecordId: 'err-3',
      lastModified: '2026-05-10T00:00:00Z',
      errorType: 'sync',
      errorMessage: 'missing context',
    })).toEqual({
      id: 'err-3',
      error_message: 'missing context',
      error_context: {},
      attempt_count: 0,
    });
  });
});
