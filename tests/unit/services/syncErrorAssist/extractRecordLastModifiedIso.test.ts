// PR-C3.1a R3 (Copilot) — `reflect-metadata` must load before any
// Inversify-decorated module evaluates. `SyncErrorAssistService` is
// decorated, so the side-effect import must precede its module load
// to avoid `Reflect.defineMetadata is not a function` on fresh jest
// workers (evaluation order is jest-file-order-dependent).
import 'reflect-metadata';
import { extractRecordLastModifiedIso } from '../../../../src/services/syncErrorAssist/SyncErrorAssistService';
import type { DataRecord } from '../../../../src/types/index';

describe('extractRecordLastModifiedIso (Copilot finding #3 fix — see SyncErrorAssistService.ts docstring)', () => {
  const sampleIso = '2026-05-12T15:30:00.000Z';
  const sampleDate = new Date(sampleIso);

  describe('root-level shapes (test-mock / webhook-payload contract)', () => {
    it('returns ISO when record.lastModified is a non-empty string', () => {
      const record = { id: 'r1', lastModified: sampleIso } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBe(sampleIso);
    });

    it('returns ISO when record.lastModified is a Date', () => {
      const record = { id: 'r1', lastModified: sampleDate } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBe(sampleIso);
    });

    it('returns null when record.lastModified is an empty string (and no fallback)', () => {
      const record = { id: 'r1', lastModified: '' } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBeNull();
    });

    it('returns null when record.lastModified is an unparseable string (and no fallback)', () => {
      const record = { id: 'r1', lastModified: 'not-a-date' } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBeNull();
    });
  });

  describe('metadata-level shapes (NetSuiteConnector.formatDataFromNetSuite production contract)', () => {
    it('returns ISO when record.metadata.lastModified is a Date (the real-world NetSuite case)', () => {
      const record = {
        id: 'r1',
        externalId: 'ext-1',
        fields: { custrecord_error_severity: 'high' },
        metadata: { source: 'NetSuite', lastModified: sampleDate, version: '1.0' },
      } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBe(sampleIso);
    });

    it('returns ISO when record.metadata.lastModified is a string', () => {
      const record = {
        id: 'r1',
        metadata: { lastModified: sampleIso },
      } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBe(sampleIso);
    });

    it('falls through to metadata when root.lastModified is undefined', () => {
      const record = {
        id: 'r1',
        // no root lastModified
        metadata: { lastModified: sampleDate },
      } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBe(sampleIso);
    });

    it('prefers root.lastModified over metadata.lastModified when both present', () => {
      const rootIso = '2026-05-12T10:00:00.000Z';
      const metaIso = '2026-05-12T20:00:00.000Z';
      const record = {
        id: 'r1',
        lastModified: rootIso,
        metadata: { lastModified: metaIso },
      } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBe(rootIso);
    });

    it('falls through to metadata when root.lastModified is an empty string', () => {
      const record = {
        id: 'r1',
        lastModified: '',
        metadata: { lastModified: sampleDate },
      } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBe(sampleIso);
    });
  });

  describe('null / missing / invalid edge cases', () => {
    it('returns null when no lastModified is present anywhere', () => {
      const record = { id: 'r1' } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBeNull();
    });

    it('returns null when metadata is not an object (defensive)', () => {
      const record = { id: 'r1', metadata: 'not-an-object' } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBeNull();
    });

    it('returns null when metadata is an array (isRecord guard)', () => {
      const record = { id: 'r1', metadata: [sampleIso] } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBeNull();
    });

    it('returns null when lastModified is a Date with NaN epoch (Invalid Date)', () => {
      const invalidDate = new Date('not-a-date');
      const record = { id: 'r1', lastModified: invalidDate } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBeNull();
    });

    it('returns null when lastModified is neither string nor Date (e.g., number)', () => {
      const record = { id: 'r1', lastModified: 1747059000000 } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBeNull();
    });

    it('returns null for null record-shaped input that somehow reaches us', () => {
      const record = { id: 'r1', lastModified: null } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBeNull();
    });
  });

  describe('strict timezone requirement on string inputs (Codex PR #777 R2)', () => {
    it('rejects bare-wall-clock string without TZ designator', () => {
      // `new Date('2026-05-12T10:00:00')` is interpreted as host-local time per
      // JS spec — host=UTC and host=America/New_York yield different epochs.
      // Strict-TZ rejection prevents writing a host-dependent snapshot.
      const record = { id: 'r1', lastModified: '2026-05-12T10:00:00' } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBeNull();
    });

    it('rejects date-only string (no time component, no TZ)', () => {
      const record = { id: 'r1', lastModified: '2026-05-12' } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBeNull();
    });

    it('accepts string with explicit +HH:MM offset (e.g., +05:30 India Standard Time)', () => {
      // 2026-05-12T15:30:00+05:30 corresponds to UTC 10:00:00
      const record = { id: 'r1', lastModified: '2026-05-12T15:30:00+05:30' } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBe('2026-05-12T10:00:00.000Z');
    });

    it('accepts string with explicit -HH:MM offset (e.g., -08:00 Pacific)', () => {
      // 2026-05-12T02:00:00-08:00 corresponds to UTC 10:00:00
      const record = { id: 'r1', lastModified: '2026-05-12T02:00:00-08:00' } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBe('2026-05-12T10:00:00.000Z');
    });

    it('accepts string with offset in HHMM form (no colon) — common in some NS exports', () => {
      // 2026-05-12T15:30:00+0530 — same instant as the colon-bearing form above
      const record = { id: 'r1', lastModified: '2026-05-12T15:30:00+0530' } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBe('2026-05-12T10:00:00.000Z');
    });

    it('rejects string with garbage where the TZ should be', () => {
      const record = { id: 'r1', lastModified: '2026-05-12T10:00:00GMT' } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBeNull();
    });

    it('falls through from non-TZ root to TZ-bearing metadata.lastModified Date', () => {
      // Root has a bare-wall-clock string (rejected), metadata has a Date
      // (always UTC-anchored by JS semantics) — should fall through and use
      // the Date.
      const record = {
        id: 'r1',
        lastModified: '2026-05-12T10:00:00',
        metadata: { lastModified: new Date('2026-05-12T20:00:00.000Z') },
      } as unknown as DataRecord;
      expect(extractRecordLastModifiedIso(record)).toBe('2026-05-12T20:00:00.000Z');
    });
  });
});
