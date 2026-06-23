/**
 * Reconciliation Center — embedded operator UI module (#862 follow-up c).
 *
 * Loaded inside the iframe AFTER guest-bootstrap.js runs the context fetch. The
 * session id is the `embeddedContextId` URL parameter (same source
 * guest-bootstrap reads); we send it as `X-Embedded-Session-Id` on every
 * /api/embedded/reconciliation call.
 *
 * v1 lists OPEN exceptions and resolves them (the service is open-only today).
 * Served as an external script — no inline blocks, no CSP hash regen needed;
 * `script-src 'self'` covers it.
 */
(function () {
  'use strict';

  var REFRESH_INTERVAL_MS = 10 * 1000;
  var refreshTimer = null;

  var sessionId = new URL(window.location.href).searchParams.get('embeddedContextId');
  var loadingEl = document.getElementById('loading');

  if (!sessionId) {
    loadingEl.textContent = 'No embedded session — open this page from the parent ERP.';
    return;
  }

  var headers = {
    'X-Embedded-Session-Id': sessionId,
    'Content-Type': 'application/json'
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

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

  function formatRefreshTime(date) {
    var hh = String(date.getHours()).padStart(2, '0');
    var mm = String(date.getMinutes()).padStart(2, '0');
    var ss = String(date.getSeconds()).padStart(2, '0');
    return 'Last refreshed ' + hh + ':' + mm + ':' + ss;
  }

  function updateEmptyState(count) {
    var el = document.getElementById('empty');
    if (count === 0) {
      el.hidden = false;
      el.textContent = 'No open reconciliation exceptions.';
    } else {
      el.hidden = true;
    }
  }

  function loadExceptions() {
    document.getElementById('empty').hidden = true;
    clearError();
    fetch('/api/embedded/reconciliation/exceptions', {
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
        document.getElementById('lastRefresh').textContent = formatRefreshTime(new Date());
        if (!result.ok) {
          showError('Failed to load exceptions: ' + ((result.body && result.body.error) || result.status));
          return;
        }
        var items = (result.body && result.body.exceptions) || [];
        updateEmptyState(items.length);
        renderList(items);
      })
      .catch(function () {
        loadingEl.hidden = true;
        showError('Network error loading exceptions.');
      });
  }

  function renderList(items) {
    var list = document.getElementById('list');
    list.innerHTML = '';
    if (items.length === 0) {
      list.hidden = true;
      return;
    }
    items.forEach(function (item) {
      list.appendChild(renderCard(item));
    });
    list.hidden = false;
  }

  function renderCard(item) {
    var li = document.createElement('li');
    li.className = 'recon-card';
    li.dataset.id = item.id;
    if (item.severity) {
      li.dataset.severity = item.severity;
    }

    var amountLine = '';
    if (item.amountDelta != null) {
      amountLine = '<div class="meta"><strong>Delta:</strong> '
        + escapeHtml(item.amountDelta) + ' ' + escapeHtml(item.currency || '') + '</div>';
    }

    li.innerHTML = [
      '<div>',
      '<span class="badge" data-tone="sev-' + escapeHtml(item.severity || 'unknown') + '">'
        + escapeHtml(item.severity || 'unknown') + '</span> ',
      '<strong>' + escapeHtml(item.exceptionType || 'unknown') + '</strong> ',
      '<code>' + escapeHtml(item.sourceSystem || '?') + ':' + escapeHtml(item.sourceRecordId || '?')
        + ' &rarr; ' + escapeHtml(item.targetSystem || '?') + ':' + escapeHtml(item.targetRecordId || '?') + '</code>',
      '</div>',
      '<div class="meta">' + escapeHtml(item.description || '') + '</div>',
      amountLine,
      '<div class="meta"><strong>Suggested:</strong> ' + escapeHtml(item.suggestedAction || '') + '</div>',
      '<div class="actions"><button type="button" data-act="resolve">Resolve&hellip;</button></div>',
      '<form class="resolve-form">',
      '<label>Resolution note (optional)<textarea name="note" placeholder="how this was reconciled"></textarea></label>',
      '<button type="submit">Confirm resolve</button>',
      '</form>'
    ].join('');

    li.querySelector('[data-act="resolve"]').addEventListener('click', function () {
      li.querySelector('.resolve-form').classList.add('expanded');
    });

    li.querySelector('.resolve-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var note = ev.target.elements['note'].value;
      postResolve(item.id, note);
    });

    return li;
  }

  function postResolve(exceptionId, note) {
    clearError();
    fetch('/api/embedded/reconciliation/exceptions/' + encodeURIComponent(exceptionId) + '/resolve', {
      method: 'POST',
      headers: headers,
      credentials: 'same-origin',
      body: JSON.stringify({ note: note })
    })
      .then(function (res) {
        if (res.status === 204) {
          loadExceptions();
          return null;
        }
        return res.json().then(function (payload) {
          showError('Resolve failed: ' + ((payload && payload.error) || res.status));
          return null;
        });
      })
      .catch(function () {
        showError('Network error during resolve.');
      });
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
    }
    refreshTimer = setInterval(loadExceptions, REFRESH_INTERVAL_MS);
  }

  document.getElementById('refreshBtn').addEventListener('click', loadExceptions);

  loadExceptions();
  scheduleRefresh();
})();
