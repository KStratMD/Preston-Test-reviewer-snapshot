/**
 * Record Lineage — operator UI module.
 *
 * Loaded inside the embedded iframe AFTER guest-bootstrap.js. The session id
 * is the `embeddedContextId` URL parameter (same source guest-bootstrap reads);
 * we send it as `X-Embedded-Session-Id` on every lineage API call.
 *
 * URL params consumed:
 *   - embeddedContextId: required (read by guest-bootstrap).
 *   - system, entityType, entityId: optional. When all three are present the
 *     form auto-submits on load. Otherwise the operator types them in.
 *
 * This module is served as an external script — no inline blocks, no CSP hash
 * regen needed. `script-src 'self'` covers it.
 */
(function () {
  'use strict';

  var url = new URL(window.location.href);
  var sessionId = url.searchParams.get('embeddedContextId');
  var loadingEl = document.getElementById('loading');
  var emptyEl = document.getElementById('empty');
  var errorEl = document.getElementById('error');
  var eventsEl = document.getElementById('events');
  var systemInput = document.getElementById('system-input');
  var entityTypeInput = document.getElementById('entity-type-input');
  var entityIdInput = document.getElementById('entity-id-input');
  var btn = document.getElementById('lookup-btn');

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  if (!sessionId) {
    showError('No embedded session — open this page from the parent ERP shell.');
    btn.disabled = true;
    return;
  }

  var headers = {
    'X-Embedded-Session-Id': sessionId,
    'Content-Type': 'application/json'
  };

  function renderTypeSpecific(e) {
    if (e.eventType === 'source_read') {
      var sourceTriple = [e.sourceSystem, e.sourceEntityType, e.sourceEntityId]
        .filter(function (v) { return v != null && String(v).length > 0; })
        .map(escapeHtml).join(' / ');
      return sourceTriple
        ? '<div>source: <code>' + sourceTriple + '</code></div>'
        : '';
    }
    if (e.eventType === 'transform' && e.payloadHash) {
      return '<div>payloadHash: <code>' + escapeHtml(e.payloadHash) + '</code></div>';
    }
    if (e.eventType === 'governance_decision' && e.governanceResult) {
      return '<div>result: <strong>' + escapeHtml(e.governanceResult) + '</strong></div>';
    }
    if (e.eventType === 'target_write') {
      var targetTriple = [e.targetSystem, e.targetEntityType, e.targetEntityId]
        .filter(function (v) { return v != null && String(v).length > 0; })
        .map(escapeHtml).join(' / ');
      return targetTriple
        ? '<div>target: <code>' + targetTriple + '</code></div>'
        : '';
    }
    return '';
  }

  function render(events) {
    eventsEl.innerHTML = '';
    if (events.length === 0) {
      emptyEl.hidden = false;
      eventsEl.hidden = true;
      return;
    }
    emptyEl.hidden = true;
    events.forEach(function (e) {
      var li = document.createElement('li');
      li.className = 'event';
      li.setAttribute('data-type', e.eventType || '');
      var label = String(e.eventType || '').replace(/_/g, ' ');
      var metaParts = [];
      if (e.correlationId) metaParts.push('corr ' + e.correlationId);
      if (e.templateId) metaParts.push('template ' + e.templateId);
      if (e.occurredAt) metaParts.push('at ' + e.occurredAt);
      li.innerHTML =
        '<div><span class="badge">' + escapeHtml(label) + '</span>'
        + '<span class="sequence">#' + escapeHtml(String(e.sequence != null ? e.sequence : '?')) + '</span></div>'
        + renderTypeSpecific(e)
        + (metaParts.length > 0
          ? '<div class="meta">' + escapeHtml(metaParts.join(' · ')) + '</div>'
          : '');
      eventsEl.appendChild(li);
    });
    eventsEl.hidden = false;
  }

  function loadChain(system, entityType, entityId) {
    loadingEl.hidden = false;
    emptyEl.hidden = true;
    eventsEl.hidden = true;
    eventsEl.innerHTML = '';
    clearError();

    var path = '/api/embedded/lineage/records/'
      + encodeURIComponent(system) + '/'
      + encodeURIComponent(entityType) + '/'
      + encodeURIComponent(entityId);

    fetch(path, { headers: headers, credentials: 'same-origin' })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, status: res.status, body: body };
        }, function () {
          return { ok: res.ok, status: res.status, body: null };
        });
      })
      .then(function (response) {
        loadingEl.hidden = true;
        if (!response.ok) {
          var detail = response.body && response.body.error
            ? ' — ' + response.body.error
            : '';
          showError('Lookup failed: HTTP ' + response.status + detail);
          return;
        }
        var events = (response.body && Array.isArray(response.body.events))
          ? response.body.events
          : [];
        render(events);
      })
      .catch(function (err) {
        loadingEl.hidden = true;
        showError('Lookup failed: ' + (err && err.message ? err.message : String(err)));
      });
  }

  btn.addEventListener('click', function () {
    var system = systemInput.value.trim();
    var entityType = entityTypeInput.value.trim();
    var entityId = entityIdInput.value.trim();
    if (!system || !entityType || !entityId) {
      showError('All three fields are required.');
      return;
    }
    loadChain(system, entityType, entityId);
  });

  // Auto-lookup if all three params are in the URL.
  var qSystem = url.searchParams.get('system');
  var qEntityType = url.searchParams.get('entityType');
  var qEntityId = url.searchParams.get('entityId');
  if (qSystem && qEntityType && qEntityId) {
    systemInput.value = qSystem;
    entityTypeInput.value = qEntityType;
    entityIdInput.value = qEntityId;
    loadChain(qSystem, qEntityType, qEntityId);
  }
})();
