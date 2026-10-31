/**
 * Regression test for the Phase 1 backfill derivation logic (Phase 1 T13).
 *
 * Per feedback_backfill_tests_assert_source_of_truth — every derived field
 * is asserted, not just status + one. The DB-touching wrapper in
 * scripts/backfill-workflow-payload-refs.mjs is exercised end-to-end by
 * the integration tests (T17); pure logic lives here for fast feedback.
 */
import {
  deriveRef,
  ephemeralPayload,
  ALLOWED_SYSTEMS,
  EPHEMERAL_DAYS,
} from '../../../src/services/workflowCentral/payload/backfillDerivation';

describe('deriveRef (Phase 1 T13)', () => {
  it('derives a direct top-level triple', () => {
    expect(deriveRef({ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' }))
      .toEqual({ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' });
  });

  it('lowercases the system key', () => {
    expect(deriveRef({ system: 'NetSuite', recordType: 'vendor', recordId: 'V-1' }))
      .toEqual({ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' });
  });

  it('accepts NetSuite internalId / internal_id as recordId', () => {
    expect(deriveRef({ system: 'netsuite', recordType: 'vendor', internalId: '12345' }))
      .toEqual({ system: 'netsuite', recordType: 'vendor', recordId: '12345' });
    expect(deriveRef({ system: 'netsuite', recordType: 'vendor', internal_id: '12345' }))
      .toEqual({ system: 'netsuite', recordType: 'vendor', recordId: '12345' });
  });

  it('accepts record_type / entity_type snake-case keys', () => {
    expect(deriveRef({ system: 'netsuite', record_type: 'vendor', recordId: 'V-1' }))
      .toEqual({ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' });
    expect(deriveRef({ system: 'businesscentral', entity_type: 'salesOrder', recordId: 'SO-1' }))
      .toEqual({ system: 'businesscentral', recordType: 'salesOrder', recordId: 'SO-1' });
  });

  it('accepts connector / platform alias for system', () => {
    expect(deriveRef({ connector: 'netsuite', recordType: 'vendor', recordId: 'V-1' }))
      .toEqual({ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' });
    expect(deriveRef({ platform: 'salesforce', recordType: 'opportunity', recordId: 'O-1' }))
      .toEqual({ system: 'salesforce', recordType: 'opportunity', recordId: 'O-1' });
  });

  it('recurses into _ref / Ref suffixes', () => {
    expect(deriveRef({ vendor_ref: { system: 'netsuite', recordType: 'vendor', recordId: 'V-1' } }))
      .toEqual({ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' });
    expect(deriveRef({ recordRef: { system: 'businesscentral', recordType: 'salesOrder', recordId: 'SO-1' } }))
      .toEqual({ system: 'businesscentral', recordType: 'salesOrder', recordId: 'SO-1' });
  });

  it('rejects unknown system', () => {
    expect(deriveRef({ system: 'unknown', recordType: 'vendor', recordId: 'V-1' })).toBeNull();
  });

  it('rejects when recordType missing', () => {
    expect(deriveRef({ system: 'netsuite', recordId: 'V-1' })).toBeNull();
  });

  it('rejects when recordId missing', () => {
    expect(deriveRef({ system: 'netsuite', recordType: 'vendor' })).toBeNull();
  });

  it('rejects when recordId is empty string', () => {
    expect(deriveRef({ system: 'netsuite', recordType: 'vendor', recordId: '' })).toBeNull();
  });

  it('rejects array / null / non-object', () => {
    expect(deriveRef([])).toBeNull();
    expect(deriveRef(null)).toBeNull();
    expect(deriveRef('not-an-object')).toBeNull();
    expect(deriveRef(42)).toBeNull();
  });

  it('returns null when nothing matches anywhere in the object', () => {
    expect(deriveRef({ poNumber: 'PO-1', amount: 1000, vendor: 'Acme' })).toBeNull();
  });

  it('REJECTS bare `id` as recordId — too ambiguous (Codex R3 P2 lock)', () => {
    // `id` could be workflow ID, task ID, instance ID, etc. — not the
    // external-system record ID. Both the .mjs and .ts modules reject it;
    // this test locks the parity so future drift trips immediately.
    expect(deriveRef({ system: 'netsuite', recordType: 'vendor', id: 'V-1' })).toBeNull();
  });

  it('ALLOWED_SYSTEMS matches the Phase 1 starter union exactly', () => {
    expect([...ALLOWED_SYSTEMS].sort()).toEqual(
      ['businesscentral', 'hubspot', 'netsuite', 'oracle', 'salesforce', 'shipstation'],
    );
  });
});

describe('ephemeralPayload (Phase 1 T13)', () => {
  it('emits mode + reason + future expiresAt + empty data', () => {
    const out = ephemeralPayload('legacy-row-no-derivable-ref');
    expect(out.mode).toBe('ephemeral_hosted');
    expect(out.reason).toBe('legacy-row-no-derivable-ref');
    expect(typeof out.expiresAt).toBe('string');
    expect(Date.parse(out.expiresAt)).toBeGreaterThan(Date.now());
    expect(out.data).toEqual({});
  });

  it('expiresAt is EPHEMERAL_DAYS in the future', () => {
    const before = Date.now();
    const out = ephemeralPayload('test');
    const after = Date.now();
    const expiry = Date.parse(out.expiresAt);
    expect(expiry).toBeGreaterThanOrEqual(before + EPHEMERAL_DAYS * 86_400_000 - 1000);
    expect(expiry).toBeLessThanOrEqual(after + EPHEMERAL_DAYS * 86_400_000 + 1000);
  });

  it('every call with no originalData produces an independent empty data object', () => {
    const a = ephemeralPayload('A');
    const b = ephemeralPayload('B');
    (a.data as Record<string, unknown>).injected = 'should-not-leak';
    expect(b.data).toEqual({});
  });

  it('preserves originalData when provided (Codex P4 — render equivalence for non-derivable rows)', () => {
    const original = { poNumber: 'PO-LEGACY', amount: 1234 };
    const out = ephemeralPayload('legacy-row-no-derivable-ref', original);
    expect(out.data).toEqual({ poNumber: 'PO-LEGACY', amount: 1234 });
  });

  it('rejects non-object originalData and falls back to empty {}', () => {
    expect(ephemeralPayload('x', null).data).toEqual({});
    expect(ephemeralPayload('x', undefined).data).toEqual({});
    expect(ephemeralPayload('x', 'string').data).toEqual({});
    expect(ephemeralPayload('x', 42).data).toEqual({});
    expect(ephemeralPayload('x', [1, 2]).data).toEqual({});
  });
});
