/**
 * Task 4 follow-up (2026-07-27 NetSuite serialized-asset sync plan).
 *
 * `connectorRegistry.ts`'s `export const CONNECTOR_REGISTRY = [...]` array
 * literal reads `classRef: SalesforceConnector` EAGERLY at module-top-level
 * scope (line ~300) — not lazily inside a function. If `SalesforceConnector.ts`
 * ever imports (directly or transitively) anything that imports
 * `connectorRegistry.ts` back, and `SalesforceConnector.ts` happens to be the
 * FIRST module required in a given process/module-registry, the resulting
 * circular require permanently bakes `classRef: undefined` into the
 * salesforce entry: `connectorRegistry.ts`'s own body (including the
 * `CONNECTOR_REGISTRY` literal) resumes and finishes BEFORE control ever
 * returns to `SalesforceConnector.ts`'s own module body (which is what
 * actually assigns `exports.SalesforceConnector`), so the property read
 * happens on a still-empty exports object. No throw, no warning — it is
 * simply `undefined` forever in that module registry.
 *
 * `connectorRegistry.test.ts`'s existing `classRef wires up the actual
 * connector class` block (line ~147) cannot catch this: that file imports
 * `connectorRegistry.ts` FIRST, making `connectorRegistry` (not
 * `SalesforceConnector`) the cycle's entry point, and the eager-read hazard
 * only manifests when `SalesforceConnector` is the entry.
 *
 * `netsuite` is the control: `NetSuiteConnector.ts` has no such back-edge, so
 * its `classRef` must resolve to a function regardless of require order.
 */
describe('connectorRegistry classRef resolution when SalesforceConnector is required first', () => {
  it('resolves a real function classRef for salesforce (and the netsuite control) in a fresh module registry entered via SalesforceConnector', () => {
    let salesforceClassRef: unknown;
    let netsuiteClassRef: unknown;

    jest.isolateModules(() => {
      // Entry point: require SalesforceConnector BEFORE connectorRegistry,
      // mirroring the reviewer's probe exactly.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../src/connectors/SalesforceConnector');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { CONNECTOR_REGISTRY } = require('../../../src/connectors/connectorRegistry');

      const salesforceEntry = CONNECTOR_REGISTRY.find((entry: { key: string }) => entry.key === 'salesforce');
      const netsuiteEntry = CONNECTOR_REGISTRY.find((entry: { key: string }) => entry.key === 'netsuite');
      salesforceClassRef = salesforceEntry?.classRef;
      netsuiteClassRef = netsuiteEntry?.classRef;
    });

    expect(typeof netsuiteClassRef).toBe('function');
    expect(typeof salesforceClassRef).toBe('function');
  });
});
