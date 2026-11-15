/**
 * Salesforce field API name shape (Task 1, extracted as its own leaf module
 * in Task 4's fix-up). Deliberately has ZERO imports of its own: this
 * constant is consumed by both `SerializedAssetProfileValidator.ts` (which
 * transitively depends on `connectorRegistry.ts` via `connectorIdentity.ts`)
 * and `SalesforceConnector.ts` (which `connectorRegistry.ts` imports
 * directly for its factory-wired registry entry). Importing the pattern
 * FROM `SerializedAssetProfileValidator.ts` into `SalesforceConnector.ts`
 * closed a cycle back through `connectorRegistry.ts` — harmless when
 * `connectorRegistry.ts` happens to be required first, but silently baked a
 * permanent `classRef: undefined` into the registry's `salesforce` entry
 * whenever `SalesforceConnector.ts` was the first module required in a
 * given module registry (`connectorRegistry.ts`'s `CONNECTOR_REGISTRY` array
 * literal reads `classRef: SalesforceConnector` EAGERLY at module-top-level
 * scope, not lazily inside a function, so the circular require resolved to
 * the still-empty exports object). A leaf module has no path back to
 * `connectorRegistry.ts` at all, so importing it can never create a cycle.
 * See `tests/unit/connectors/salesforceConnectorRegistryCycle.test.ts` for
 * the regression proof.
 */
export const SALESFORCE_FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;
