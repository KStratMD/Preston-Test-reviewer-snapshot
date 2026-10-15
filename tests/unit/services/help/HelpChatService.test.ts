import {
  HelpChatService,
  InternalAudienceAuthorizationError,
} from 'src/services/help/HelpChatService';
import { SYSTEM_IDENTITY, type IdentityContext } from 'src/services/governance/identityContext';
import type { DocumentChunk, DocumentRetrievalResult } from 'src/services/help/types';
import type { WikiContentIndex } from 'src/services/help/WikiContentIndex';
import { getDeploymentOptionsKnowledgeNode } from 'src/services/help/deploymentOptionsKnowledgeManifest';

const docResult: DocumentRetrievalResult = {
  chunk: {
    id: 'doc-1',
    filePath: 'docs/example.md',
    title: 'Example',
    section: 'Usage',
    content: 'Integration Hub help content',
    tokenCount: 4,
    metadata: {
      fileType: 'markdown',
      category: 'docs',
      lastModified: new Date('2026-01-01T00:00:00Z'),
    },
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  similarity: 0.9,
  rank: 1,
};

interface CreateServiceOptions {
  chat?: jest.Mock;
  exactPathChunks?: DocumentChunk[];
  wikiEntries?: { slug: string; title: string; filePath: string; tags: string[]; excerpt: string }[];
}

function createService(options: CreateServiceOptions = {}) {
  const chat = options.chat ?? jest.fn().mockResolvedValue({ content: 'answer' });
  const findSimilarChunks = jest.fn().mockResolvedValue([docResult]);
  const getChunksByFilePaths = jest.fn().mockReturnValue(options.exactPathChunks ?? []);
  const knowledgeBase = {
    isReady: jest.fn().mockReturnValue(true),
    getIndexingProgress: jest.fn(),
    findSimilarChunks,
    getChunksByFilePaths,
  };
  const providerRegistry = {
    getAvailableProvider: jest.fn().mockResolvedValue({
      id: 'mock-provider',
      provider: {
        name: 'MockProvider',
        chat,
      },
    }),
  };
  const wikiIndex: Pick<WikiContentIndex, 'findEntriesByPaths' | 'findEntriesByTags'> = {
    findEntriesByPaths: jest.fn().mockReturnValue(options.wikiEntries ?? []),
    findEntriesByTags: jest.fn().mockReturnValue([]),
  };

  return {
    service: new HelpChatService(
      knowledgeBase as never,
      providerRegistry as never,
      wikiIndex as never,
    ),
    chat,
    findSimilarChunks,
    getChunksByFilePaths,
    wikiIndex,
  };
}

function makeChunk(overrides: Partial<DocumentChunk> = {}): DocumentChunk {
  return {
    id: 'exact-1',
    filePath: 'docs/features/help-chat-system.md',
    title: 'Help Chat System',
    section: 'Overview',
    content: 'Exact-path boosted content about the help chat system.',
    tokenCount: 8,
    metadata: {
      fileType: 'markdown',
      category: 'features',
      lastModified: new Date('2026-01-01T00:00:00Z'),
    },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Concatenate all prompt strings passed to the chat() mock. */
function promptText(chat: jest.Mock): string {
  const calls = chat.mock.calls;
  let text = '';
  for (const call of calls) {
    const messages = call[0] as { role: string; content: string }[];
    for (const m of messages) {
      text += `\n${m.content}`;
    }
  }
  return text;
}

describe('HelpChatService identity propagation', () => {
  it('passes provided identity context to the chat provider', async () => {
    const { service, chat } = createService();
    const identity: IdentityContext = { tenantId: 'tenant-1', userId: 'user-1' };

    await service.processMessage({ message: 'How do I map fields?' }, identity);

    expect(chat).toHaveBeenCalledWith(
      expect.any(Array),
      { maxTokens: 1000, temperature: 0.7 },
      identity,
    );
  });

  it('passes SYSTEM_IDENTITY to the chat provider when no identity is supplied', async () => {
    const { service, chat } = createService();

    await service.processMessage({ message: 'How do I map fields?' });

    expect(chat).toHaveBeenCalledWith(
      expect.any(Array),
      { maxTokens: 1000, temperature: 0.7 },
      SYSTEM_IDENTITY,
    );
  });
});

describe('HelpChatService architecture context', () => {
  const NODE_ID = 'ai-intelligence';
  const authedIdentity: IdentityContext = { tenantId: 'tenant-1', userId: 'user-1' };

  it('includes public node context and returns audience public', async () => {
    const { service, getChunksByFilePaths, wikiIndex } = createService({
      exactPathChunks: [makeChunk()],
      wikiEntries: [
        {
          slug: 'pages/concepts/embedded-intelligence',
          title: 'Embedded Intelligence',
          filePath: 'pages/concepts/embedded-intelligence.md',
          tags: ['embedded-intelligence'],
          excerpt: 'Wiki excerpt about embedded intelligence.',
        },
      ],
    });

    const response = await service.processMessage(
      {
        message: 'How does the help knowledge base answer questions?',
        context: { surface: 'code-architecture-dashboard', nodeId: NODE_ID, audience: 'public' },
      },
      SYSTEM_IDENTITY,
    );

    expect(response.audience).toBe('public');
    expect(response.nodeId).toBe(NODE_ID);
    expect(response.relatedNodes).toEqual(
      expect.arrayContaining(['http-api-edge', 'governance-safety', 'core-application-services']),
    );
    expect(response.suggestedFollowUps?.length).toBeGreaterThan(0);
    expect(response.evidence?.some(e => e.reason === 'exact-path boost')).toBe(true);
    expect(response.evidence?.some(e => e.reason === 'wiki index')).toBe(true);
    // Exact-path retrieval was asked for the node's docPaths.
    expect(getChunksByFilePaths).toHaveBeenCalled();
    expect(wikiIndex.findEntriesByPaths).toHaveBeenCalled();
  });

  it('does NOT leak internal source files into the prompt on the public path', async () => {
    const { service, chat } = createService({ exactPathChunks: [makeChunk()] });

    await service.processMessage(
      {
        message: 'How does the help knowledge base answer questions?',
        context: { surface: 'code-architecture-dashboard', nodeId: NODE_ID, audience: 'public' },
      },
      SYSTEM_IDENTITY,
    );

    const prompt = promptText(chat);
    // sourceFiles for ai-intelligence include this very file path.
    expect(prompt).not.toContain('src/services/help/HelpChatService.ts');
    expect(prompt).not.toContain('npm run audit');
  });

  it('adds internal enrichment to the prompt when authenticated', async () => {
    const { service, chat } = createService({ exactPathChunks: [makeChunk()] });

    const response = await service.processMessage(
      {
        message: 'What indexing strategy does the knowledge base use?',
        context: { surface: 'code-architecture-dashboard', nodeId: NODE_ID, audience: 'internal' },
      },
      authedIdentity,
    );

    expect(response.audience).toBe('internal');
    const prompt = promptText(chat);
    // An internal marker (a sourceFile path) must reach the LLM call args.
    expect(prompt).toContain('src/services/help/HelpChatService.ts');
    expect(response.evidence?.some(e => e.audience === 'internal')).toBe(true);
  });

  it('rejects internal audience for anonymous/system identity with a typed error', async () => {
    const { service } = createService();

    await expect(
      service.processMessage(
        {
          message: 'internal question',
          context: { surface: 'code-architecture-dashboard', nodeId: NODE_ID, audience: 'internal' },
        },
        SYSTEM_IDENTITY,
      ),
    ).rejects.toBeInstanceOf(InternalAudienceAuthorizationError);
  });

  it('rejects internal audience when no identity context is supplied', async () => {
    const { service } = createService();

    await expect(
      service.processMessage({
        message: 'internal question',
        context: { surface: 'code-architecture-dashboard', nodeId: NODE_ID, audience: 'internal' },
      }),
    ).rejects.toBeInstanceOf(InternalAudienceAuthorizationError);
  });

  it('falls back to ordinary retrieval for an unknown nodeId without throwing', async () => {
    const { service, getChunksByFilePaths } = createService();

    const response = await service.processMessage(
      {
        message: 'How do I map fields?',
        context: { surface: 'code-architecture-dashboard', nodeId: 'no-such-node', audience: 'public' },
      },
      SYSTEM_IDENTITY,
    );

    expect(response.response).toBe('answer');
    // No node → no exact-path boost call.
    expect(getChunksByFilePaths).not.toHaveBeenCalled();
  });

  it('normalizes wiki evidence filePath to /wiki/<slug>.html served URL', async () => {
    // Inject a wiki entry with a bare slug (the shape produced by WikiContentIndex).
    const { service } = createService({
      exactPathChunks: [makeChunk()],
      wikiEntries: [
        {
          slug: 'pages/concepts/embedded-intelligence',
          title: 'Embedded Intelligence',
          filePath: 'pages/concepts/embedded-intelligence.md',
          tags: ['embedded-intelligence'],
          excerpt: 'Wiki excerpt about embedded intelligence.',
        },
      ],
    });

    const response = await service.processMessage(
      {
        message: 'What is embedded intelligence?',
        context: { surface: 'code-architecture-dashboard', nodeId: NODE_ID, audience: 'public' },
      },
      SYSTEM_IDENTITY,
    );

    const wikiEvidence = response.evidence?.find(e => e.reason === 'wiki index');
    expect(wikiEvidence).toBeDefined();
    // The served URL must use /wiki/ prefix and .html extension — no raw .md slug.
    expect(wikiEvidence?.filePath).toBe('/wiki/pages/concepts/embedded-intelligence.html');
  });
});

describe('session tenant binding', () => {
  it('does not return a session to a different tenant', async () => {
    const { service } = createService();
    const resA = await service.processMessage(
      { message: 'hello' },
      { tenantId: 'tenant-a', userId: 'u1' },
    );

    const stolen = service.getSession(resA.sessionId, { tenantId: 'tenant-b', userId: 'u2' });
    expect(stolen).toBeUndefined();

    const legit = service.getSession(resA.sessionId, { tenantId: 'tenant-a', userId: 'u1' });
    expect(legit).toBeDefined();
  });

  it("does not attach a different tenant's message to an existing session", async () => {
    const { service } = createService();
    const resA = await service.processMessage(
      { message: 'hello' },
      { tenantId: 'tenant-a', userId: 'u1' },
    );
    const resB = await service.processMessage(
      { message: 'intruder', sessionId: resA.sessionId },
      { tenantId: 'tenant-b', userId: 'u2' },
    );

    // Cross-tenant sessionId reuse must mint a NEW session, not append.
    expect(resB.sessionId).not.toBe(resA.sessionId);

    // The original tenant-a session must not have absorbed the intruder message…
    const original = service.getSession(resA.sessionId, { tenantId: 'tenant-a', userId: 'u1' });
    expect(original).toBeDefined();
    expect(original?.messages.map(m => m.content)).not.toContain('intruder');

    // …and tenant-b can read its own newly minted session, which carries it.
    const minted = service.getSession(resB.sessionId, { tenantId: 'tenant-b', userId: 'u2' });
    expect(minted).toBeDefined();
    expect(minted?.messages.map(m => m.content)).toContain('intruder');
  });
});

describe('HelpChatService deployment options dashboard context', () => {
  it('enriches the deployment dashboard surface with node-specific evidence', async () => {
    const tier2Node = getDeploymentOptionsKnowledgeNode('tier-2-enhance-synccentral');
    if (!tier2Node) throw new Error('tier-2 node missing from deployment manifest');
    const exactChunk = makeChunk({
      filePath: tier2Node.docPaths[0],
      title: 'SuiteCentral 2 Deployment Options',
      section: 'First-to-Bill Wedge',
      content: 'Tier 2 is the first-to-bill wedge: Sync Error AI Assist, then AI Field Mapping.',
    });
    const { service, chat, getChunksByFilePaths } = createService({
      exactPathChunks: [exactChunk],
    });

    const response = await service.processMessage(
      {
        message: 'Why is Tier 2 first?',
        context: {
          surface: 'suitecentral-deployment-options-dashboard',
          nodeId: 'tier-2-enhance-synccentral',
          audience: 'public',
        },
      },
      SYSTEM_IDENTITY,
    );

    expect(response.audience).toBe('public');
    expect(response.nodeId).toBe('tier-2-enhance-synccentral');
    expect(response.relatedNodes).toEqual(
      expect.arrayContaining(['squire-product-fit', 'netsuite-path', 'pilot-gates']),
    );
    expect(response.suggestedFollowUps).toEqual(
      expect.arrayContaining(['Why should Sync Error AI Assist come before AI Field Mapping?']),
    );
    expect(response.evidence?.some(e => e.reason === 'exact-path boost')).toBe(true);
    expect(getChunksByFilePaths).toHaveBeenCalledWith(
      expect.arrayContaining(tier2Node.docPaths),
      2,
    );

    const prompt = promptText(chat);
    expect(prompt).toContain('DEPLOYMENT OPTION NODE: Tier 2: First-to-Bill Wedge');
    expect(prompt).toContain('NetSuite Sync Error AI Assist first, then AI Field Mapping');
  });

  it('falls back to ordinary retrieval for an unknown deployment node', async () => {
    const { service, getChunksByFilePaths } = createService();

    const response = await service.processMessage(
      {
        message: 'What is the pilot?',
        context: {
          surface: 'suitecentral-deployment-options-dashboard',
          nodeId: 'no-such-node',
          audience: 'public',
        },
      },
      SYSTEM_IDENTITY,
    );

    expect(response.response).toBe('answer');
    expect(response.nodeId).toBeUndefined();
    expect(getChunksByFilePaths).not.toHaveBeenCalled();
  });
});
