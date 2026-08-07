/**
 * Sync Error Triage — operator UI module (PR 17b; reskinned + outcome-aware
 * in the audit-remediation PR 2).
 *
 * Loaded inside the embedded iframe AFTER guest-bootstrap.js runs the context
 * fetch. The session id is the `embeddedContextId` URL parameter (same source
 * guest-bootstrap reads); we send it as `X-Embedded-Session-Id` on every
 * sync-error-assist API call.
 *
 * Action outcomes (accept/reject/escalate) render as dismissible banners via
 * EmbeddedUI (embedded-ui.js) with per-code copy — 409 already_dispositioned,
 * 503 connector_unavailable (retryable), 502 write_failed, etc. — instead of
 * the previous generic "<verb> failed: <code>" line. Reject/escalate use
 * inline validated forms (window.prompt retired).
 *
 * This module is served as an external script — no inline blocks, no CSP hash
 * regen needed. `script-src 'self'` covers it.
 */
(function () {
  'use strict';

  var sessionId = new URL(window.location.href).searchParams.get('embeddedContextId');
  var loadingEl = document.getElementById('loading');
  var noticesEl = document.getElementById('notices');

  if (!sessionId) {
    window.EmbeddedUI.renderNoSession(document.getElementById('main'), 'Sync Error Triage');
    return;
  }

  var headers = {
    'X-Embedded-Session-Id': sessionId,
    'Content-Type': 'application/json'
  };

  var escapeHtml = window.EmbeddedUI.escapeHtml;

  function showError(msg) {
    var el = document.getElementById('error');
    el.textContent = msg;
    el.hidden = false;
  }

  function clearError() {
    var el = document.getElementById('error');
    el.textContent = '';
    el.hidden = true;
  }

  function loadSuggestions() {
    loadingEl.hidden = false;
    document.getElementById('empty').hidden = true;
    document.getElementById('list').hidden = true;
    clearError();

    fetch('/api/sync-error-assist/suggestions', {
      headers: headers,
      credentials: 'same-origin'
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function (result) {
        loadingEl.hidden = true;
        if (!result.ok) {
          // Reuse the outcome copy for session/permission codes so a 403
          // reads as "open from the parent ERP", not a bare status number.
          var outcome = window.EmbeddedUI.describeOutcome('load',
            { ok: false, status: result.status, payload: result.body });
          showError(outcome.title + ' — ' + outcome.message);
          return;
        }
        var items = (result.body && result.body.items) || [];
        if (items.length === 0) {
          document.getElementById('empty').hidden = false;
          return;
        }
        renderList(items);
      })
      .catch(function () {
        loadingEl.hidden = true;
        showError('Network error loading suggestions.');
      });
  }

  function renderList(items) {
    var list = document.getElementById('list');
    list.innerHTML = '';
    items.forEach(function (item) {
      list.appendChild(renderCard(item));
    });
    list.hidden = false;
  }

  function confidenceTone(confidence) {
    if (confidence === 'high') return 'erp-badge-success';
    if (confidence === 'mid' || confidence === 'medium') return 'erp-badge-warning';
    if (confidence === 'low') return 'erp-badge-error';
    return 'erp-badge-neutral';
  }

  function renderCard(item) {
    var li = document.createElement('li');
    li.className = 'suggestion-card';
    if (item.confidence) {
      li.dataset.confidence = item.confidence;
    }
    var metadata = JSON.stringify({
      suggestionType: item.suggestionType,
      provider: item.providerUsed,
      traceId: item.reasoningTraceId,
      costUsdCents: item.costEstimateUsdCents
    }, null, 2);
    var costLine = [];
    if (item.providerUsed) costLine.push('Provider: ' + escapeHtml(item.providerUsed));
    if (typeof item.costEstimateUsdCents === 'number') costLine.push('AI cost: $' + (item.costEstimateUsdCents / 100).toFixed(4));
    if (item.reasoningTraceId) costLine.push('Trace: ' + escapeHtml(item.reasoningTraceId));

    li.innerHTML = [
      '<div><span class="erp-badge ' + confidenceTone(item.confidence) + '">' + escapeHtml(item.confidence || 'unknown') + ' confidence</span> ',
      '<strong>Error: </strong><code>' + escapeHtml(item.errorRecordId) + '</code></div>',
      '<p>' + escapeHtml(item.suggestionText || '(no suggestion text)') + '</p>',
      item.referencesField ? '<p class="meta">Field: <code>' + escapeHtml(item.referencesField) + '</code></p>' : '',
      costLine.length ? '<p class="meta">' + costLine.join(' &middot; ') + '</p>' : '',
      '<details><summary>Suggestion metadata</summary>',
      '<div class="pre-context">' + escapeHtml(metadata) + '</div></details>',
      '<div class="actions">',
      '<button type="button" class="erp-btn erp-btn-primary erp-btn-sm" data-act="accept">Accept&hellip;</button>',
      '<button type="button" class="erp-btn erp-btn-secondary erp-btn-sm" data-act="reject">Reject&hellip;</button>',
      '<button type="button" class="erp-btn erp-btn-ghost erp-btn-sm" data-act="escalate">Escalate&hellip;</button>',
      '</div>',
      '<form class="inline-form accept-form">',
      '<label>Apply action type<select name="type"><option value="create">create</option><option value="update">update</option></select></label>',
      '<label>Entity type<input name="entityType" placeholder="e.g. item, invoice"></label>',
      '<label>Record ID (update only)<input name="recordId" placeholder="leave blank for create"></label>',
      '<label>Payload / patch (JSON)<textarea name="payloadJson" rows="4">{}</textarea></label>',
      '<button type="submit" class="erp-btn erp-btn-primary erp-btn-sm">Approve &amp; write back</button>',
      '</form>',
      '<form class="inline-form reject-form">',
      '<label>Rejection reason (required)<textarea name="reason" rows="2" required></textarea></label>',
      '<button type="submit" class="erp-btn erp-btn-secondary erp-btn-sm">Confirm reject</button>',
      '</form>',
      '<form class="inline-form escalate-form">',
      '<label>Escalation note (required)<textarea name="note" rows="2" required></textarea></label>',
      '<button type="submit" class="erp-btn erp-btn-secondary erp-btn-sm">Confirm escalate</button>',
      '</form>'
    ].join('');

    function expandOnly(selector) {
      ['.accept-form', '.reject-form', '.escalate-form'].forEach(function (cls) {
        var form = li.querySelector(cls);
        if (cls === selector) {
          form.classList.add('expanded');
        } else {
          form.classList.remove('expanded');
        }
      });
    }

    li.querySelector('[data-act="accept"]').addEventListener('click', function () {
      expandOnly('.accept-form');
    });
    li.querySelector('[data-act="reject"]').addEventListener('click', function () {
      expandOnly('.reject-form');
    });
    li.querySelector('[data-act="escalate"]').addEventListener('click', function () {
      expandOnly('.escalate-form');
    });

    li.querySelector('.reject-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var reason = ev.target.elements['reason'].value.trim();
      if (!reason) return;
      postAction(item.errorRecordId, 'reject', { reason: reason });
    });

    li.querySelector('.escalate-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var note = ev.target.elements['note'].value.trim();
      if (!note) return;
      postAction(item.errorRecordId, 'escalate', { note: note });
    });

    li.querySelector('.accept-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var form = ev.target;
      var type = form.elements['type'].value;
      var entityType = form.elements['entityType'].value.trim();
      var recordId = form.elements['recordId'].value.trim();
      var payload;
      try {
        payload = JSON.parse(form.elements['payloadJson'].value);
      } catch (e) {
        window.EmbeddedUI.banner(noticesEl, {
          kind: 'error',
          title: 'Invalid JSON',
          message: 'The payload/patch must be valid JSON.'
        });
        return;
      }
      var applyAction = type === 'create'
        ? { type: type, entityType: entityType, payload: payload }
        : { type: type, entityType: entityType, recordId: recordId, patch: payload };
      postAction(item.errorRecordId, 'accept', { applyAction: applyAction });
    });

    return li;
  }

  function postAction(errorRecordId, verb, body) {
    clearError();
    fetch('/api/sync-error-assist/suggestions/' + encodeURIComponent(errorRecordId) + '/' + verb, {
      method: 'POST',
      headers: headers,
      credentials: 'same-origin',
      body: JSON.stringify(body)
    })
      .then(function (res) {
        return res.json().then(function (payload) {
          return { ok: res.ok, status: res.status, payload: payload };
        });
      })
      .then(function (result) {
        var outcome = window.EmbeddedUI.describeOutcome(verb, result);
        window.EmbeddedUI.banner(noticesEl, outcome, function retry() {
          postAction(errorRecordId, verb, body);
        });
        if (outcome.refresh) {
          loadSuggestions();
        }
      })
      .catch(function () {
        window.EmbeddedUI.banner(noticesEl, window.EmbeddedUI.networkOutcome(verb), function retry() {
          postAction(errorRecordId, verb, body);
        });
      });
  }

  loadSuggestions();
})();
