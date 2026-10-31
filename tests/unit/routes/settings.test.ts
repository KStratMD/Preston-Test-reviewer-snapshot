/**
 * Settings Routes Unit Tests
 * HTTP-level tests: public GET contracts stay open; personal POST writes
 * require a verified identity; the public demo-mode mutation is removed.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

// Create mock functions at module level for hoisting
const mockGetDemoMode = jest.fn();
const mockSetDemoMode = jest.fn();
const mockGetDataset = jest.fn();
const mockSetDataset = jest.fn();
const mockGetUserSettings = jest.fn();
const mockUpdateUserSettings = jest.fn();
const mockResetToDefaults = jest.fn();
const mockListDatasets = jest.fn();
const mockGetTrainingExamples = jest.fn();

// Mutable identity so one suite covers both anonymous and authenticated calls.
let authenticatedUser: { id: string } | undefined;

jest.mock('../../../src/middleware/auth', () => ({
  authMiddleware: (req: Request, res: Response, next: NextFunction) => {
    if (!authenticatedUser) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    (req as Request & { user?: { id: string } }).user = authenticatedUser;
    next();
  },
}));

jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    getAsync: jest.fn().mockImplementation((type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('DemoModeService')) {
        return Promise.resolve({
          getDemoMode: mockGetDemoMode,
          setDemoMode: mockSetDemoMode,
        });
      }
      // Check MCPUserSettingsService before UserSettingsService: the former
      // string contains the latter, so a substring match would misroute it.
      if (typeName.includes('MCPUserSettingsService')) {
        return Promise.resolve({
          getUserSettings: mockGetUserSettings,
          updateUserSettings: mockUpdateUserSettings,
          resetToDefaults: mockResetToDefaults,
        });
      }
      if (typeName.includes('UserSettingsService')) {
        return Promise.resolve({
          getDataset: mockGetDataset,
          setDataset: mockSetDataset,
        });
      }
      return Promise.resolve({});
    }),
    get: jest.fn().mockImplementation((type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('TrainingDataRepository')) {
        return {
          listDatasets: mockListDatasets,
          getTrainingExamples: mockGetTrainingExamples,
        };
      }
      return {};
    }),
  },
}));

jest.mock('../../../src/inversify/types', () => ({
  TYPES: {
    DemoModeService: Symbol.for('DemoModeService'),
    UserSettingsService: Symbol.for('UserSettingsService'),
    MCPUserSettingsService: Symbol.for('MCPUserSettingsService'),
    TrainingDataRepository: Symbol.for('TrainingDataRepository'),
  },
}));

jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

import { createSettingsRouter } from '../../../src/routes/settings';

async function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', await createSettingsRouter());
  return app;
}

describe('Settings Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authenticatedUser = undefined;
  });

  describe('public read contracts', () => {
    it('keeps GET /demo-mode public', async () => {
      mockGetDemoMode.mockResolvedValue(true);
      await request(await buildApp()).get('/api/settings/demo-mode').expect(200, { enabled: true });
    });

    it('returns current dataset (public GET)', async () => {
      mockGetDataset.mockResolvedValue('custom-dataset');
      await request(await buildApp())
        .get('/api/settings/ai/dataset')
        .expect(200, { datasetId: 'custom-dataset' });
    });

    it('returns default when no dataset set', async () => {
      mockGetDataset.mockResolvedValue(null);
      await request(await buildApp())
        .get('/api/settings/ai/dataset')
        .expect(200, { datasetId: 'default' });
    });

    it('lists datasets', async () => {
      const datasets = [
        { id: 'ds1', name: 'Dataset 1' },
        { id: 'ds2', name: 'Dataset 2' },
      ];
      mockListDatasets.mockResolvedValue(datasets);
      await request(await buildApp()).get('/api/settings/ai/datasets').expect(200, { datasets });
    });

    it('returns empty datasets list on error (fail-open)', async () => {
      mockListDatasets.mockRejectedValue(new Error('Failed'));
      await request(await buildApp()).get('/api/settings/ai/datasets').expect(200, { datasets: [] });
    });

    it('returns dataset examples with clamped limit', async () => {
      const examples = [{ input: 'test', output: 'result' }];
      mockGetTrainingExamples.mockResolvedValue(examples);
      await request(await buildApp())
        .get('/api/settings/ai/datasets/ds1/examples?limit=100')
        .expect(200, { examples });
      expect(mockGetTrainingExamples).toHaveBeenCalledWith({ datasetId: 'ds1', limit: 25 });
    });

    it('defaults examples limit to 5', async () => {
      mockGetTrainingExamples.mockResolvedValue([]);
      await request(await buildApp())
        .get('/api/settings/ai/datasets/ds1/examples')
        .expect(200, { examples: [] });
      expect(mockGetTrainingExamples).toHaveBeenCalledWith({ datasetId: 'ds1', limit: 5 });
    });
  });

  describe('demo-mode mutation is removed from the public router', () => {
    it('removes public POST /demo-mode', async () => {
      authenticatedUser = undefined;
      await request(await buildApp())
        .post('/api/settings/demo-mode')
        .send({ enabled: true })
        .expect(404);
      expect(mockSetDemoMode).not.toHaveBeenCalled();
    });

    it('removes POST /demo-mode even for an authenticated caller', async () => {
      authenticatedUser = { id: 'jwt-user-42' };
      await request(await buildApp())
        .post('/api/settings/demo-mode')
        .send({ enabled: true })
        .expect(404);
      expect(mockSetDemoMode).not.toHaveBeenCalled();
    });
  });

  describe('personal writes require a verified identity', () => {
    it.each([
      ['/api/settings/ai/dataset', { datasetId: 'private' }],
      ['/api/settings/mcp', { schema: true }],
      ['/api/settings/mcp/reset', {}],
    ])('rejects anonymous POST %s before service access', async (path, body) => {
      authenticatedUser = undefined;
      await request(await buildApp()).post(path).send(body).expect(401);
      expect(mockSetDataset).not.toHaveBeenCalled();
      expect(mockUpdateUserSettings).not.toHaveBeenCalled();
      expect(mockResetToDefaults).not.toHaveBeenCalled();
    });

    it('uses only the verified user id for dataset writes', async () => {
      authenticatedUser = { id: 'jwt-user-42' };
      mockSetDataset.mockResolvedValue(undefined);
      await request(await buildApp())
        .post('/api/settings/ai/dataset')
        .send({ datasetId: 'private' })
        .expect(200, { success: true, datasetId: 'private' });
      expect(mockSetDataset).toHaveBeenCalledWith('private', 'jwt-user-42');
    });

    it('validates dataset body after authentication', async () => {
      authenticatedUser = { id: 'jwt-user-42' };
      await request(await buildApp())
        .post('/api/settings/ai/dataset')
        .send({})
        .expect(400, {
          success: false,
          error: 'invalid_request',
          message: '`datasetId` must be a non-empty string.',
        });
      expect(mockSetDataset).not.toHaveBeenCalled();
    });

    it('writes MCP settings for the verified user', async () => {
      authenticatedUser = { id: 'jwt-user-42' };
      mockUpdateUserSettings.mockResolvedValue({
        mcp_schema_enabled: true,
        mcp_ai_context_enabled: false,
        mcp_validation_enabled: false,
        mcp_gateway_enabled: false,
        mcp_bc_enabled: false,
      });
      await request(await buildApp())
        .post('/api/settings/mcp')
        .send({ schema: true })
        .expect(200);
      expect(mockUpdateUserSettings).toHaveBeenCalledWith('jwt-user-42', { mcp_schema_enabled: true });
    });

    it('validates MCP body after authentication', async () => {
      authenticatedUser = { id: 'jwt-user-42' };
      await request(await buildApp())
        .post('/api/settings/mcp')
        .send({ invalid: 'value' })
        .expect(400, {
          success: false,
          error: 'invalid_request',
          message:
            'At least one MCP setting (schema, aiContext, validation, gateway, businessCentral) must be provided as a boolean.',
        });
      expect(mockUpdateUserSettings).not.toHaveBeenCalled();
    });
  });
});
