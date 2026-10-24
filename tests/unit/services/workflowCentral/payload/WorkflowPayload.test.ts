import {
  isWorkflowPayloadReference,
  isEphemeralWorkflowPayload,
  assertWorkflowPayloadReference,
  assertEphemeralWorkflowPayload,
  redactWorkflowPayloadForAudit,
} from '../../../../../src/services/workflowCentral/payload/WorkflowPayload';
import type {
  WorkflowExternalRecordReference,
  WorkflowPayloadReference,
  EphemeralWorkflowPayload,
} from '../../../../../src/services/workflowCentral/payload/WorkflowPayload';

const validRef: WorkflowExternalRecordReference = {
  system: 'netsuite',
  recordType: 'vendor',
  recordId: '12345',
  fieldsOfInterest: ['name', 'tax_id'],
};

const validReferencePayload: WorkflowPayloadReference = {
  mode: 'external_reference',
  references: [validRef],
};

const validEphemeralPayload: EphemeralWorkflowPayload = {
  mode: 'ephemeral_hosted',
  expiresAt: '2026-06-18T12:00:00Z',
  reason: 'AI-generated workflow, source-of-truth not yet in ERP',
  data: { vendorName: 'Acme', invoiceAmount: 25000 },
};

describe('isWorkflowPayloadReference', () => {
  it('accepts a well-formed external_reference payload', () => {
    expect(isWorkflowPayloadReference(validReferencePayload)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string', 'oops'],
    ['number', 42],
    ['empty object', {}],
    ['array (not object literal)', []],
  ])('rejects non-object %s', (_, v) => {
    expect(isWorkflowPayloadReference(v)).toBe(false);
  });

  it('rejects wrong mode', () => {
    expect(isWorkflowPayloadReference({ ...validReferencePayload, mode: 'ephemeral_hosted' })).toBe(false);
  });

  it('rejects references not an array', () => {
    expect(isWorkflowPayloadReference({ mode: 'external_reference', references: validRef })).toBe(false);
  });

  it('rejects ref with missing system', () => {
    const bad = { ...validRef } as Partial<WorkflowExternalRecordReference>;
    delete bad.system;
    expect(isWorkflowPayloadReference({ mode: 'external_reference', references: [bad] })).toBe(false);
  });

  it('rejects ref with system not in literal union', () => {
    expect(isWorkflowPayloadReference({
      mode: 'external_reference',
      references: [{ ...validRef, system: 'business_central' }],
    })).toBe(false);
  });

  it('rejects ref with missing recordType', () => {
    expect(isWorkflowPayloadReference({
      mode: 'external_reference',
      references: [{ system: 'netsuite', recordId: '12345' }],
    })).toBe(false);
  });

  it('rejects ref with empty recordType', () => {
    expect(isWorkflowPayloadReference({
      mode: 'external_reference',
      references: [{ system: 'netsuite', recordType: '', recordId: '12345' }],
    })).toBe(false);
  });

  it('rejects ref with non-string recordId', () => {
    expect(isWorkflowPayloadReference({
      mode: 'external_reference',
      references: [{ system: 'netsuite', recordType: 'vendor', recordId: 12345 }],
    })).toBe(false);
  });

  it('rejects ref with empty recordId', () => {
    expect(isWorkflowPayloadReference({
      mode: 'external_reference',
      references: [{ system: 'netsuite', recordType: 'vendor', recordId: '' }],
    })).toBe(false);
  });

  it('rejects ref with fieldsOfInterest containing non-string entries', () => {
    expect(isWorkflowPayloadReference({
      mode: 'external_reference',
      references: [{ ...validRef, fieldsOfInterest: ['name', 42] }],
    })).toBe(false);
  });

  it('rejects ref with fieldsOfInterest that is not an array', () => {
    expect(isWorkflowPayloadReference({
      mode: 'external_reference',
      references: [{ ...validRef, fieldsOfInterest: 'name' }],
    })).toBe(false);
  });

  it('accepts each system in the Phase 1 starter literal union', () => {
    for (const system of ['netsuite', 'businesscentral', 'salesforce', 'hubspot', 'shipstation', 'oracle'] as const) {
      expect(isWorkflowPayloadReference({
        mode: 'external_reference',
        references: [{ system, recordType: 'vendor', recordId: '1' }],
      })).toBe(true);
    }
  });
});

describe('isEphemeralWorkflowPayload', () => {
  it('accepts a well-formed ephemeral_hosted payload', () => {
    expect(isEphemeralWorkflowPayload(validEphemeralPayload)).toBe(true);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'oops'],
  ])('rejects non-object %s', (_, v) => {
    expect(isEphemeralWorkflowPayload(v)).toBe(false);
  });

  it('rejects wrong mode', () => {
    expect(isEphemeralWorkflowPayload({ ...validEphemeralPayload, mode: 'external_reference' })).toBe(false);
  });

  it('rejects missing expiresAt', () => {
    const bad = { ...validEphemeralPayload } as Partial<EphemeralWorkflowPayload>;
    delete bad.expiresAt;
    expect(isEphemeralWorkflowPayload(bad)).toBe(false);
  });

  it('rejects expiresAt that is not an ISO timestamp', () => {
    expect(isEphemeralWorkflowPayload({ ...validEphemeralPayload, expiresAt: '2026-06-18 noon' })).toBe(false);
    expect(isEphemeralWorkflowPayload({ ...validEphemeralPayload, expiresAt: 'tomorrow' })).toBe(false);
    expect(isEphemeralWorkflowPayload({ ...validEphemeralPayload, expiresAt: '2026/06/18' })).toBe(false);
  });

  it('rejects expiresAt that is not a string', () => {
    expect(isEphemeralWorkflowPayload({ ...validEphemeralPayload, expiresAt: 12345 })).toBe(false);
  });

  it('accepts ISO timestamps with milliseconds and timezone offsets', () => {
    expect(isEphemeralWorkflowPayload({ ...validEphemeralPayload, expiresAt: '2026-06-18T12:00:00.123Z' })).toBe(true);
    expect(isEphemeralWorkflowPayload({ ...validEphemeralPayload, expiresAt: '2026-06-18T12:00:00+02:00' })).toBe(true);
    expect(isEphemeralWorkflowPayload({ ...validEphemeralPayload, expiresAt: '2026-06-18T12:00:00.456-05:00' })).toBe(true);
  });

  it('rejects empty reason', () => {
    expect(isEphemeralWorkflowPayload({ ...validEphemeralPayload, reason: '' })).toBe(false);
  });

  it('rejects missing data', () => {
    const bad = { ...validEphemeralPayload } as Partial<EphemeralWorkflowPayload>;
    delete bad.data;
    expect(isEphemeralWorkflowPayload(bad)).toBe(false);
  });

  it('rejects data that is not an object', () => {
    expect(isEphemeralWorkflowPayload({ ...validEphemeralPayload, data: 'oops' })).toBe(false);
    expect(isEphemeralWorkflowPayload({ ...validEphemeralPayload, data: null })).toBe(false);
    expect(isEphemeralWorkflowPayload({ ...validEphemeralPayload, data: [] })).toBe(false);
  });
});

describe('assertWorkflowPayloadReference', () => {
  it('does not throw on valid input', () => {
    expect(() => assertWorkflowPayloadReference(validReferencePayload)).not.toThrow();
  });

  it('throws TypeError on invalid shape', () => {
    expect(() => assertWorkflowPayloadReference({ mode: 'external_reference', references: [] })).not.toThrow();
    expect(() => assertWorkflowPayloadReference({})).toThrow(TypeError);
    expect(() => assertWorkflowPayloadReference(null)).toThrow(TypeError);
  });
});

describe('assertEphemeralWorkflowPayload', () => {
  it('does not throw on valid input', () => {
    expect(() => assertEphemeralWorkflowPayload(validEphemeralPayload)).not.toThrow();
  });

  it('throws TypeError on missing expiresAt', () => {
    const bad = { ...validEphemeralPayload } as Partial<EphemeralWorkflowPayload>;
    delete bad.expiresAt;
    expect(() => assertEphemeralWorkflowPayload(bad)).toThrow(TypeError);
  });
});

describe('redactWorkflowPayloadForAudit', () => {
  it('emits the refs unchanged for external_reference payload (refs are not sensitive)', () => {
    const out = redactWorkflowPayloadForAudit(validReferencePayload);
    expect(out).toEqual({
      mode: 'external_reference',
      references: validReferencePayload.references,
      evaluationHints: undefined,
    });
  });

  it('preserves evaluationHints when present', () => {
    const withHints: WorkflowPayloadReference = {
      ...validReferencePayload,
      evaluationHints: { approvalThreshold: 10000, requireDualSignoff: true },
    };
    const out = redactWorkflowPayloadForAudit(withHints);
    expect(out.evaluationHints).toEqual({ approvalThreshold: 10000, requireDualSignoff: true });
  });

  it('emits {mode, expiresAt, reason} only for ephemeral_hosted — OMITS data (load-bearing)', () => {
    const out = redactWorkflowPayloadForAudit(validEphemeralPayload);
    expect(out).toEqual({
      mode: 'ephemeral_hosted',
      expiresAt: validEphemeralPayload.expiresAt,
      reason: validEphemeralPayload.reason,
    });
    // Stronger: even serialized, NO occurrence of any data value
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('Acme');
    expect(serialized).not.toContain('25000');
    expect(serialized).not.toContain('data');
  });

  it('redacts ephemeral data containing PII strings — never reaches audit JSON', () => {
    const payload: EphemeralWorkflowPayload = {
      mode: 'ephemeral_hosted',
      expiresAt: '2026-06-18T12:00:00Z',
      reason: 'cross-system compose',
      data: { ssn: '123-45-6789', email: 'employee@example.com', amount: 50000 },
    };
    const serialized = JSON.stringify(redactWorkflowPayloadForAudit(payload));
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).not.toContain('employee@example.com');
    expect(serialized).not.toContain('50000');
  });
});
