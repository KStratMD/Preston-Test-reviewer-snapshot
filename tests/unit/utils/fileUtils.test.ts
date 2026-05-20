/**
 * File Utils Unit Tests
 * Tests for file utility functions
 */

import fs from 'fs/promises';
import { readFileContent, ensureDirectoryExists, createBackup } from '../../../src/utils/fileUtils';

// Mock fs/promises
jest.mock('fs/promises');

const mockFs = fs as jest.Mocked<typeof fs>;

describe('fileUtils', () => {
  let mockLogger: {
    debug: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    
    // Setup default constants mock
    (mockFs as any).constants = { R_OK: 4 };
  });

  describe('readFileContent', () => {
    it('should read file content successfully', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ size: 100 } as any);
      mockFs.readFile.mockResolvedValue('file content');

      const result = await readFileContent('/test/file.txt', mockLogger, 1000);

      expect(result).toBe('file content');
      expect(mockFs.access).toHaveBeenCalled();
      expect(mockFs.stat).toHaveBeenCalled();
      expect(mockFs.readFile).toHaveBeenCalledWith('/test/file.txt', 'utf-8');
    });

    it('should return null for empty file', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ size: 0 } as any);

      const result = await readFileContent('/test/empty.txt', mockLogger, 1000);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('empty'));
    });

    it('should return null for file too large', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ size: 2000 } as any);

      const result = await readFileContent('/test/large.txt', mockLogger, 1000);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('too large'));
    });

    it('should return null for whitespace-only file', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ size: 10 } as any);
      mockFs.readFile.mockResolvedValue('   \n\t  ');

      const result = await readFileContent('/test/whitespace.txt', mockLogger, 1000);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('whitespace'));
    });

    it('should handle file not found error', async () => {
      const error = new Error('ENOENT');
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      mockFs.access.mockRejectedValue(error);

      const result = await readFileContent('/test/notfound.txt', mockLogger, 1000);

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('should handle permission denied error', async () => {
      const error = new Error('EACCES');
      (error as NodeJS.ErrnoException).code = 'EACCES';
      mockFs.access.mockRejectedValue(error);

      const result = await readFileContent('/test/denied.txt', mockLogger, 1000);

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
    });

    it('should handle too many open files error', async () => {
      const error = new Error('EMFILE');
      (error as NodeJS.ErrnoException).code = 'EMFILE';
      mockFs.access.mockRejectedValue(error);

      const result = await readFileContent('/test/file.txt', mockLogger, 1000);

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Too many open files'));
    });

    it('should handle generic errors', async () => {
      const error = new Error('Unknown error');
      mockFs.access.mockRejectedValue(error);

      const result = await readFileContent('/test/file.txt', mockLogger, 1000);

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle non-Error thrown values', async () => {
      mockFs.access.mockRejectedValue('string error');

      const result = await readFileContent('/test/file.txt', mockLogger, 1000);

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('ensureDirectoryExists', () => {
    it('should create directory successfully', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);

      await expect(ensureDirectoryExists('/test/dir', mockLogger)).resolves.not.toThrow();

      expect(mockFs.mkdir).toHaveBeenCalledWith('/test/dir', { recursive: true });
    });

    it('should throw and log on error', async () => {
      const error = new Error('Failed to create');
      mockFs.mkdir.mockRejectedValue(error);

      await expect(ensureDirectoryExists('/test/dir', mockLogger)).rejects.toThrow('Failed to create');

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle non-Error thrown values', async () => {
      mockFs.mkdir.mockRejectedValue('string error');

      await expect(ensureDirectoryExists('/test/dir', mockLogger)).rejects.toBe('string error');

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('createBackup', () => {
    it('should create backup successfully', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.copyFile.mockResolvedValue(undefined);

      await createBackup('/test/file.txt', mockLogger);

      expect(mockFs.copyFile).toHaveBeenCalledWith('/test/file.txt', '/test/file.txt.backup');
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Created backup'));
    });

    it('should skip backup if file does not exist', async () => {
      const error = new Error('ENOENT');
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      mockFs.access.mockRejectedValue(error);

      await createBackup('/test/notfound.txt', mockLogger);

      expect(mockFs.copyFile).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should warn on other errors', async () => {
      const error = new Error('EACCES');
      (error as NodeJS.ErrnoException).code = 'EACCES';
      mockFs.access.mockRejectedValue(error);

      await createBackup('/test/denied.txt', mockLogger);

      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});
