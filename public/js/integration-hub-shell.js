(function () {
  'use strict';

  // The home dashboard (index.html) is the Build surface in the real app (local OR
  // any deployed Express instance), where "/" routes to it. ONLY the static hosted
  // artifact rewrites "/" to the Squire exec-deck redirect — and the build sets
  // window.__IH_HOSTED__ in that artifact's copy of this file (see
  // build-hosted-artifacts.sh). So detect the artifact specifically, NOT by hostname.
  var IS_HOSTED_ARTIFACT = typeof window !== 'undefined' && window.__IH_HOSTED__ === true;
  var BUILD_HREF = IS_HOSTED_ARTIFACT ? '/Integration-Command-Center.html' : '/';

  // Canonical top-rail destinations (single source of truth for injected rails).
  var SHELL_TABS = [
    { key: 'build', href: BUILD_HREF, icon: 'fa-tools', label: 'Build' },
    { key: 'review', href: '/review-hub.html', icon: 'fa-shield-alt', label: 'Review' },
    { key: 'demo', href: '/squire-v2-media-demo/index.html', icon: 'fa-play', label: 'Demo' },
    { key: 'wiki', href: '/wiki/', icon: 'fa-book', label: 'Wiki' },
    { key: 'docs', href: '/docs/INDEX.md', icon: 'fa-file-alt', label: 'Docs' },
  ];

  // Inject the shared top rail on any page that opts in via body[data-shell-section]
  // and doesn't already hand-code one. Inline layout so it works without Tailwind.
  // The injected rail uses Font Awesome tab icons; some opted-in pages don't load
  // FA, which would render the icons as empty boxes with awkward spacing. Inject the
  // stylesheet when it isn't already present so the icons render consistently.
  function ensureFontAwesome() {
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i++) {
      if (/font-?awesome/i.test(links[i].href || '')) return;
    }
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/vendor/fontawesome-6.0.0.min.css';
    (document.head || document.documentElement).appendChild(link);
  }

  function ensureTopRail() {
    // The rail's tabs are absolute app routes (/wiki/, /docs/INDEX.md, /review-hub.html,
    // …). Under file:// — the browser-only offline mini-pack — those resolve outside the
    // extracted bundle and 404, so skip the rail there; that curated pack uses its own nav.
    if (location.protocol === 'file:') return;
    var section = document.body && document.body.dataset ? document.body.dataset.shellSection : '';
    if (!section) return;
    if (document.querySelector('.ih-shell-top-rail')) return;
    ensureFontAwesome();
    var header = document.createElement('header');
    header.className = 'ih-shell-top-rail';
    // Some opted-in pages keep a standalone padded/centered body (e.g. metrics-viewer
    // has body{padding:20px}). The rail is the first body child, so that padding would
    // inset it into the gutter instead of spanning edge-to-edge. Negate the body's
    // padding with matching negative margins + a widened width so the rail full-bleeds
    // on padded AND bare pages alike (all terms are 0 when the body has no padding).
    var bodyStyle = window.getComputedStyle(document.body);
    var padTop = parseFloat(bodyStyle.paddingTop) || 0;
    var padLeft = parseFloat(bodyStyle.paddingLeft) || 0;
    var padRight = parseFloat(bodyStyle.paddingRight) || 0;
    // Inline !important for LAYOUT only, so page-level `header {}` / `body {}` rules
    // (max-width, margin) can't distort the injected rail. Static (not sticky) so it
    // never fights a page's own sticky-top chrome. Background/border are left to the
    // .ih-shell-top-rail class (also !important) so the `.dark` overrides can still win
    // via higher specificity on dark-themed pages.
    header.style.cssText =
      'position:relative !important;width:calc(100% + ' + (padLeft + padRight) + 'px) !important;' +
      'max-width:none !important;margin:' + (-padTop) + 'px ' + (-padRight) + 'px 0 ' + (-padLeft) + 'px !important;' +
      'box-sizing:border-box !important;z-index:30 !important;';
    var tabs = SHELL_TABS.map(function (t) {
      return '<a class="ih-shell-top-tab" href="' + t.href + '" data-shell-tab="' + t.key +
        '"><i class="fas ' + t.icon + '"></i>' + t.label + '</a>';
    }).join('');
    header.innerHTML =
      '<div style="display:flex;align-items:center;padding:0 2rem;">' +
      '<nav style="display:flex;align-items:center;gap:0.5rem;" aria-label="Primary modules">' + tabs + '</nav>' +
      '</div>';
    document.body.insertBefore(header, document.body.firstChild);
    // Publish the rail height so a page's fixed-position chrome (e.g. the
    // demo-tab-nav close/back pill) can offset itself below the injected rail
    // instead of overlapping it. Re-measure on resize (the rail wraps on mobile).
    var publishRailHeight = function () {
      document.documentElement.style.setProperty('--ih-rail-h', header.getBoundingClientRect().height + 'px');
    };
    publishRailHeight();
    window.addEventListener('resize', publishRailHeight);
  }

  function setActiveTopTab() {
    const current = document.body?.dataset?.shellSection || '';
    document.querySelectorAll('[data-shell-tab]').forEach((tab) => {
      const isActive = tab.getAttribute('data-shell-tab') === current;
      if (isActive) {
        tab.setAttribute('aria-current', 'page');
      } else {
        tab.removeAttribute('aria-current');
      }
    });
  }

  function openHelpAssistant() {
    // Record the intent, then notify any already-mounted widget. The help-chat
    // widget mounts asynchronously; if the click lands before its event listener
    // is attached, the dispatch is dropped — so the widget also consumes this flag
    // in its init() to guarantee an early click is never lost (no double-open: the
    // listener clears the flag when it handles the event live).
    window.__ihHelpOpenRequested = true;
    window.dispatchEvent(new CustomEvent('integration-hub:open-help-assistant'));
  }

  window.IntegrationHubShell = {
    setActiveTopTab,
    openHelpAssistant,
  };

  document.addEventListener('DOMContentLoaded', () => {
    ensureTopRail();
    setActiveTopTab();
    document.querySelectorAll('[data-open-help-assistant]').forEach((button) => {
      button.addEventListener('click', openHelpAssistant);
    });
  });

  // When the help assistant is docked, reflow page content beside the panel
  // (vs. overlaying it) by toggling a body class the shell stylesheet keys on.
  window.addEventListener('help-chat:toggled', (event) => {
    const docked = document.querySelector('[data-help-chat-mode="docked"]');
    if (!docked) return;
    const isOpen = !!(event.detail && event.detail.isOpen);
    document.body.classList.toggle('ih-assistant-open', isOpen);
  });
})();
