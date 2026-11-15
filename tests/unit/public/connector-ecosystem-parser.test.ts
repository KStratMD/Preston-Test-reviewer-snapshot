/**
 * Unit tests for the connector-ecosystem JSON-island parser.
 *
 * The module under test is plain browser JS with a CommonJS export guard, so
 * it loads directly into jest's node environment — no jsdom needed (the
 * function is pure: string → array, no DOM access).
 *
 * Fixtures are INLINE synthetic HTML — this test must NOT read
 * public/connector-ecosystem.html from disk, because the reviewer-mirror
 * reproducibility gate flags mirror-shipped tests whose literal file deps are
 * excluded from the mirror (see scripts/check-mirror-reproducibility.mjs).
 */
const { parseConnectorsFromEcosystemHTML } = require('../../../public/connector-ecosystem-parser.js');

// Minimal valid island embedded in a realistic HTML wrapper
const MINIMAL_ISLAND_HTML = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
<script type="application/json" id="connector-ecosystem-data">{"connectors": [{"id": "netsuite", "name": "NetSuite", "category": "ERP Systems", "categoryId": "erp", "dataTypes": ["Customers", "Orders"], "authTypes": ["OAuth 1.0"]}, {"id": "sap", "name": "SAP ERP", "category": "ERP Systems", "categoryId": "erp", "dataTypes": ["Materials"], "authTypes": ["RFC"]}]}</script>
<script>function x() { var connectors = [{ id: 'old', name: 'old' }]; }</script>
</body>
</html>`;

// Island with malformed JSON
const MALFORMED_JSON_HTML = `<!DOCTYPE html>
<html>
<body>
<script type="application/json" id="connector-ecosystem-data">{connectors: [INVALID]}</script>
</body>
</html>`;

// Page with no data island at all (old format / no island)
const NO_ISLAND_HTML = `<!DOCTYPE html>
<html>
<body>
<script>
function connectorEcosystem() {
  return {
    connectors: [
      { id: 'netsuite', name: 'NetSuite', dataTypes: ['Customers', 'Orders'] },
    ],
  };
}
</script>
</body>
</html>`;

// Old-style inline-JS shape with connectors: [...] object literal (no island).
// The old eval-based parser targeted this format; the new parser must ignore it.
const OLD_STYLE_INLINE_JS_HTML = `<!DOCTYPE html>
<html>
<body>
<script>
var connectorData = {
  connectors: [
    { id: 'netsuite', name: 'NetSuite', dataTypes: ['Customers', 'Orders'] },
    { id: 'salesforce', name: 'Salesforce', dataTypes: ['Contacts', 'Leads'] },
  ],
};
</script>
</body>
</html>`;

// Island with correct outer structure but connectors is not an array
const WRONG_SHAPE_HTML = `<!DOCTYPE html>
<html>
<body>
<script type="application/json" id="connector-ecosystem-data">{"connectors": "not-an-array"}</script>
</body>
</html>`;

// Island wrapped in more realistic head script block surroundings to verify
// the regex does not cross-match the outer Alpine <script> block
const REALISTIC_MULTIENTRY_HTML = `<!DOCTYPE html>
<html>
<head>
<script src="enhanced-back-navigation.js"></script>
</head>
<body>
<script type="application/json" id="connector-ecosystem-data">{"connectors": [{"id": "netsuite", "name": "NetSuite", "category": "ERP Systems", "categoryId": "erp", "color": "bg-blue-100", "status": "sandbox-only", "dataTypes": ["Customers", "Orders", "Invoices", "Items", "Vendors"], "syncType": "Real-time bidirectional", "authTypes": ["OAuth 1.0", "Token-based"], "setupTime": "15 minutes", "sandboxId": "TSTDRV2698307"}, {"id": "sap", "name": "SAP ERP", "category": "ERP Systems", "categoryId": "erp", "color": "bg-blue-100", "status": "fixture", "dataTypes": ["Materials", "Purchase Orders", "Sales Orders", "Financial Data"], "syncType": "Demo mode + Real-time", "authTypes": ["RFC", "REST API", "OData"], "setupTime": "5 minutes (demo) / 30 minutes (production)", "demoMode": true}, {"id": "businesscentral", "name": "Microsoft Business Central", "category": "ERP Systems", "categoryId": "erp", "color": "bg-blue-100", "status": "fixture", "dataTypes": ["Orders", "Invoices", "Inventory"], "syncType": "Fixture-based testing", "authTypes": ["OAuth 2.0", "Basic Auth"], "setupTime": "5 minutes (fixture mode)"}]}</script>
<script>
function connectorEcosystem() {
  return { selectedCategory: 'all', connectors: [] };
}
</script>
</body>
</html>`;

describe('connector-ecosystem-parser.js', () => {
  describe('parseConnectorsFromEcosystemHTML', () => {
    it('returns a non-empty array from a minimal valid island', () => {
      const result = parseConnectorsFromEcosystemHTML(MINIMAL_ISLAND_HTML);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
    });

    it('returns the correct connector ids from the island', () => {
      const result = parseConnectorsFromEcosystemHTML(MINIMAL_ISLAND_HTML);
      expect(result[0].id).toBe('netsuite');
      expect(result[1].id).toBe('sap');
    });

    it('preserves nested array fields (dataTypes, authTypes)', () => {
      const result = parseConnectorsFromEcosystemHTML(MINIMAL_ISLAND_HTML);
      expect(Array.isArray(result[0].dataTypes)).toBe(true);
      expect(result[0].dataTypes).toContain('Customers');
      expect(Array.isArray(result[0].authTypes)).toBe(true);
    });

    it('returns [] for malformed JSON in the island', () => {
      const result = parseConnectorsFromEcosystemHTML(MALFORMED_JSON_HTML);
      expect(result).toEqual([]);
    });

    it('returns [] when there is no data island in the page', () => {
      const result = parseConnectorsFromEcosystemHTML(NO_ISLAND_HTML);
      expect(result).toEqual([]);
    });

    it('returns [] when the island connectors field is not an array', () => {
      const result = parseConnectorsFromEcosystemHTML(WRONG_SHAPE_HTML);
      expect(result).toEqual([]);
    });

    it('returns [] for a non-string argument', () => {
      expect(parseConnectorsFromEcosystemHTML(null as unknown as string)).toEqual([]);
      expect(parseConnectorsFromEcosystemHTML(undefined as unknown as string)).toEqual([]);
      expect(parseConnectorsFromEcosystemHTML(42 as unknown as string)).toEqual([]);
    });

    it('returns [] for an empty string', () => {
      expect(parseConnectorsFromEcosystemHTML('')).toEqual([]);
    });

    it('parses successfully when id attribute appears before type attribute', () => {
      // Regression guard: the regex must match regardless of attribute order.
      const swappedAttrHtml = `<!DOCTYPE html>
<html>
<body>
<script id="connector-ecosystem-data" type="application/json">{"connectors": [{"id": "netsuite", "name": "NetSuite"}]}</script>
</body>
</html>`;
      const result = parseConnectorsFromEcosystemHTML(swappedAttrHtml);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('netsuite');
    });

    it('does not match the old eval-style connectors: [...] JS block', () => {
      // The old parser targeted `connectors: [...]` in a JS object literal.
      // The new parser must ignore that shape and return [] — only the JSON
      // data island triggers a non-empty result.
      const result = parseConnectorsFromEcosystemHTML(OLD_STYLE_INLINE_JS_HTML);
      expect(result).toEqual([]);
    });

    it('correctly parses all connector fields from a multi-entry realistic island', () => {
      const result = parseConnectorsFromEcosystemHTML(REALISTIC_MULTIENTRY_HTML);
      expect(result.length).toBe(3);

      const netsuite = result.find((c: {id: string}) => c.id === 'netsuite');
      expect(netsuite).toBeDefined();
      expect(netsuite.name).toBe('NetSuite');
      expect(netsuite.sandboxId).toBe('TSTDRV2698307');
      expect(netsuite.dataTypes).toEqual(['Customers', 'Orders', 'Invoices', 'Items', 'Vendors']);
      expect(netsuite.authTypes).toEqual(['OAuth 1.0', 'Token-based']);

      const sap = result.find((c: {id: string}) => c.id === 'sap');
      expect(sap).toBeDefined();
      expect(sap.demoMode).toBe(true);

      const bc = result.find((c: {id: string}) => c.id === 'businesscentral');
      expect(bc).toBeDefined();
    });
  });
});
