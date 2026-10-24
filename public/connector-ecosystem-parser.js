/**
 * Connector ecosystem parser — extracts the connectors list from the JSON
 * data island embedded in public/connector-ecosystem.html.
 *
 * Island shape (added to connector-ecosystem.html):
 *   <script type="application/json" id="connector-ecosystem-data">
 *     {"connectors": [...]}
 *   </script>
 *
 * The parser works in plain Node (no DOM, no eval) so the jest unit test
 * (tests/unit/public/connector-ecosystem-parser.test.ts) can require this
 * file directly without a jsdom environment.
 *
 * Exposed as:
 *   - window.ConnectorEcosystemParser.parseConnectorsFromEcosystemHTML  (browser)
 *   - module.exports.parseConnectorsFromEcosystemHTML                   (Node / jest)
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ConnectorEcosystemParser = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /**
   * Extract the connectors array from an HTML string containing the JSON
   * data island with id="connector-ecosystem-data".
   *
   * @param {string} html  Full HTML source of connector-ecosystem.html
   * @returns {Array}      Parsed connectors array, or [] on any failure
   *                       (missing island, malformed JSON, wrong shape).
   */
  function parseConnectorsFromEcosystemHTML(html) {
    if (typeof html !== 'string' || html.length === 0) {
      return [];
    }

    // Match the JSON data island by its unique id — attribute order is
    // intentionally ignored so <script id=… type=…> and <script type=… id=…>
    // both match.  The regex avoids </script> inside strings by relying on the
    // island contract: JSON values must not contain the literal sequence
    // </script> (if they did they would need to be escaped as <\/script>).
    var ISLAND_RE = /<script[^>]*id=["']connector-ecosystem-data["'][^>]*>([\s\S]*?)<\/script>/;
    var match = ISLAND_RE.exec(html);
    if (!match) {
      return [];
    }

    var jsonText = match[1];
    var parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (_e) {
      return [];
    }

    if (!parsed || !Array.isArray(parsed.connectors)) {
      return [];
    }

    return parsed.connectors;
  }

  return { parseConnectorsFromEcosystemHTML: parseConnectorsFromEcosystemHTML };
});
