import 'reflect-metadata';
import { Pool } from 'pg';
import { env } from '../../../src/config/env';
import { DatabaseService } from '../../../src/database/DatabaseService';
import type { Logger } from '../../../src/utils/Logger';

jest.mock('pg', () => ({
  Pool: jest.fn(() => { throw new Error('Unexpected database access'); }),
}));

describe('read-only database session options', () => {
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
  let priorEnv: NodeJS.ProcessEnv;
  let priorUrl: string | undefined;

  beforeAll(() => {
    priorEnv = { ...process.env };
    priorUrl = env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...priorEnv };
    env.DATABASE_URL = priorUrl;
    jest.clearAllMocks();
  });

  it.each(['options', 'search_path', 'currentschema', 'timezone', 'statement_timeout', 'lock_timeout', 'application_name', 'STATEMENT_TIMEOUT'])(
    'rejects %s before opening a pool', async (key) => {
      process.env.DB_TYPE = 'postgres';
      process.env.DB_READ_ONLY = '1';
      env.DATABASE_URL = `postgres://fixture:fixture@localhost/generated?${key}=blocked`;
      const service = new DatabaseService(logger);
      await expect(service.initialize()).rejects.toThrow(/session-option overrides are forbidden/);
      expect(Pool).not.toHaveBeenCalled();
    },
  );
});
