/**
 * Governance Approvals — operator UI module (PR 3C + Tier-C history view).
 *
 * Loaded inside the embedded iframe AFTER guest-bootstrap.js runs the context
 * fetch. The session id is the `embeddedContextId` URL parameter (same source
 * guest-bootstrap reads); we send it as `X-Embedded-Session-Id` on every
 * /api/governance/approvals call.
 *
 * Tier-C history view: three tabs — Pending (default), Approved, Rejected.
 * Active tab persisted in `location.hash` (#tab=approved) so a reload keeps
 * the operator's last view AND so individual tab URLs are shareable inside
 * the iframe context. The pending tab honours the server's expires_at TTL
 * filter; the approved/rejected tabs read terminal-status rows.
 *
 * Auto-refresh every 10s via `fetch('/api/governance/approvals?status=<tab>')`.
 * Per spec §5, NOT via `request.context.refresh` postMessage — that message
 * is reserved for security-context rotation at T-60s before session expiry
 * and is server-side rate-limited (PR 10a round-6 finding #1).
 *
 * Served as an external script — no inline blocks, no CSP hash regen needed.
 * `script-src 'self'` covers it.
 *
 * PII guarantee is backend-enforced. The row's `redactedPayload` reaching the
 * UI is sourced from `governance_approvals.redacted_payload`, which is
 * populated at enqueue time from `OutboundDecision.redactedPayload` (the
 * DLP-scanned form). The UI faithfully renders that field — no second
 * redaction pass. Per spec §5 acceptance gate 2, adding client-side
 * defense-in-depth masking is Tier-C.
 */
(function () {
  'use strict';

  var REFRESH_INTERVAL_MS = 10 * 1000;
  var ALLOWED_TABS = ['pending', 'approved', 'rejected'];
  var refreshTimer = null;
  var currentTab = 'pending';

  var sessionId = new URL(window.location.href).searchParams.get('embeddedContextId');
  var loadingEl = document.getElementById('loading');
  var noticesEl = document.getElementById('notices');

  if (!sessionId) {
    window.EmbeddedUI.renderNoSession(document.getElementById('main'), 'Governance Approvals');
    return;
  }

  var headers = {
    'X-Embedded-Session-Id': sessionId,
    'Content-Type': 'application/json'
  };

  // Propagate the session to the governance-operations cross-link so the
  // dashboard opens in LIVE mode (it reads the same embeddedContextId URL
  // param). External-script DOM write — no inline JS, CSP stays untouched.
  var govOpsLink = document.getElementById('govops-link');
  if (govOpsLink) {
    govOpsLink.href = '/governance-operations.html?embeddedContextId=' + encodeURIComponent(sessionId);
  }

  // DLP pattern metadata — used to map raw policyFindings type keys ('ssn')
  // to display names ('Social Security Number') and to render the
  // "(matched/total)" suffix. NEVER hardcoded (CLAUDE.md: pattern count/list
  // always derive from the endpoint).
  //
  // Fetched from GET /api/governance/dlp-pattern-metadata, which is gated by
  // `validateGuestContext` + `requireApproverRole` — the same embedded-session
  // gate used by every other fetch in this file. The X-Embedded-Session-Id
  // header is sent so the server can identify the session without a Bearer JWT.
  // Response envelope is identical to the compliance endpoint so mapFindings
  // consumes it verbatim.
  //
  // Graceful degradation: if the fetch fails or the session lacks approver
  // role, `dlpPatternMeta` stays null and findings render as their raw type
  // keys with no count suffix.
  var dlpPatternMeta = null;

  function fetchDlpPatternMeta() {
    fetch('/api/governance/dlp-pattern-metadata', {
      headers: headers,
      credentials: 'same-origin'
    })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (body) {
        if (body && body.success && body.data && Array.isArray(body.data.patterns)) {
          dlpPatternMeta = body.data;
          // Re-render so already-painted cards pick up the display names.
          loadApprovals();
        }
      })
      .catch(function () { /* best-effort; raw finding keys remain readable */ });
  }

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

  function readTabFromHash() {
    // Hash format: #tab=approved. Fall through to 'pending' on anything
    // unrecognised so a hand-edited hash (typo, removed value, foreign tab
    // name from a future deploy) just shows the default tab.
    var hash = window.location.hash || '';
    var match = /(?:^#|&)tab=([a-z]+)/.exec(hash);
    if (match && ALLOWED_TABS.indexOf(match[1]) !== -1) {
      return match[1];
    }
    return 'pending';
  }

  function writeTabToHash(tab) {
    if (ALLOWED_TABS.indexOf(tab) === -1) return;
    // Use replaceState so changing tabs doesn't flood the back-button history.
    var next = '#tab=' + tab;
    if (window.location.hash !== next) {
      try {
        window.history.replaceState(null, '', next);
      } catch (e) {
        // Older browsers / sandboxed iframes may reject replaceState. Fall
        // back to location.hash; both achieve the same persistence goal even
        // though hash assignment DOES push a history entry.
        window.location.hash = next;
      }
    }
  }

  function updateTabUi(tab) {
    // Per the WAI-ARIA Authoring Practices tabs pattern: the SELECTED tab
    // gets tabindex=0 and aria-selected=true; non-selected tabs get
    // tabindex=-1 (so Tab moves past them to the panel content) and
    // aria-selected=false. Keyboard users navigate between tabs with the
    // arrow keys (wired in the click+keydown listeners below). The
    // tabpanel's aria-labelledby is also kept in sync so screen readers
    // announce which view they're reading. Copilot R1 on PR #826 asked
    // for the complete pattern.
    var buttons = document.querySelectorAll('.tabs button[data-tab]');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var isSelected = b.dataset.tab === tab;
      b.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      b.setAttribute('tabindex', isSelected ? '0' : '-1');
    }
    var panel = document.getElementById('tabpanel-approvals');
    if (panel) {
      panel.setAttribute('aria-labelledby', 'tab-' + tab);
    }
  }

  function setTabCount(tab, count) {
    var span = document.querySelector('.tabs button[data-tab="' + tab + '"] .tab-count');
    if (!span) return;
    span.textContent = typeof count === 'number' ? '(' + count + ')' : '';
  }

  /**
   * Three states this UI must distinguish:
   *   - `total === 0`             → "no <tab> approvals" empty state
   *   - `total > 0 && items === 0` → "no results on this page" message
   *                                  (offset beyond total, or a future
   *                                   list/count race). Without this branch
   *                                   the list AND the empty state would
   *                                   both stay hidden, giving a blank
   *                                   panel even though the tab count
   *                                   shows rows exist. Copilot R6 on
   *                                   PR #826.
   *   - `items > 0`                → list renders, empty state hidden
   */
  function updateEmptyState(tab, total, itemsLength) {
    var el = document.getElementById('empty');
    if (total === 0) {
      el.hidden = false;
      if (tab === 'pending') {
        el.textContent = 'No pending approvals.';
      } else if (tab === 'approved') {
        el.textContent = 'No approved decisions on record yet.';
      } else {
        el.textContent = 'No rejected decisions on record yet.';
      }
      return;
    }
    if (itemsLength === 0) {
      el.hidden = false;
      el.textContent = 'No results on this page (the tab has ' + total + ' total — try a lower offset).';
      return;
    }
    el.hidden = true;
  }

  function switchTab(tab) {
    if (ALLOWED_TABS.indexOf(tab) === -1) tab = 'pending';
    if (tab === currentTab) return;
    currentTab = tab;
    writeTabToHash(tab);
    updateTabUi(tab);
    loadApprovals();
  }

  /**
   * Refresh tab counts for the two INACTIVE tabs in parallel with the active
   * tab's full fetch. Without this, inactive tab pills sit empty until the
   * user visits each tab. Each request passes `counts_only=1` so the route
   * SKIPS the list query — it still echoes the normal response envelope
   * but with `items: []`, so no redactedPayload / policyFindings download
   * for rows the UI isn't rendering. Copilot R4 on PR #826 caught the
   * prior `limit=1` approach which still pulled a full row payload.
   * Counts are best-effort — a failure leaves the pill empty rather than
   * surfacing a noisy error.
   */
  function refreshInactiveTabCounts() {
    var snapshotTab = currentTab;
    ALLOWED_TABS.forEach(function (tab) {
      if (tab === snapshotTab) return;
      var url = '/api/governance/approvals?status=' + encodeURIComponent(tab) + '&counts_only=1';
      fetch(url, { headers: headers, credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) return null;
          return res.json();
        })
        .then(function (body) {
          // The "inactive" set is computed from the snapshot taken at
          // request time. If the user has since switched to this tab,
          // its full-fetch path will set the count more reliably; we
          // skip the count-only update to avoid a brief race-flicker.
          // Copilot R5 on PR #826.
          if (tab === currentTab) return;
          if (body && typeof body.total === 'number') {
            setTabCount(tab, body.total);
          }
        })
        .catch(function () { /* best-effort; leave the pill empty on failure */ });
    });
  }

  function loadApprovals() {
    loadingEl.hidden = false;
    document.getElementById('empty').hidden = true;
    document.getElementById('list').hidden = true;
    clearError();

    // Snapshot the tab at request start. If the user switches tabs while
    // this request is in-flight, a slower response from the previous tab
    // could otherwise overwrite the UI (counts / empty state / list) for
    // the newly-selected tab. Copilot R5 on PR #826 flagged the race.
    var tabAtRequest = currentTab;
    var url = '/api/governance/approvals?status=' + encodeURIComponent(tabAtRequest);
    // Fire inactive-tab count refreshes in parallel with the active fetch.
    refreshInactiveTabCounts();
    fetch(url, {
      headers: headers,
      credentials: 'same-origin'
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function (result) {
        // Discard the response if the user switched tabs while it was in
        // flight — applying it would clobber the newly-active tab.
        if (tabAtRequest !== currentTab) return;
        loadingEl.hidden = true;
        document.getElementById('lastRefresh').textContent = formatRefreshTime(new Date());
        if (!result.ok) {
          // Reuse the outcome copy for session/permission codes so a 403
          // reads as "open from the parent ERP", not a bare status number.
          var outcome = window.EmbeddedUI.describeOutcome('load',
            { ok: false, status: result.status, payload: result.body });
          showError(outcome.title + ' — ' + outcome.message);
          return;
        }
        var items = (result.body && result.body.items) || [];
        var total = (result.body && typeof result.body.total === 'number') ? result.body.total : items.length;
        setTabCount(tabAtRequest, total);
        // updateEmptyState distinguishes three cases (Copilot R6 on PR
        // #826): total=0 (real empty), total>0 && items=0 (offset beyond
        // total — paginated page is empty but rows exist on previous
        // pages), and items>0 (list renders, empty state hidden).
        updateEmptyState(tabAtRequest, total, items.length);
        renderList(items, tabAtRequest);
      })
      .catch(function () {
        // Discard on tab-switch race here too — a network error from the
        // previous tab shouldn't blank the newly-active tab's UI.
        if (tabAtRequest !== currentTab) return;
        loadingEl.hidden = true;
        showError('Network error loading approvals.');
      });
  }

  function renderList(items, tab) {
    var list = document.getElementById('list');
    list.innerHTML = '';
    if (items.length === 0) {
      list.hidden = true;
      return;
    }
    items.forEach(function (item) {
      list.appendChild(renderCard(item, tab));
    });
    list.hidden = false;
  }

  function safeJsonPretty(raw) {
    if (typeof raw !== 'string') return '(no payload)';
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (e) {
      // Repository stores JSON-stringified payloads, but defend against
      // any future migration shape by surfacing the raw string verbatim.
      return raw;
    }
  }

  function findingsList(raw) {
    if (typeof raw !== 'string') return [];
    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(function (f) { return typeof f === 'string'; });
    } catch (e) {
      // ignore — empty list
    }
    return [];
  }

  function renderCard(item, tab) {
    var li = document.createElement('li');
    li.className = 'approval-card';
    li.dataset.id = item.id;
    if (item.riskLevel) {
      li.dataset.risk = item.riskLevel;
    }
    var findings = findingsList(item.policyFindings);
    // Humanize finding type keys via the DLP pattern metadata (PR 4, Phase D).
    // mapFindings passes raw keys through when metadata is unavailable and
    // returns total=null in that case, so the "(matched/total)" suffix only
    // renders when the live registered-pattern count is known.
    var mapped = window.FindingsDisplay.mapFindings(findings, dlpPatternMeta);
    var findingsHtml = mapped.names.length === 0
      ? '<em>no policy findings recorded</em>'
      : mapped.names.map(function (f) {
          return '<span class="erp-badge erp-badge-info">' + escapeHtml(f) + '</span>';
        }).join(' ') + (mapped.total === null
          ? ''
          : ' <span class="meta">(' + mapped.matched + '/' + mapped.total + ' registered patterns)</span>');

    // Decided-row meta differs from pending-row meta. The pending tab shows
    // expires_at (the actionable countdown); approved/rejected tabs show
    // decided_at + decided_by + the operator-recorded reason (the audit
    // story). Both branches read the same persisted row — the executor /
    // service shapes the payload identically.
    var metaParts = ['Requested by ' + escapeHtml(item.requesterUserId || 'unknown'),
                     'created ' + escapeHtml(item.createdAt || 'unknown')];
    if (tab === 'pending') {
      metaParts.push('expires ' + escapeHtml(item.expiresAt || 'unknown'));
    } else {
      metaParts.push('decided ' + escapeHtml(item.decidedAt || 'unknown'));
      metaParts.push('by ' + escapeHtml(item.decidedByUserId || 'unknown'));
    }

    var reasonHtml = '';
    if (tab !== 'pending' && item.decisionReason) {
      reasonHtml = '<div class="meta"><strong>' + escapeHtml(tab === 'approved' ? 'Approval note' : 'Rejection reason') + ':</strong> ' + escapeHtml(item.decisionReason) + '</div>';
    }

    var actionsHtml = '';
    var formsHtml = '';
    if (tab === 'pending') {
      // Operator decision controls only on the actionable tab.
      actionsHtml = [
        '<div class="actions">',
        '<button type="button" class="erp-btn erp-btn-primary erp-btn-sm" data-act="approve">Approve&hellip;</button>',
        '<button type="button" class="erp-btn erp-btn-secondary erp-btn-sm" data-act="reject">Reject&hellip;</button>',
        '</div>',
      ].join('');
      formsHtml = [
        '<form class="inline-form approve-form">',
        '<label>Approval note (optional)<textarea name="reason" placeholder="why this is safe to approve"></textarea></label>',
        '<button type="submit" class="erp-btn erp-btn-primary erp-btn-sm">Confirm approve</button>',
        '</form>',
        '<form class="inline-form reject-form">',
        '<label>Rejection reason (required)<textarea name="reason" required></textarea></label>',
        '<button type="submit" class="erp-btn erp-btn-secondary erp-btn-sm">Confirm reject</button>',
        '</form>',
      ].join('');
    }

    // Redaction summary ("N fields masked: …") above the payload <details>
    // so the operator sees WHAT was masked without expanding. Heuristic —
    // see findings-display.js; the <details> payload remains authoritative.
    var redaction = window.FindingsDisplay.summarizeRedactions(item.redactedPayload);
    var redactionHtml = '';
    if (redaction.count > 0) {
      var shownFields = redaction.fields.slice(0, 8);
      var moreCount = redaction.fields.length - shownFields.length;
      redactionHtml = '<div class="meta">'
        + redaction.count + ' field' + (redaction.count === 1 ? '' : 's') + ' masked: '
        + '<code>' + shownFields.map(escapeHtml).join('</code>, <code>') + '</code>'
        + (moreCount > 0 ? ' &hellip; and ' + moreCount + ' more' : '')
        + '</div>';
    }

    var statusBadge = '<span class="erp-badge erp-badge-neutral" data-tone="status-' + escapeHtml(item.status || tab) + '">' + escapeHtml(item.status || tab) + '</span> ';
    var riskTone = item.riskLevel === 'high' ? 'erp-badge-error'
      : item.riskLevel === 'medium' ? 'erp-badge-warning'
      : item.riskLevel === 'low' ? 'erp-badge-success'
      : 'erp-badge-neutral';

    li.innerHTML = [
      '<div>',
      statusBadge,
      '<span class="' + riskTone + ' erp-badge" data-tone="risk-' + escapeHtml(item.riskLevel || 'unknown') + '">' + escapeHtml(item.riskLevel || 'unknown') + ' risk</span> ',
      '<strong>' + escapeHtml(item.operationType || 'unknown_op') + '</strong> on <code>' + escapeHtml(item.resourceType || 'unknown') + ':' + escapeHtml(item.resourceId || 'unknown') + '</code>',
      '</div>',
      '<div class="meta">' + metaParts.map(function (s) { return s; }).join(' &middot; ') + '</div>',
      reasonHtml,
      '<div class="findings"><strong>Matched patterns:</strong> ' + findingsHtml + '</div>',
      redactionHtml,
      '<details><summary>Redacted payload (server-redacted; renders as-stored)</summary>',
      '<div class="pre-context">' + escapeHtml(safeJsonPretty(item.redactedPayload)) + '</div></details>',
      actionsHtml,
      formsHtml,
    ].join('');

    if (tab === 'pending') {
      li.querySelector('[data-act="approve"]').addEventListener('click', function () {
        li.querySelector('.approve-form').classList.add('expanded');
        li.querySelector('.reject-form').classList.remove('expanded');
      });

      li.querySelector('[data-act="reject"]').addEventListener('click', function () {
        li.querySelector('.reject-form').classList.add('expanded');
        li.querySelector('.approve-form').classList.remove('expanded');
      });

      li.querySelector('.approve-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        var reason = ev.target.elements['reason'].value.trim();
        postDecision(item.id, 'approve', reason.length === 0 ? {} : { reason: reason });
      });

      li.querySelector('.reject-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        var reason = ev.target.elements['reason'].value.trim();
        if (reason.length === 0) {
          window.EmbeddedUI.banner(noticesEl, {
            kind: 'error',
            title: 'Reason required',
            message: 'A rejection reason is required.'
          });
          return;
        }
        postDecision(item.id, 'reject', { reason: reason });
      });
    }

    return li;
  }

  function postDecision(approvalId, verb, body) {
    clearError();
    fetch('/api/governance/approvals/' + encodeURIComponent(approvalId) + '/' + verb, {
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
        // Map the outcome code (already_decided, reason_required, session
        // codes, …) to operator-facing copy; success banners carry the
        // audit/correlation detail when the route returns one.
        var outcome = window.EmbeddedUI.describeOutcome(verb, result);
        window.EmbeddedUI.banner(noticesEl, outcome, function retry() {
          postDecision(approvalId, verb, body);
        });
        if (outcome.refresh) {
          // Refresh immediately so the decided/stale row disappears.
          loadApprovals();
        }
      })
      .catch(function () {
        window.EmbeddedUI.banner(noticesEl, window.EmbeddedUI.networkOutcome(verb), function retry() {
          postDecision(approvalId, verb, body);
        });
      });
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
    }
    refreshTimer = setInterval(loadApprovals, REFRESH_INTERVAL_MS);
  }

  // Wire tab buttons — click to switch, ArrowLeft/ArrowRight + Home/End for
  // keyboard navigation between tabs per the WAI-ARIA tabs pattern.
  // Home/End jump to the first/last tab respectively; arrows wrap around.
  var tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tabs button[data-tab]'));
  tabButtons.forEach(function (btn, idx) {
    btn.addEventListener('click', function () {
      switchTab(btn.dataset.tab);
    });
    btn.addEventListener('keydown', function (ev) {
      var nextIdx = idx;
      var move = false;
      if (ev.key === 'ArrowRight') {
        nextIdx = (idx + 1) % tabButtons.length;
        move = true;
      } else if (ev.key === 'ArrowLeft') {
        nextIdx = (idx - 1 + tabButtons.length) % tabButtons.length;
        move = true;
      } else if (ev.key === 'Home') {
        nextIdx = 0;
        move = true;
      } else if (ev.key === 'End') {
        nextIdx = tabButtons.length - 1;
        move = true;
      }
      if (move) {
        ev.preventDefault();
        var target = tabButtons[nextIdx];
        // Move focus first so the user sees the arrow-key effect, THEN
        // switch the active tab. switchTab() calls updateTabUi() which
        // updates tabindex; the focused button's tabindex flips to 0
        // immediately so subsequent Tab presses stay on the active tab.
        target.focus();
        switchTab(target.dataset.tab);
      }
    });
  });

  // Initial tab from hash (default 'pending').
  currentTab = readTabFromHash();
  updateTabUi(currentTab);

  document.getElementById('refreshBtn').addEventListener('click', loadApprovals);

  fetchDlpPatternMeta();
  loadApprovals();
  scheduleRefresh();
})();
