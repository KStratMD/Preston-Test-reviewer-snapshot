/**
 * Embedded ERP Surface — guest bootstrap.
 *
 * Loaded by every embedded module page inside the iframe. CSP-hashed:
 * any byte change here invalidates EMBEDDED_BOOTSTRAP_SHA256 in
 * src/middleware/embeddedCspMiddleware.ts and is caught by both the
 * pre-commit hook and CI gate (scripts/check-embedded-csp-hash.mjs).
 *
 * Re-stamp by running `npm run generate:embedded-csp`.
 */
(function () {
  'use strict';

  var url = new URL(window.location.href);
  var sessionId = url.searchParams.get('embeddedContextId');
  if (!sessionId) {
    document.documentElement.setAttribute('data-embedded-bootstrap', 'missing-session-id');
    return;
  }

  fetch('/api/embedded/context', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Embedded-Session-Id': sessionId
    },
    body: '{}'
  })
    .then(function (response) {
      if (response.status === 410) {
        window.location.assign('/embedded/session-expired.html');
        return null;
      }
      if (!response.ok) {
        throw new Error('context bootstrap failed: ' + response.status);
      }
      return response.json();
    })
    .then(function (context) {
      if (!context) return;
      window.__EMBEDDED_CONTEXT__ = context;
      document.documentElement.setAttribute('data-embedded-bootstrap', 'ready');
      var event = new CustomEvent('embedded:context-ready', { detail: context });
      window.dispatchEvent(event);
    })
    .catch(function (err) {
      document.documentElement.setAttribute('data-embedded-bootstrap', 'error');
      // eslint-disable-next-line no-console
      console.error('[embedded-bootstrap]', err);
    });

  window.addEventListener('pagehide', function () {
    // Beacon-style fire-and-forget DELETE. Native sendBeacon() can't be used
    // because (a) it sends POST not DELETE, and (b) it cannot set the
    // X-Embedded-Session-Id header that validateSessionTeardown requires.
    // fetch() with `keepalive: true` survives page unload in modern browsers
    // and is the documented replacement (Chrome, Edge, Firefox, Safari 15+).
    try {
      fetch('/api/embedded/sessions/' + encodeURIComponent(sessionId), {
        method: 'DELETE',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'X-Embedded-Session-Id': sessionId }
      }).catch(function () { /* best-effort; retention job catches misses */ });
    } catch (e) {
      // Best-effort; retention job catches missed teardowns.
    }
  });
})();
