/* eslint-disable no-console */
/* global window, document, Alpine, DOMParser */
// NOTE: fetch/localStorage/sessionStorage/CustomEvent/setTimeout are built-in
// globals in the flat-config lint environment — declaring them in the global
// directive fails no-redeclare (and /* eslint-env */ comments are inert under
// flat config), so only the non-built-ins are declared above.

/**
 * Help Chat Widget - Alpine.js Component
 * Natural language documentation help powered by AI
 */

(function() {
  'use strict';

  function getAuthHeaders() {
    const token = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  function extractWidgetNodes(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html || ''), 'text/html');
    const responseTitle = (doc.querySelector('title')?.textContent || '').trim();

    doc.querySelectorAll('script, meta, title, link').forEach((node) => node.remove());

    const widgetRoot = doc.body.firstElementChild;
    const isWidgetMarkup = widgetRoot && widgetRoot.getAttribute('x-data') === 'helpChatWidget()';

    if (!isWidgetMarkup) {
      const detail = responseTitle ? `: ${responseTitle}` : '';
      throw new Error(`Unexpected help chat widget markup${detail}`);
    }

    return Array.from(doc.body.childNodes).map((node) => document.importNode(node, true));
  }

  window.mountHelpChatWidgetSafely = async function mountHelpChatWidgetSafely(options = {}) {
    const config = options || {};
    const containerId = config.containerId || 'help-chat-widget-container';
    const widgetUrl = config.widgetUrl || '/help-chat-widget.html';
    const container = document.getElementById(containerId);

    if (!container) {
      return false;
    }

    try {
      const response = await fetch(widgetUrl);
      if (!response.ok) {
        throw new Error(`Help widget request failed: HTTP ${response.status}`);
      }

      const html = await response.text();
      const nodes = extractWidgetNodes(html);
      container.replaceChildren(...nodes);
      if (config.mode === 'docked') {
        container.dataset.helpChatMode = 'docked';
        container.classList.add('ih-assistant-dock');
      }
      return true;
    } catch (error) {
      console.error('[HelpChat] Failed to load widget HTML:', error);
      return false;
    }
  };

  // Wait for platform readiness (telemetry, governance, Alpine.js)
  function initializeHelpChatWidget() {
    if (typeof Alpine === 'undefined') {
      console.warn('[HelpChat] Alpine.js not loaded, retrying...');
      setTimeout(initializeHelpChatWidget, 100);
      return;
    }

    // Define Alpine.js data component
    window.helpChatWidget = function() {
      return {
        // State
        isOpen: false,
        isLoading: false,
        isInitializing: true,
        isIndexing: false,
        isReindexing: false,
  isStatusRefreshing: false,
        sessionId: null,
        messages: [],
        currentMessage: '',
        error: null,
        indexStatus: null,
        reindexMessage: '',
  lastStatusCheck: null,
  panelSize: 'medium',
        providerConfig: null, // Stores help_chat task provider configuration
        lastKnownProviderId: null, // Track provider for change detection
        capabilities: { helpReindex: false },

        // Drag state
        isDragging: false,
        position: { x: null, y: null, right: 24, bottom: 96 },
        dragStart: { mouseX: 0, mouseY: 0, elemX: 0, elemY: 0 },

        // Initialize
        async init() {
          console.log('[HelpChat] Initializing widget...');

          // Load saved position and preferences
          const savedPosition = this.loadPosition();
          if (savedPosition) {
            this.position = savedPosition;
          }

          const savedPrefs = this.loadPreferences();
          if (savedPrefs?.panelSize) {
            this.panelSize = savedPrefs.panelSize;
          }

          await this.loadIdentityCapabilities();
          await Promise.all([
            this.checkIndexStatus(),
            this.loadProviderConfig()
          ]);
          this.isInitializing = false;

          // Setup drag event listeners
          window.addEventListener('mousemove', (e) => this.drag(e));
          window.addEventListener('mouseup', () => this.stopDrag());

          // Allow the Integration Hub shell's "Ask Help Assistant" trigger to open the panel
          window.addEventListener('integration-hub:open-help-assistant', () => {
            window.__ihHelpOpenRequested = false;
            if (!this.isOpen) {
              this.toggleChat();
            }
          });

          // Consume an open request that arrived before this widget finished mounting
          // (the shell's trigger sets the flag; the dispatch above may have been missed).
          if (window.__ihHelpOpenRequested) {
            window.__ihHelpOpenRequested = false;
            if (!this.isOpen) {
              this.toggleChat();
            }
          }
        },

        // Toggle chat window
        toggleChat() {
          this.isOpen = !this.isOpen;
          // Notify the shell so docked mode can reflow page content beside the panel.
          window.dispatchEvent(new CustomEvent('help-chat:toggled', { detail: { isOpen: this.isOpen } }));
          if (this.isOpen) {
            this.$nextTick(() => {
              this.$refs.messageInput?.focus();
            });
          }
        },

        // Check if documentation is indexed
        async checkIndexStatus(silent = false) {
          try {
            const response = await fetch('/api/help/status', {
              method: 'GET',
              credentials: 'include',
              headers: getAuthHeaders()
            });
            const data = await response.json();

            if (data.success) {
              this.indexStatus = data.data;
              this.isIndexing = !this.indexStatus.ready;
              this.lastStatusCheck = new Date();

              if (!this.indexStatus.ready && !silent) {
                console.log('[HelpChat] Documentation still indexing...', this.indexStatus.progress);
              }
              if (this.indexStatus.ready && this.reindexMessage) {
                this.reindexMessage = '';
              }
            }
          } catch (error) {
            console.error('[HelpChat] Failed to check index status:', error);
          }
        },

        async refreshIndexStatus() {
          if (this.isStatusRefreshing) {
            return;
          }
          this.isStatusRefreshing = true;
          try {
            await this.checkIndexStatus();
            await this.loadProviderConfig();
          } finally {
            this.isStatusRefreshing = false;
          }
        },

        async loadIdentityCapabilities() {
          this.capabilities.helpReindex = false;
          try {
            const response = await fetch('/api/identity', {
              method: 'GET',
              credentials: 'include',
              headers: getAuthHeaders()
            });
            if (!response.ok) {
              return;
            }
            const data = await response.json();
            this.capabilities.helpReindex = data?.capabilities?.helpReindex === true;
          } catch (error) {
            console.warn('[HelpChat] Failed to load identity capabilities:', error);
          }
        },

        // Load provider configuration for help_chat task
        async loadProviderConfig() {
          try {
            const response = await fetch('/api/ai-config/tasks?task=help_chat', {
              method: 'GET',
              credentials: 'include'
            });
            const data = await response.json();

            if (data.success && data.data) {
              const newProviderId = data.data.providerId || data.data.providerType;

              // Check if provider changed (and we had a previous provider)
              if (this.lastKnownProviderId && this.lastKnownProviderId !== newProviderId) {
                console.log('[HelpChat] Provider changed from', this.lastKnownProviderId, 'to', newProviderId);
                if (this.capabilities.helpReindex) {
                  this.reindexMessage = 'Provider changed. Reindexing documentation...';
                  // Trigger reindex in background (don't await to avoid blocking)
                  this.reindexDocumentation();
                }
              }

              this.lastKnownProviderId = newProviderId;
              this.providerConfig = data.data;
              console.log('[HelpChat] Provider config loaded:', this.providerConfig);
            } else {
              console.warn('[HelpChat] No provider config found for help_chat task');
              this.providerConfig = null;
            }
          } catch (error) {
            console.error('[HelpChat] Failed to load provider config:', error);
            this.providerConfig = null;
          }
        },

        // Get provider display name
        getProviderName() {
          if (!this.providerConfig || !this.providerConfig.providerType) {
            return 'Not configured';
          }

          const typeMap = {
            'openai': 'OpenAI',
            'claude': 'Anthropic Claude',
            'lmstudio': 'Local LM Studio',
            'rule-based': 'Rule-Based Engine',
            'gemini': 'Google Gemini',
            'grok': 'xAI Grok'
          };

          return typeMap[this.providerConfig.providerType] || this.providerConfig.providerType;
        },

        // Get provider badge text
        getProviderBadge() {
          if (!this.providerConfig) {
            return '';
          }
          return this.providerConfig.isEnvironmentBased ? '(Environment)' : '(Database)';
        },

        async reindexDocumentation() {
          if (!this.capabilities.helpReindex) {
            this.error = null;
            this.reindexMessage = 'Sign in as a platform administrator to reindex documentation.';
            return;
          }

          if (this.isReindexing) {
            return;
          }

          this.isReindexing = true;
          this.error = null;
          this.reindexMessage = '';

          try {
            const response = await fetch('/api/help/reindex', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...getAuthHeaders()
              },
              credentials: 'include'
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok || !data.success) {
              if (response.status === 401 || response.status === 403) {
                this.error = null;
                this.reindexMessage = 'Sign in as a platform administrator to reindex documentation.';
                return;
              }
              const message = data?.error || `Failed to start documentation reindex (status ${response.status})`;
              this.error = message;
              return;
            }

            this.reindexMessage = 'Reindex started. Refreshing documentation index...';
            this.isIndexing = true;
            const previousStats = this.indexStatus?.stats ?? null;
            const previousTotal = this.indexStatus?.progress?.total ?? 0;
            this.indexStatus = {
              ready: false,
              stats: previousStats,
              progress: {
                status: 'indexing',
                indexed: 0,
                failed: 0,
                total: previousTotal
              }
            };
            this.lastStatusCheck = new Date();
            await this.pollIndexStatus();
          } catch (error) {
            this.error = error instanceof Error ? error.message : 'Failed to trigger documentation reindex.';
          } finally {
            this.isReindexing = false;
          }
        },

        async pollIndexStatus(maxAttempts = 60, delayMs = 5000) {
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await this.checkIndexStatus(true);

            if (this.isReady()) {
              this.reindexMessage = 'Documentation index refreshed successfully.';
              this.isIndexing = false;
              setTimeout(() => {
                if (this.reindexMessage === 'Documentation index refreshed successfully.') {
                  this.reindexMessage = '';
                }
              }, 5000);
              return;
            }

            await new Promise(resolve => setTimeout(resolve, delayMs));
          }

          this.reindexMessage = 'Reindex is still running. Check server logs for detailed progress.';
        },

        // Send message
        async sendMessage() {
          if (!this.currentMessage.trim() || this.isLoading) {
            return;
          }

          const userMessage = this.currentMessage.trim();
          this.currentMessage = '';

          // Add user message to UI immediately
          this.messages.push({
            id: 'temp-' + Date.now(),
            role: 'user',
            content: userMessage,
            timestamp: new Date().toISOString()
          });

          this.isLoading = true;
          this.error = null;

          // Scroll to bottom
          this.$nextTick(() => {
            this.scrollToBottom();
          });

          try {
            const response = await fetch('/api/help/chat', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...getAuthHeaders()
              },
              body: JSON.stringify({
                message: userMessage,
                sessionId: this.sessionId
              })
            });

            const data = await response.json();

            if (data.success) {
              // Update session ID
              this.sessionId = data.data.sessionId;

              // Add assistant message
              this.messages.push({
                id: 'response-' + Date.now(),
                role: 'assistant',
                content: data.data.response,
                sources: data.data.sources,
                timestamp: data.data.timestamp
              });
            } else {
              this.error = data.error || 'Failed to get response';
              console.error('[HelpChat] Error:', this.error);
            }
          } catch (error) {
            this.error = 'Network error. Please check your connection.';
            console.error('[HelpChat] Network error:', error);
          } finally {
            this.isLoading = false;
            this.$nextTick(() => {
              this.scrollToBottom();
              this.$refs.messageInput?.focus();
            });
          }
        },

        // Handle Enter key
        handleKeydown(event) {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.sendMessage();
          }
        },

        // Scroll to bottom of messages
        scrollToBottom() {
          const container = this.$refs.messagesContainer;
          if (container) {
            container.scrollTop = container.scrollHeight;
          }
        },

        // Clear conversation
        clearConversation() {
          this.messages = [];
          this.sessionId = null;
          this.error = null;
        },

        // Render markdown (simple implementation)
        renderMarkdown(text) {
          if (!text) return '';

          // Simple markdown rendering (can be enhanced with marked.js)
          return text
            // Code blocks
            .replace(/```(\w+)?\n([\s\S]+?)```/g, '<pre class="bg-gray-100 dark:bg-gray-800 p-3 rounded-lg overflow-x-auto my-2"><code>$2</code></pre>')
            // Inline code
            .replace(/`([^`]+)`/g, '<code class="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-sm">$1</code>')
            // Bold
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            // Italic
            .replace(/\*([^*]+)\*/g, '<em>$1</em>')
            // Links
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="text-blue-600 dark:text-blue-400 hover:underline">$1</a>')
            // Line breaks
            .replace(/\n/g, '<br>');
        },

        // Format timestamp
        formatTime(timestamp) {
          const date = new Date(timestamp);
          return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        },

        // Get status message
        getStatusMessage() {
          if (this.reindexMessage) {
            return this.reindexMessage;
          }
          if (!this.indexStatus) {
            return 'Checking documentation status...';
          }

          if (!this.indexStatus.ready) {
            const progress = this.indexStatus.progress;
            if (progress && progress.total > 0) {
              const percent = Math.round((progress.indexed / progress.total) * 100);
              return `Documentation is being indexed (${percent}%)...`;
            }
            return 'Documentation is being indexed...';
          }

          return 'Ready to help!';
        },

        getStatusBadge() {
          if (!this.indexStatus) {
            return 'checking';
          }
          if (!this.indexStatus.ready) {
            return 'indexing';
          }
          return 'ready';
        },

        getStatusBadgeLabel() {
          const badge = this.getStatusBadge();
          if (badge === 'ready') return 'Ready';
          if (badge === 'indexing') return 'Indexing';
          return 'Checking';
        },

        getStatusBadgeClasses() {
          const badge = this.getStatusBadge();
          if (badge === 'ready') {
            return 'border-green-300 bg-green-600 bg-opacity-20 text-green-50';
          }
          if (badge === 'indexing') {
            return 'border-yellow-300 bg-yellow-500 bg-opacity-20 text-yellow-50';
          }
          return 'border-blue-200 bg-blue-600 bg-opacity-20 text-blue-50';
        },

        getStatusTimestamp() {
          if (!this.lastStatusCheck) {
            return '';
          }
          return `Updated ${this.formatTime(this.lastStatusCheck)}`;
        },

        // Check if ready to chat
        isReady() {
          return this.indexStatus && this.indexStatus.ready;
        },

        togglePanelSize() {
          this.panelSize = this.panelSize === 'large' ? 'medium' : 'large';
          this.savePreferences();
          this.$nextTick(() => {
            this.scrollToBottom();
          });
        },

        getPanelSizeClass() {
          return this.panelSize === 'large' ? 'max-w-3xl' : 'max-w-md';
        },

        getMessageContainerStyle() {
          return this.panelSize === 'large'
            ? { height: '60vh' }
            : { height: '24rem' };
        },

        // Drag methods
        startDrag(event) {
          // In docked mode the panel is pinned by CSS; dragging it would only
          // pollute the shared `helpChatPosition` that the floating assistant on
          // other pages restores. Ignore drags when mounted docked.
          if (event.target.closest && event.target.closest('[data-help-chat-mode="docked"]')) {
            return;
          }
          this.isDragging = true;

          // Get current element position
          const elem = event.target.closest('[x-ref="chatWindow"]');
          if (!elem) return;

          const rect = elem.getBoundingClientRect();

          this.dragStart = {
            mouseX: event.clientX,
            mouseY: event.clientY,
            elemX: rect.left,
            elemY: rect.top
          };

          event.preventDefault();
        },

        drag(event) {
          if (!this.isDragging) return;

          const deltaX = event.clientX - this.dragStart.mouseX;
          const deltaY = event.clientY - this.dragStart.mouseY;

          this.position = {
            x: this.dragStart.elemX + deltaX,
            y: this.dragStart.elemY + deltaY,
            right: null,
            bottom: null
          };
        },

        stopDrag() {
          if (this.isDragging) {
            this.isDragging = false;
            this.savePosition();
          }
        },

        // Get position style for widget
        getPositionStyle() {
          if (this.position.x !== null && this.position.y !== null) {
            return `left: ${this.position.x}px; top: ${this.position.y}px; right: auto; bottom: auto;`;
          } else {
            return `right: ${this.position.right}px; bottom: ${this.position.bottom}px;`;
          }
        },

        // Load position from localStorage
        loadPosition() {
          try {
            const saved = localStorage.getItem('helpChatPosition');
            return saved ? JSON.parse(saved) : null;
          } catch (error) {
            return null;
          }
        },

        // Save position to localStorage
        savePosition() {
          try {
            localStorage.setItem('helpChatPosition', JSON.stringify(this.position));
          } catch (error) {
            console.warn('[HelpChat] Could not save position:', error);
          }
          this.savePreferences();
        },

        loadPreferences() {
          try {
            const raw = localStorage.getItem('helpChatPreferences');
            return raw ? JSON.parse(raw) : null;
          } catch (error) {
            console.warn('[HelpChat] Could not load preferences:', error);
            return null;
          }
        },

        savePreferences() {
          try {
            const existing = this.loadPreferences() || {};
            const prefs = {
              ...existing,
              panelSize: this.panelSize
            };
            localStorage.setItem('helpChatPreferences', JSON.stringify(prefs));
          } catch (error) {
            console.warn('[HelpChat] Could not save preferences:', error);
          }
        }
      };
    };

    console.log('[HelpChat] Widget component registered');
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeHelpChatWidget);
  } else {
    initializeHelpChatWidget();
  }
})();
