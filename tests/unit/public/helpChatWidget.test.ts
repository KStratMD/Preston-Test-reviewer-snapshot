import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

interface Widget {
  capabilities: { helpReindex: boolean };
  error: string | null;
  reindexMessage: string;
  lastKnownProviderId: string | null;
  currentMessage: string;
  $nextTick?: (cb: () => void) => void;
  init(): Promise<void>;
  loadIdentityCapabilities(): Promise<void>;
  loadProviderConfig(): Promise<void>;
  reindexDocumentation(): Promise<void>;
  pollIndexStatus(): Promise<void>;
  checkIndexStatus(silent?: boolean): Promise<void>;
  sendMessage(): Promise<void>;
}

type JsonResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

function response(body: unknown, status = 200): JsonResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function loadWidget(fetchMock: jest.Mock, localToken?: string, sessionToken?: string): Widget {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'public/components/help-chat-widget.js'),
    'utf8',
  );
  const windowObject: Record<string, unknown> = {
    addEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  };
  const context = vm.createContext({
    window: windowObject,
    document: {
      readyState: 'complete',
      addEventListener: jest.fn(),
      getElementById: jest.fn(),
    },
    localStorage: {
      getItem: jest.fn((key: string) => key === 'auth_token' ? localToken ?? null : null),
      setItem: jest.fn(),
    },
    sessionStorage: {
      getItem: jest.fn((key: string) => key === 'auth_token' ? sessionToken ?? null : null),
      setItem: jest.fn(),
    },
    Alpine: {},
    DOMParser: class {},
    CustomEvent: class {
      constructor(
        readonly type: string,
        readonly init?: { detail?: unknown },
      ) {}
    },
    fetch: fetchMock,
    console: {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    setTimeout: jest.fn(),
    Date,
    Error,
    JSON,
  });

  vm.runInContext(source, context);
  const factory = windowObject.helpChatWidget;
  if (typeof factory !== 'function') {
    throw new Error('helpChatWidget factory was not registered');
  }
  return factory() as Widget;
}

describe('help chat widget reindex capability', () => {
  it('hides the Reindex button behind the identity capability', () => {
    const html = fs.readFileSync(
      path.resolve(process.cwd(), 'public/help-chat-widget.html'),
      'utf8',
    );

    expect(html).toMatch(/x-show="capabilities\.helpReindex"[\s\S]*@click="reindexDocumentation\(\)"/);
  });

  it('defaults to no reindex capability and does not POST when called directly', async () => {
    const fetchMock = jest.fn();
    const widget = loadWidget(fetchMock);

    expect(widget.capabilities).toEqual({ helpReindex: false });

    await widget.reindexDocumentation();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(widget.reindexMessage).toMatch(/platform administrator|sign in/i);
  });

  it('POSTs reindex when an administrator calls the method directly', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response({ success: true }));
    const widget = loadWidget(fetchMock);
    widget.capabilities.helpReindex = true;
    widget.pollIndexStatus = jest.fn().mockResolvedValue(undefined);

    await widget.reindexDocumentation();

    expect(fetchMock).toHaveBeenCalledWith('/api/help/reindex', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }));
  });

  it('forwards a localStorage bearer token through identity and reindex requests', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url === '/api/identity') {
        return response({ capabilities: { helpReindex: true } });
      }
      return response({ success: true });
    });
    const widget = loadWidget(fetchMock, 'local-token');
    widget.pollIndexStatus = jest.fn().mockResolvedValue(undefined);

    await widget.loadIdentityCapabilities();
    await widget.reindexDocumentation();

    expect(widget.capabilities).toEqual({ helpReindex: true });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/identity', expect.objectContaining({
      credentials: 'include',
      headers: { Authorization: 'Bearer local-token' },
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/help/reindex', expect.objectContaining({
      credentials: 'include',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer local-token',
      },
    }));
  });

  it('forwards the bearer token through status and chat requests (Codex R1)', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url === '/api/help/status') {
        return response({
          success: true,
          data: { ready: true, stats: {}, progress: { status: 'completed', indexed: 1, total: 1, failed: 0 } },
        });
      }
      return response({
        success: true,
        data: { sessionId: 's1', response: 'answer', sources: [], timestamp: new Date().toISOString() },
      });
    });
    const widget = loadWidget(fetchMock, 'local-token');
    // No-op: the $nextTick callbacks only do scroll/focus DOM work ($refs is
    // Alpine-populated and absent in this vm harness).
    widget.$nextTick = () => {};

    await widget.checkIndexStatus();
    widget.currentMessage = 'How does mapping work?';
    await widget.sendMessage();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/help/status', expect.objectContaining({
      credentials: 'include',
      headers: { Authorization: 'Bearer local-token' },
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/help/chat', expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer local-token',
      },
    }));
  });

  it('falls back to a sessionStorage bearer token when localStorage is empty', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response({ capabilities: { helpReindex: false } }));
    const widget = loadWidget(fetchMock, undefined, 'session-token');

    await widget.loadIdentityCapabilities();

    expect(fetchMock).toHaveBeenCalledWith('/api/identity', expect.objectContaining({
      headers: { Authorization: 'Bearer session-token' },
    }));
  });

  it('loads identity before provider and status requests during init', async () => {
    const urls: string[] = [];
    const fetchMock = jest.fn(async (url: string) => {
      urls.push(url);
      if (url === '/api/identity') {
        return response({ capabilities: { helpReindex: true } });
      }
      if (url.startsWith('/api/ai-config/')) {
        return response({ success: true, data: { providerId: 'local', providerType: 'rule-based' } });
      }
      return response({
        success: true,
        data: {
          ready: true,
          stats: {},
          progress: { status: 'completed', indexed: 1, total: 1, failed: 0 },
        },
      });
    });
    const widget = loadWidget(fetchMock);

    await widget.init();

    expect(urls[0]).toBe('/api/identity');
    expect(urls).toEqual(expect.arrayContaining([
      '/api/help/status',
      '/api/ai-config/tasks?task=help_chat',
    ]));
    expect(widget.capabilities).toEqual({ helpReindex: true });
  });

  it('gates provider-change auto-reindex and its message for non-admins', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response({
      success: true,
      data: { providerId: 'new-provider', providerType: 'rule-based' },
    }));
    const widget = loadWidget(fetchMock);
    widget.lastKnownProviderId = 'old-provider';
    widget.reindexDocumentation = jest.fn().mockResolvedValue(undefined);

    await widget.loadProviderConfig();

    expect(widget.reindexDocumentation).not.toHaveBeenCalled();
    expect(widget.reindexMessage).toBe('');
  });

  it('auto-reindexes after a provider change for an administrator', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response({
      success: true,
      data: { providerId: 'new-provider', providerType: 'rule-based' },
    }));
    const widget = loadWidget(fetchMock);
    widget.capabilities.helpReindex = true;
    widget.lastKnownProviderId = 'old-provider';
    widget.reindexDocumentation = jest.fn().mockResolvedValue(undefined);

    await widget.loadProviderConfig();

    expect(widget.reindexDocumentation).toHaveBeenCalledTimes(1);
    expect(widget.reindexMessage).toMatch(/provider changed/i);
  });

  it.each([401, 403])('shows a clear authorization notice for HTTP %i', async status => {
    const fetchMock = jest.fn().mockResolvedValue(response({}, status));
    const widget = loadWidget(fetchMock);
    widget.capabilities.helpReindex = true;
    widget.pollIndexStatus = jest.fn().mockResolvedValue(undefined);

    await widget.reindexDocumentation();

    expect(widget.error).toBeNull();
    expect(widget.reindexMessage).toMatch(/sign in|platform administrator/i);
  });
});
