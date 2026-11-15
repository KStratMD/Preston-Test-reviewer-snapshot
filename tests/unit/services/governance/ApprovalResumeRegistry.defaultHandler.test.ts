// ApprovalResumeRegistry.setDefault + fallback resolution (PR 13b Stage B).
//
// Tests the four behaviors introduced in Stage B:
//   1. setDefault registers a fallback handler for an operationType.
//   2. An exact (operationType, resourceType) match wins over the default.
//   3. Duplicate setDefault for the same operationType throws.
//   4. resolve() returns null when neither exact nor default handler exists.
//
// The existing exact-match + register() tests live in ApprovalResumeWorker.test.ts;
// this file is narrowly scoped to the setDefault / default-fallback contract.

import 'reflect-metadata';

import {
  ApprovalResumeRegistry,
  type ApprovalResumeHandler,
} from '../../../../src/services/governance/ApprovalResumeWorker';

function makeHandler(
  operationType: ApprovalResumeHandler['operationType'],
  resourceType: string,
): ApprovalResumeHandler {
  return {
    operationType,
    resourceType,
    apply: jest.fn().mockResolvedValue(undefined),
  };
}

describe('ApprovalResumeRegistry.setDefault (PR 13b Stage B)', () => {
  let registry: ApprovalResumeRegistry;

  beforeEach(() => {
    registry = new ApprovalResumeRegistry();
  });

  it('setDefault registers a fallback handler for the given operationType', () => {
    const handler = makeHandler('ownership_write', '*');
    registry.setDefault('ownership_write', handler);

    const resolved = registry.resolve('ownership_write', 'contact');
    expect(resolved).toBe(handler);
  });

  it('exact (operationType, resourceType) match wins over default fallback', () => {
    const fallback = makeHandler('ownership_write', '*');
    const exact = makeHandler('ownership_write', 'contact');

    registry.setDefault('ownership_write', fallback);
    registry.register(exact);

    const resolved = registry.resolve('ownership_write', 'contact');
    expect(resolved).toBe(exact);

    // A different resourceType still falls back to the default.
    const resolvedOther = registry.resolve('ownership_write', 'invoice');
    expect(resolvedOther).toBe(fallback);
  });

  it('duplicate setDefault for the same operationType throws', () => {
    const h1 = makeHandler('ownership_write', '*');
    const h2 = makeHandler('ownership_write', '*');

    registry.setDefault('ownership_write', h1);

    expect(() => registry.setDefault('ownership_write', h2)).toThrow(
      /duplicate setDefault.*ownership_write/i,
    );
  });

  it('resolve returns null when neither exact nor default handler matches', () => {
    // Register a default for a DIFFERENT operationType.
    const otherDefault = makeHandler('connector_write', '*');
    registry.setDefault('connector_write', otherDefault);

    // Resolve for 'ownership_write' should find nothing.
    const resolved = registry.resolve('ownership_write', 'contact');
    expect(resolved).toBeNull();
  });
});
