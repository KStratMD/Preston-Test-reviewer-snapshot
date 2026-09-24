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
 *
 * Per-employee grant enrolment (optional; see
 * docs/runbooks/embedded-user-assertion-producers.md):
 *   custentity_sc_grant_id    — the embedded_role_grants id issued to this user
 *   custentity_sc_grant_guid  — the credential GUID for that grant's secret
 *
 * When BOTH are present on the current user's employee record, this Suitelet
 * signs a user assertion so SuiteCentral can mark the session squire_verified
 * and activate that grant's role. When either is absent it sends the user id
 * alone and the session stays host_asserted — which activates nothing. That is
 * the safe default: a missing enrolment must never look like a verified one.
 *
 * The secret never reaches this script or the browser. N/crypto resolves the
 * credential GUID internally, so the Suitelet signs without ever holding the
 * plaintext.
 */
define([
  'N/https',
  'N/runtime',
  'N/ui/serverWidget',
  'N/crypto',
  'N/encode',
  'N/search',
], function (https, runtime, serverWidget, crypto, encode, search) {
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

  /**
   * The material SuiteCentral signs, byte for byte.
   *
   * MUST match assertionMaterial() in src/embedded/userAssertion.ts. Kept free
   * of every NetSuite API so the Node conformance suite can extract this
   * function and run it directly — the field order and delimiter are then
   * verified in CI rather than assumed.
   */
  function buildAssertionMaterial(grantId, tenantId, platform, platformAccountId, userId, ts, nonce) {
    return [grantId, tenantId, platform, platformAccountId, userId, String(ts), nonce].join('|');
  }

  /**
   * Assemble the header. Lowercased because SuiteCentral compares the hex in
   * constant time against a lowercase digest, and an uppercase hex string is a
   * silent mismatch rather than an error. Also pure, for the same reason.
   */
  function buildAssertionHeader(grantId, ts, nonce, hmacHex) {
    return 'v1.' + grantId + '.' + String(ts) + '.' + nonce + '.' + String(hmacHex).toLowerCase();
  }

  /**
   * Read the current user's grant enrolment.
   *
   * Returns null unless BOTH fields are present: a grant id without its
   * credential cannot be signed for, and a credential without its grant id has
   * nothing to name. Either half alone is a half-finished enrolment, and
   * treating it as usable would produce assertions SuiteCentral rejects with no
   * indication why.
   */
  function readGrantEnrolment(employeeId) {
    var lookup = search.lookupFields({
      type: search.Type.EMPLOYEE,
      id: employeeId,
      columns: ['custentity_sc_grant_id', 'custentity_sc_grant_guid'],
    });
    var grantId = lookup.custentity_sc_grant_id;
    var grantGuid = lookup.custentity_sc_grant_guid;
    if (!grantId || !grantGuid) return null;
    return { grantId: String(grantId), grantGuid: String(grantGuid) };
  }

  function onRequest(context) {
    var baseUrl = normalizeBaseUrl(getScriptParameter('custscript_sc_base_url'));
    var serviceToken = getScriptParameter('custscript_sc_embedded_token');
    var tenantId = getScriptParameter('custscript_sc_tenant_id');
    var platformAccountId = runtime.accountId;
    var hostOrigin = 'https://' + accountIdToHostSegment(runtime.accountId) + '.app.netsuite.com';

    // The Suitelet runs AS the current user, so this is the identity SuiteCentral
    // scopes the grant to. Sent even without an enrolment: it tells the guest UI
    // who is looking, which is display information and confers nothing.
    var currentUser = runtime.getCurrentUser();
    var userId = String(currentUser.id);

    var headers = {
      Authorization: 'Bearer ' + serviceToken,
      'Content-Type': 'application/json',
      'X-Embedded-Platform': 'netsuite',
    };

    var enrolment = readGrantEnrolment(currentUser.id);
    if (enrolment !== null) {
      // 18 bytes -> 24 base64url characters, comfortably inside SuiteCentral's
      // 22..128 bound. randomBytes is a CSPRNG; a predictable nonce would let
      // someone spend a legitimate user's nonce before they do, which is a
      // denial of service rather than a forgery, but there is no reason to
      // accept it.
      var nonce = encode
        .convert({
          string: crypto.random.generateBytes({ size: 18 }),
          inputEncoding: encode.Encoding.UTF_8,
          outputEncoding: encode.Encoding.BASE_64_URL_SAFE,
        })
        .replace(/=+$/, '');
      var ts = Math.floor(Date.now() / 1000);
      var material = buildAssertionMaterial(
        enrolment.grantId, tenantId, 'netsuite', platformAccountId, userId, ts, nonce,
      );

      // The ONLY step this repository cannot verify. N/crypto resolves the
      // credential GUID to the secret internally, so the plaintext never
      // appears here — but whether that produces the same HMAC-SHA256 as Node
      // must be confirmed against the published conformance vector before the
      // first real grant is issued. See the runbook.
      var secretKey = crypto.createSecretKey({
        guid: enrolment.grantGuid,
        encoding: encode.Encoding.UTF_8,
      });
      var hmac = crypto.createHmac({ algorithm: crypto.HashAlg.SHA256, key: secretKey });
      hmac.update({ input: material, inputEncoding: encode.Encoding.UTF_8 });
      var hmacHex = hmac.digest({ outputEncoding: encode.Encoding.HEX });

      headers['X-Squire-User-Assertion'] = buildAssertionHeader(
        enrolment.grantId, ts, nonce, hmacHex,
      );
    }

    var response = https.post({
      url: baseUrl + '/api/embedded/host-bootstrap',
      headers: headers,
      body: JSON.stringify({
        tenantId: tenantId,
        platformAccountId: platformAccountId,
        expectedHostOrigin: hostOrigin,
        userId: userId,
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
