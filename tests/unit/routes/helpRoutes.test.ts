import express, { type RequestHandler } from 'express';
import request from 'supertest';

import { createHelpRouter } from '../../../src/routes/help';
import { DocumentationKnowledgeBase } from '../../../src/services/help/DocumentationKnowledgeBase';
import type { DocumentChunk } from '../../../src/services/help/types';

const FALLBACK = 'The help index is still warming up — try the documentation links…';

function chunk(id: string, content: string): DocumentChunk {
  return {
    id,
    // Deliberately NOT a docs/-prefixed path: the inbound-link gate scans
    // tests/ for repo-relative refs, and this fixture path is synthetic.
    filePath: `help-fixtures/${id}.md`,
    title: 'Mapping Guide',
    section: 'Validation',
    content,
    tokenCount: content.split(/\s+/).length,
    metadata: {
      fileType: 'markdown',
      category: 'guide',
      lastModified: new Date('2026-01-01T00:00:00Z'),
    },
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

async function makeHarness(seed: DocumentChunk[], identity?: RequestHandler) {
  const indexer = {
    indexDocumentation: jest.fn<Promise<DocumentChunk[]>, []>().mockResolvedValue(seed),
  };
  const embedding = {
    embed: jest.fn<Promise<number[]>, [string]>().mockResolvedValue([0.1, 0.2]),
    isOpenAIEnabled: jest.fn().mockReturnValue(false),
    clearCache: jest.fn(),
  };
  const vectorStore = {
    store: jest.fn().mockResolvedValue(undefined),
    retrieve: jest.fn().mockResolvedValue([]),
    clear: jest.fn().mockResolvedValue(undefined),
  };
  const knowledgeBase = new DocumentationKnowledgeBase(indexer as never, embedding as never, vectorStore as never);
  await knowledgeBase.indexDocumentation();
  embedding.embed.mockClear();

  const helpChatService = {
    processMessage: jest.fn().mockResolvedValue({
      response: 'authenticated answer',
      sources: [],
      sessionId: 'session-auth',
      timestamp: new Date('2026-01-01T00:00:00Z'),
    }),
    getSession: jest.fn(),
  };
  const telemetry = { recordMetric: jest.fn() };
  const governance = { canExecute: jest.fn().mockResolvedValue(true) };
  const app = express();
  app.use(express.json());
  if (identity) {
    app.use(identity);
  }
  app.use('/api/help', createHelpRouter(
    helpChatService as never,
    knowledgeBase,
    telemetry as never,
    governance as never,
  ));

  return { app, embedding, vectorStore, helpChatService, telemetry, governance };
}

describe('help routes', () => {
  it('answers anonymous chat from local lexical retrieval with zero request-time service calls', async () => {
    const harness = await makeHarness([
      chunk('mapping', 'Field mapping validation checks transformation confidence before deployment.'),
    ]);

    const response = await request(harness.app)
      .post('/api/help/chat')
      .send({ message: 'How does mapping validation work?' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        mode: 'demo_local_retrieval',
        sessionId: null,
      },
    });
    expect(response.body.data.response).toContain('Field mapping validation');
    expect(response.body.data.sources).toEqual([
      expect.objectContaining({
        filePath: 'help-fixtures/mapping.md',
        title: 'Mapping Guide',
        section: 'Validation',
      }),
    ]);
    expect(harness.helpChatService.processMessage).not.toHaveBeenCalled();
    expect(harness.helpChatService.getSession).not.toHaveBeenCalled();
    expect(harness.embedding.embed).not.toHaveBeenCalled();
    expect(harness.vectorStore.retrieve).not.toHaveBeenCalled();
    expect(harness.governance.canExecute).not.toHaveBeenCalled();
    expect(harness.telemetry.recordMetric).not.toHaveBeenCalled();
  });

  it('uses the deterministic warming fallback when local retrieval has no chunks', async () => {
    const harness = await makeHarness([]);

    const response = await request(harness.app)
      .post('/api/help/chat')
      .send({ message: 'Where are the deployment docs?' });

    expect(response.status).toBe(200);
    expect(response.body.data.response).toBe(FALLBACK);
    expect(response.body.data.sources).toEqual([]);
  });

  it('keeps anonymous internal-audience chat forbidden without invoking services', async () => {
    const harness = await makeHarness([
      chunk('internal', 'Internal operations runbook.'),
    ]);

    const response = await request(harness.app)
      .post('/api/help/chat')
      .send({ message: 'Show operations', context: { audience: 'internal' } });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      error: 'internal_audience_requires_auth',
    });
    expect(harness.helpChatService.processMessage).not.toHaveBeenCalled();
    expect(harness.embedding.embed).not.toHaveBeenCalled();
  });

  it('routes authenticated chat through HelpChatService with the narrowed identity', async () => {
    const identity: RequestHandler = (req, _res, next) => {
      req.user = {
        id: 'user-1',
        username: 'user-1',
        tenantId: 'tenant-1',
        roles: ['user'],
        permissions: [],
      };
      next();
    };
    const harness = await makeHarness([], identity);

    const response = await request(harness.app)
      .post('/api/help/chat')
      .send({ message: 'Authenticated question' });

    expect(response.status).toBe(200);
    expect(harness.helpChatService.processMessage).toHaveBeenCalledWith(
      {
        message: 'Authenticated question',
        sessionId: undefined,
        context: undefined,
      },
      { userId: 'user-1', tenantId: 'tenant-1' },
    );
    expect(response.body.data.sessionId).toBe('session-auth');
  });

  it('fails closed when a populated req.user lacks a complete tenant identity', async () => {
    const identity: RequestHandler = (req, _res, next) => {
      req.user = {
        id: 'user-1',
        username: 'user-1',
        roles: ['user'],
        permissions: [],
      };
      next();
    };
    const harness = await makeHarness([], identity);

    const response = await request(harness.app)
      .post('/api/help/chat')
      .send({ message: 'Incomplete identity' });

    expect(response.status).toBe(401);
    expect(harness.helpChatService.processMessage).not.toHaveBeenCalled();
  });
});
