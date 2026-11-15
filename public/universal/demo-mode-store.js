(function() {
  'use strict';

  const API_ENDPOINT = '/api/settings/demo-mode';

  // /api/settings requires authentication, so forward the operator token the
  // other pages use (auth_token) when one is stored.
  const authHeaders = () => {
    let token = null;
    try {
      token = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    } catch (e) { /* storage unavailable */ }
    return token ? { Authorization: 'Bearer ' + token } : {};
  };

  const initializeStore = () => {
    if (!window.Alpine) return;
    if (Alpine.store('demoMode')) return;

    // Demo mode is a process-global runtime setting managed only by a platform
    // administrator via POST /api/admin/settings/demo-mode. Public pages read
    // status here and reflect changes; they never mutate it.
    const store = {
      enabled: false,
      initialized: false,
      writable: false,
      managementMessage: 'Demo mode is operator-managed.',

      async refresh() {
        try {
          const response = await fetch(API_ENDPOINT, {
            headers: { 'Accept': 'application/json', ...authHeaders() },
            credentials: 'same-origin'
          });

          if (!response.ok) {
            throw new Error(`Failed to fetch demo mode (status ${response.status})`);
          }

          const data = await response.json();
          const next = !!data.enabled;
          const previous = this.enabled;
          this.enabled = next;
          if (previous !== next) {
            window.dispatchEvent(new CustomEvent('demo-mode-changed', {
              detail: { enabled: this.enabled },
            }));
          }
        } catch (error) {
          console.warn('[DemoModeStore] Unable to load demo mode status', error);
        } finally {
          this.initialized = true;
        }
      },

      // Demo mode is a process-global runtime setting managed only by a
      // platform administrator (POST /api/admin/settings/demo-mode). set() and
      // toggle() are retained as honest no-ops so existing page callers keep
      // working: they never POST and never change the flag. They surface the
      // operator-managed message and re-broadcast the authoritative state so
      // any caller that optimistically flipped local UI is corrected back.
      async set() {
        this._notifyManaged();
        this._reemitState();
      },

      async toggle() {
        this._notifyManaged();
        this._reemitState();
      },

      _notifyManaged() {
        if (window.SettingsAuthFeedback && typeof window.SettingsAuthFeedback.show === 'function') {
          window.SettingsAuthFeedback.show(this.managementMessage);
        } else {
          console.info('[DemoModeStore] ' + this.managementMessage);
        }
      },

      _reemitState() {
        window.dispatchEvent(new CustomEvent('demo-mode-changed', {
          detail: { enabled: this.enabled },
        }));
      },
    };

    Alpine.store('demoMode', store);
    store.refresh();
  };

  // Always listen for alpine:init event - it fires before Alpine processes x-data
  document.addEventListener('alpine:init', initializeStore);

  // Also try immediate initialization if Alpine is already available
  if (window.Alpine && typeof window.Alpine.store === 'function') {
    initializeStore();
  }
})();
