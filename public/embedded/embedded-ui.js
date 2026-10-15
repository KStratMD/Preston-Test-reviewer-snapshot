/**
 * Embedded operator UI shared helpers (audit-remediation PR 2).
 *
 * Loaded by the embedded operator pages (sync-error-triage, approvals) BEFORE
 * their page modules. Provides:
 *   - outcome banners: dismissible, erp-theme-styled, with per-code copy and
 *     an optional Retry action for transient failures;
 *   - describeOutcome(): maps the sync-error-assist / governance approval API
 *     outcome codes to operator-facing copy;
 *   - renderNoSession(): the branded "open from the parent ERP" state.
 *
 * Served as an external script — no inline blocks, no CSP hash regen needed.
 * `script-src 'self'` covers it (see src/middleware/embeddedCspMiddleware.ts).
 */
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * Operator-facing copy per API outcome code. `kind` picks the erp-alert
   * tone; `retryable: true` offers a Retry button re-running the original
   * action; `refresh: true` reloads the list (the row changed under us).
   */
  var OUTCOME_COPY = {
    // Shared
    ok: { kind: 'success', title: 'Done', message: 'Action completed.' },
    not_found: { kind: 'warning', title: 'Not found', message: 'This record no longer exists. Refreshing the list.', refresh: true },
    cross_origin_rejected: { kind: 'error', title: 'Session required', message: 'This page must be opened from the parent ERP (NetSuite → SuiteCentral). Re-open it from the host application.' },
    unauthenticated: { kind: 'error', title: 'Session expired', message: 'Your embedded session is no longer valid. Re-open this page from the parent ERP.' },
    session_not_populated: { kind: 'error', title: 'Session required', message: 'No embedded session found. Re-open this page from the parent ERP.' },
    session_not_found: { kind: 'error', title: 'Session not recognized', message: 'Your embedded session was not recognized by the server. Re-open this page from the parent ERP.' },
    session_expired: { kind: 'error', title: 'Session expired', message: 'Your embedded session has expired. Re-open this page from the parent ERP.' },
    forbidden_role: { kind: 'error', title: 'Not permitted', message: 'Your role does not allow this action. Ask an ops/admin user to handle it.' },
    tenant_rate_limited: { kind: 'warning', title: 'Rate limited', message: 'Too many requests for this tenant right now. Wait a moment and retry.', retryable: true },
    internal_error: { kind: 'error', title: 'Server error', message: 'Something went wrong on the server. Retry, and escalate if it persists.', retryable: true },

    // Sync Error Assist dispositions
    already_dispositioned: { kind: 'warning', title: 'Already handled', message: 'Another operator already actioned this suggestion. Refreshing the queue.', refresh: true },
    connector_unavailable: { kind: 'error', title: 'Connector unavailable', message: 'The target system is not reachable right now. Nothing was written — retry when the connector is back.', retryable: true },
    write_failed: { kind: 'error', title: 'Write failed', message: 'The target system rejected the write. Review the error detail before retrying.' },
    invalid_apply_action: { kind: 'error', title: 'Invalid apply action', message: 'The apply payload failed validation — check entity type, record id, and JSON shape.' },
    invalid_body: { kind: 'error', title: 'Invalid request', message: 'The request body failed validation.' },
    invalid_payload: { kind: 'error', title: 'Invalid payload', message: 'The payload failed validation — it must be JSON-safe.' },
    missing_reason: { kind: 'error', title: 'Reason required', message: 'A rejection reason is required.' },
    missing_note: { kind: 'error', title: 'Note required', message: 'An escalation note is required.' },
    tenant_mismatch: { kind: 'error', title: 'Tenant mismatch', message: 'This record belongs to a different tenant. Refreshing the queue.', refresh: true },

    // Governance approvals
    approval_not_found: { kind: 'warning', title: 'Not found', message: 'This approval no longer exists. Refreshing the list.', refresh: true },
    already_decided: { kind: 'warning', title: 'Already decided', message: 'Another operator already decided this approval. Refreshing the list.', refresh: true },
    reason_required: { kind: 'error', title: 'Reason required', message: 'A rejection reason is required.' },
    invalid_reason: { kind: 'error', title: 'Invalid reason', message: 'The supplied reason failed validation.' }
  };

  /**
   * Map a completed POST ({ ok, status, payload }) to banner copy.
   * Unknown codes fall back to a generic message that still shows the raw
   * code + HTTP status so nothing is silently swallowed.
   */
  function describeOutcome(verb, result) {
    // Routes use `code`; the embedded auth middleware uses `error`
    // (e.g. {"error":"cross_origin_rejected"}). Accept both.
    var code = result && result.payload && (result.payload.code || result.payload.error);
    var copy = code && OUTCOME_COPY[code];
    if (result && result.ok) {
      var successDetailParts = [];
      if (result.payload && result.payload.appliedRecordId) {
        successDetailParts.push('Applied record: ' + result.payload.appliedRecordId);
      }
      if (result.payload && result.payload.correlationId) {
        successDetailParts.push('Correlation: ' + result.payload.correlationId);
      }
      return {
        kind: 'success',
        title: verb.charAt(0).toUpperCase() + verb.slice(1) + ' recorded',
        message: (copy && copy.message) || 'The ' + verb + ' completed and was audit-logged.',
        detail: successDetailParts.join(' · '),
        refresh: true
      };
    }
    if (copy) {
      return {
        kind: copy.kind,
        title: copy.title,
        message: copy.message,
        detail: (result.payload && result.payload.message) || '',
        retryable: !!copy.retryable,
        refresh: !!copy.refresh
      };
    }
    return {
      kind: 'error',
      title: verb + ' failed',
      message: 'Unexpected response (' + (code || 'no code') + ', HTTP ' + (result ? result.status : '?') + ').',
      detail: (result && result.payload && result.payload.message) || '',
      retryable: false
    };
  }

  function networkOutcome(verb) {
    return {
      kind: 'error',
      title: 'Network error',
      message: 'Could not reach the server during ' + verb + '. Check connectivity and retry.',
      retryable: true
    };
  }

  /**
   * Render a dismissible outcome banner into `container` (an element).
   * Newest banner replaces the previous one — operators act serially, and a
   * stack of stale outcomes is noise. `onRetry`, when provided alongside a
   * retryable outcome, re-runs the original action.
   */
  function banner(container, outcome, onRetry) {
    if (!container) return;
    container.innerHTML = '';
    var el = document.createElement('div');
    el.className = 'erp-alert erp-alert-' + (outcome.kind || 'info') + ' embedded-outcome';
    el.setAttribute('role', outcome.kind === 'success' ? 'status' : 'alert');
    var body = document.createElement('div');
    body.className = 'embedded-outcome-body';
    body.innerHTML =
      '<strong>' + escapeHtml(outcome.title || '') + '</strong> ' +
      escapeHtml(outcome.message || '') +
      (outcome.detail ? '<div class="embedded-outcome-detail">' + escapeHtml(outcome.detail) + '</div>' : '');
    el.appendChild(body);

    var controls = document.createElement('div');
    controls.className = 'embedded-outcome-controls';
    if (outcome.retryable && typeof onRetry === 'function') {
      var retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'erp-btn erp-btn-secondary erp-btn-sm';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', function () {
        container.innerHTML = '';
        onRetry();
      });
      controls.appendChild(retryBtn);
    }
    var dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'erp-btn erp-btn-ghost erp-btn-sm';
    dismissBtn.setAttribute('aria-label', 'Dismiss notification');
    dismissBtn.textContent = '×';
    dismissBtn.addEventListener('click', function () {
      container.innerHTML = '';
    });
    controls.appendChild(dismissBtn);
    el.appendChild(controls);
    container.appendChild(el);
  }

  /**
   * Branded no-session state. Replaces the bare "No embedded session" line:
   * tells the operator how to launch the page correctly and shows enough
   * diagnostics (URL, missing param) to hand to support.
   */
  function renderNoSession(mainEl, pageTitle) {
    if (!mainEl) return;
    mainEl.innerHTML = [
      '<div class="erp-card embedded-no-session">',
      '<h2 class="erp-card-title">Embedded session required</h2>',
      '<p>', escapeHtml(pageTitle), ' runs inside your ERP. Open it from the host application ',
      '(NetSuite → SuiteCentral, or Business Central → SuiteCentral) so it receives an embedded session.</p>',
      '<p class="embedded-no-session-hint">Direct browser access has no session and is read-blocked by design — ',
      'this protects the operator queue behind tenant-scoped authentication.</p>',
      '<details><summary>Diagnostics for support</summary>',
      '<div class="pre-context">',
      escapeHtml(JSON.stringify({
        page: window.location.pathname,
        missingParam: 'embeddedContextId',
        origin: window.location.origin
      }, null, 2)),
      '</div></details>',
      '</div>'
    ].join('');
  }

  window.EmbeddedUI = {
    escapeHtml: escapeHtml,
    describeOutcome: describeOutcome,
    networkOutcome: networkOutcome,
    banner: banner,
    renderNoSession: renderNoSession
  };
})();
