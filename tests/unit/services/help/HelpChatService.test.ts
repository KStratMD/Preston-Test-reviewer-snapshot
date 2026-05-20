import { HelpChatService } from 'src/services/help/HelpChatService';
import { SYSTEM_IDENTITY, type IdentityContext } from 'src/services/governance/identityContext';
import type { DocumentRetrievalResult } from 'src/services/help/types';

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

function createService(chat = jest.fn().mockResolvedValue({ content: 'answer' })) {
  const knowledgeBase = {
    isReady: jest.fn().mockReturnValue(true),
    getIndexingProgress: jest.fn(),
    findSimilarChunks: jest.fn().mockResolvedValue([docResult]),
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

  return {
    service: new HelpChatService(knowledgeBase as never, providerRegistry as never),
    chat,
  };
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
