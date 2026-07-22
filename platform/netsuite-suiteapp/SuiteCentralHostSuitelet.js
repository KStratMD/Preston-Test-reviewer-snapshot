/**
 * SuiteCentral embedded host Suitelet.
 *
 * Production rule: browser JavaScript never receives the raw SuiteCentral
 * embedded service token. This Suitelet calls SuiteCentral host-bootstrap
 * server-to-server via N/https and renders only the returned iframe src.
 *
 * Required script parameters (configured per deployment):
 *   custscript_sc_base_url        — SuiteCentral base URL
 *   custscript_sc_embedded_token  — server-side embedded service token
 *   custscript_sc_tenant_id       — SuiteCentral tenant identifier
 */
define(['N/https', 'N/runtime', 'N/ui/serverWidget'], function (https, runtime, serverWidget) {
  function getScriptParameter(name) {
    var value = runtime.getCurrentScript().getParameter({ name: name });
    if (!value) throw new Error('Missing required script parameter: ' + name);
    return String(value);
  }

  function normalizeBaseUrl(rawBaseUrl) {
    // Require https:// — the bootstrap POST below sends the embedded service
    // token in an Authorization: Bearer header, so a configured http:// value
    // would transmit it over plaintext. Hard-fail at the normalization
    // boundary so the misconfiguration cannot reach the https.post call.
    if (typeof rawBaseUrl !== 'string' || rawBaseUrl.indexOf('https://') !== 0) {
      throw new Error('SUITECENTRAL_BASE_URL must use https:// — refusing to send bearer token over plaintext');
    }
    // Strip a single trailing slash so a configured value like
    // 'https://host/' doesn't produce '//api/...' or '//modulePath?...'.
    // Mirrors the BC NormalizeBaseUrl AL procedure.
    return rawBaseUrl.replace(/\/$/, '');
  }

  function accountIdToHostSegment(accountId) {
    // NetSuite sandbox account IDs come through runtime.accountId as
    // '1234567_SB1' but URLs render the same account as '1234567-sb1'
    // (underscores are illegal in DNS hostnames). Without this normalization
    // expectedHostOrigin would not match window.origin in the browser and
    // postMessage origin validation would reject the host bootstrap.
    return accountId.toLowerCase().replace(/_/g, '-');
  }

  function onRequest(context) {
    var baseUrl = normalizeBaseUrl(getScriptParameter('custscript_sc_base_url'));
    var serviceToken = getScriptParameter('custscript_sc_embedded_token');
    var tenantId = getScriptParameter('custscript_sc_tenant_id');
    var platformAccountId = runtime.accountId;
    var hostOrigin = 'https://' + accountIdToHostSegment(runtime.accountId) + '.app.netsuite.com';

    var response = https.post({
      url: baseUrl + '/api/embedded/host-bootstrap',
      headers: {
        Authorization: 'Bearer ' + serviceToken,
        'Content-Type': 'application/json',
        'X-Embedded-Platform': 'netsuite',
      },
      body: JSON.stringify({
        tenantId: tenantId,
        platformAccountId: platformAccountId,
        expectedHostOrigin: hostOrigin,
      }),
    });

    if (response.code !== 200) {
      // Don't echo response.body — bootstrap errors can contain internal
      // detail (stack frames, tenant ids) and may be arbitrarily large.
      // The server-side log carries the full body; surface only HTTP status.
      throw new Error('SuiteCentral host-bootstrap failed with HTTP ' + response.code);
    }

    var payload;
    try {
      payload = JSON.parse(response.body);
    } catch (e) {
      // Without this guard, a non-JSON 200 response (proxy error page, HTML,
      // CDN intermediary, etc.) raises a raw SyntaxError that obscures the
      // bootstrap failure. Symmetric to the AL ResponseObject.ReadFrom guard.
      throw new Error('SuiteCentral host-bootstrap returned non-JSON response');
    }
    if (!payload || typeof payload.embedSrc !== 'string' || payload.embedSrc.charAt(0) !== '/') {
      throw new Error('SuiteCentral host-bootstrap returned an invalid embedSrc');
    }
    // embedSrc is a RELATIVE path from hostBootstrapRouter.ts (`/modulePath?embeddedContextId=...`).
    // Prefix with the normalized baseUrl so the iframe loads from the SuiteCentral
    // origin, not the NetSuite host's origin (which would 404 and would leak the
    // sessionId off-host). baseUrl is already trailing-slash-stripped at top.
    var absoluteSrc = baseUrl + payload.embedSrc;
    var form = serverWidget.createForm({ title: 'SuiteCentral' });
    var field = form.addField({
      id: 'custpage_suitecentral_iframe',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'SuiteCentral',
    });
    // sandbox is the canonical defense-in-depth around embedded content; the
    // attribute set mirrors integrations/netsuite/SuiteLet_Embed.js (the
    // existing NetSuite reference Suitelet) so the embedded SuiteCentral
    // module can run scripts, send forms, and open popups while the host
    // restricts navigation/top-level access. loading="lazy" matches the
    // same reference.
    field.defaultValue =
      '<iframe src="' + absoluteSrc.replace(/"/g, '&quot;') + '" ' +
      'sandbox="allow-scripts allow-same-origin allow-forms allow-popups" ' +
      'loading="lazy" ' +
      'style="width:100%;height:900px;border:0" title="SuiteCentral"></iframe>';
    context.response.writePage(form);
  }

  return { onRequest: onRequest };
});
