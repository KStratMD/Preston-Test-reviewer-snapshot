import request from 'supertest';
import express from 'express';
import { createAIProviderRouter } from '../aiProvider';

jest.mock('../../services/ai/AIProviderConfigService', () => ({
  AIProviderConfigService: jest.fn().mockImplementation(() => ({
    getProviders: jest.fn().mockResolvedValue([
      { id: 'provider1', name: 'Provider 1' },
      { id: 'provider2', name: 'Provider 2' },
    ]),
  })),
}));

describe('/api/ai/providers', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    const router = createAIProviderRouter();
    app.use('/api/ai/providers', router);
  });

  describe('GET /', () => {
    it('should return a list of AI providers', async () => {
      const response = await request(app).get('/api/ai/providers');

      expect(response.status).toBe(200);
    });
  });
});
