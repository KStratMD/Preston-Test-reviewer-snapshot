/**
 * Help Chat Service
 * Orchestrates AI-powered help chat using RAG and ProviderRegistry
 */

import { uuidv4 } from '../../utils/uuid';
import { logger } from '../../utils/Logger';
import { DocumentationKnowledgeBase } from './DocumentationKnowledgeBase';
import { ProviderRegistry } from '../ai/ProviderRegistry';
import { SYSTEM_IDENTITY, type IdentityContext } from '../governance/identityContext';
import type {
  HelpChatMessage,
  HelpChatSession,
  HelpChatRequest,
  HelpChatResponse,
  DocumentSource
} from './types';

/**
 * Session store for help chat conversations
 */
class HelpChatSessionStore {
  private sessions = new Map<string, HelpChatSession>();
  private readonly SESSION_TTL = 15 * 60 * 1000; // 15 minutes

  constructor() {
    // Cleanup expired sessions every 5 minutes
    const cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000);
    cleanupTimer.unref?.();
  }

  getSession(sessionId: string): HelpChatSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date();
    }
    return session;
  }

  createSession(): HelpChatSession {
    const session: HelpChatSession = {
      id: uuidv4(),
      messages: [],
      createdAt: new Date(),
      lastActivityAt: new Date()
    };
    this.sessions.set(session.id, session);
    return session;
  }

  updateSession(sessionId: string, messages: HelpChatMessage[]): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = messages;
      session.lastActivityAt = new Date();
    }
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt.getTime() > this.SESSION_TTL) {
        expiredSessions.push(id);
      }
    }

    for (const id of expiredSessions) {
      this.sessions.delete(id);
    }

    if (expiredSessions.length > 0) {
      logger.debug(`Cleaned up ${expiredSessions.length} expired help chat sessions`);
    }
  }
}

export class HelpChatService {
  private knowledgeBase: DocumentationKnowledgeBase;
  private providerRegistry: ProviderRegistry;
  private sessionStore: HelpChatSessionStore;

  constructor(
    knowledgeBase: DocumentationKnowledgeBase,
    providerRegistry: ProviderRegistry
  ) {
    this.knowledgeBase = knowledgeBase;
    this.providerRegistry = providerRegistry;
    this.sessionStore = new HelpChatSessionStore();
  }

  /**
   * Process a help chat message
   */
  async processMessage(request: HelpChatRequest, ctx?: IdentityContext): Promise<HelpChatResponse> {
    const startTime = Date.now();

    // Get or create session
    let session: HelpChatSession;
    if (request.sessionId) {
      session = this.sessionStore.getSession(request.sessionId) || this.sessionStore.createSession();
    } else {
      session = this.sessionStore.createSession();
    }

    // Add user message to session
    const userMessage: HelpChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: request.message,
      timestamp: new Date()
    };
    session.messages.push(userMessage);

    try {
      // Check if knowledge base is ready
      if (!this.knowledgeBase.isReady()) {
        const progress = this.knowledgeBase.getIndexingProgress();
        throw new Error(`Documentation is still being indexed (${progress.indexed}/${progress.total}). Please try again in a moment.`);
      }

      // Retrieve relevant documentation chunks using RAG
      logger.debug('Retrieving similar documentation for query', { query: request.message });
      const similarChunks = await this.knowledgeBase.findSimilarChunks(request.message, 5, 0.5);

      if (similarChunks.length === 0) {
        // No relevant documentation found
        const noResultsResponse = "I couldn't find specific documentation related to your question. Could you please rephrase your question or ask about a specific feature of the Integration Hub?";

        const assistantMessage: HelpChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: noResultsResponse,
          sources: [],
          timestamp: new Date()
        };
        session.messages.push(assistantMessage);
        this.sessionStore.updateSession(session.id, session.messages);

        return {
          response: noResultsResponse,
          sources: [],
          sessionId: session.id,
          timestamp: new Date()
        };
      }

      // Build context from retrieved chunks
      const context = this.buildContext(similarChunks.map(r => r.chunk.content));

      // Get AI response using direct OpenAI API call
      logger.debug('Generating AI response for help chat');
      const aiResponse = await this.generateResponse(
        request.message,
        context,
        session.messages.slice(0, -1),
        ctx ?? SYSTEM_IDENTITY
      );

      // Extract sources from similar chunks
      const sources: DocumentSource[] = similarChunks.slice(0, 3).map(result => ({
        filePath: result.chunk.filePath,
        title: result.chunk.title,
        section: result.chunk.section,
        similarity: result.similarity
      }));

      // Add assistant message to session
      const assistantMessage: HelpChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: aiResponse,
        sources,
        timestamp: new Date()
      };
      session.messages.push(assistantMessage);
      this.sessionStore.updateSession(session.id, session.messages);

      const duration = Date.now() - startTime;
      logger.info('Help chat response generated', {
        sessionId: session.id,
        chunksRetrieved: similarChunks.length,
        duration
      });

      return {
        response: aiResponse,
        sources,
        sessionId: session.id,
        timestamp: new Date()
      };
    } catch (error) {
      logger.error('Failed to process help chat message', { error, sessionId: session.id });

      // Add error message to session
      const errorMessage: HelpChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: `I encountered an error processing your question: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`,
        sources: [],
        timestamp: new Date()
      };
      session.messages.push(errorMessage);
      this.sessionStore.updateSession(session.id, session.messages);

      throw error;
    }
  }

  /**
   * Generate AI response using ProviderRegistry and configured task routing
   */
  private async generateResponse(
    question: string,
    context: string,
    conversationHistory: HelpChatMessage[],
    ctx: IdentityContext
  ): Promise<string> {
    const systemMessage = 'You are a helpful documentation assistant for the Integration Hub platform. Answer user questions based on the provided documentation.';
    const userPrompt = this.buildPrompt(question, context, conversationHistory);

    // Get an available provider from the registry
    // In the future, this could check AIConfigurationService for help_chat task-specific config
    const providerResult = await this.providerRegistry.getAvailableProvider();

    if (!providerResult) {
      logger.warn('No AI providers available for help_chat task, using fallback');
      return `I'm here to help with the Integration Hub documentation. However, AI providers are not configured. Please refer to the documentation directly or configure an AI provider in the AI Configuration Dashboard.

Here are the relevant sections I found:
${context.substring(0, 500)}...`;
    }

    const { provider, id: providerId } = providerResult;

    try {
      // Build message array for chat() method
      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userPrompt }
      ];

      // Use the provider's chat() method
      logger.info('Calling help_chat provider', {
        providerId,
        providerName: provider.name,
        messageCount: messages.length
      });

      // Cast to access chat() method (it's on the actual provider implementation)
      const chatProvider = provider as any;
      if (typeof chatProvider.chat !== 'function') {
        throw new Error(`Provider ${providerId} does not support chat() method`);
      }

      const response = await chatProvider.chat(messages, {
        maxTokens: 1000,
        temperature: 0.7
      }, ctx);

      return response.content;

    } catch (error) {
      logger.error('Help chat provider call failed', {
        providerId,
        error: error instanceof Error ? error.message : String(error)
      });

      // Fallback to context-only response
      return `I encountered an error while generating a response. Here are the relevant documentation sections I found:

${context.substring(0, 500)}...

Please try again or refer to the documentation directly.`;
    }
  }

  /**
   * Build context string from retrieved documentation chunks
   */
  private buildContext(chunks: string[]): string {
    return chunks
      .map((chunk, index) => `[Document ${index + 1}]\n${chunk}`)
      .join('\n\n---\n\n');
  }

  /**
   * Build prompt for AI provider
   */
  private buildPrompt(question: string, context: string, conversationHistory: HelpChatMessage[]): string {
    let prompt = `You are a helpful assistant for the Integration Hub platform. Answer user questions based on the provided documentation.

DOCUMENTATION CONTEXT:
${context}

`;

    // Add conversation history if available
    if (conversationHistory.length > 0) {
      prompt += `CONVERSATION HISTORY:\n`;
      for (const msg of conversationHistory.slice(-4)) { // Last 4 messages for context
        prompt += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
      }
      prompt += '\n';
    }

    prompt += `CURRENT QUESTION:
${question}

INSTRUCTIONS:
- Answer the question based on the documentation context provided above
- Be concise and helpful
- If the documentation doesn't contain the answer, say so clearly
- Use markdown formatting for code examples and lists
- Do NOT mention the document numbers or context structure in your response
`;

    return prompt;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): HelpChatSession | undefined {
    return this.sessionStore.getSession(sessionId);
  }
}
