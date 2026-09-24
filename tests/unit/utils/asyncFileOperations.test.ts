/**
 * Async File Operations Unit Tests
 * Tests for async file operation utilities
 */

// Mock fs/promises
jest.mock('fs', () => ({
  promises: {
    access: jest.fn(),
    mkdir: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    copyFile: jest.fn(),
    unlink: jest.fn(),
    readdir: jest.fn(),
    stat: jest.fn(),
    rename: jest.fn(),
  },
}));

jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { promises as fs } from 'fs';
import {
  ensureDirectoryExists,
  fileExists,
  readJsonFile,
  writeJsonFile,
  readTextFile,
  writeTextFile,
  copyFile,
  deleteFile,
  listFiles,
  getFileStats,
  safePath,
  createBackup,
  readFileWithRetry,
  safeWriteFile,
} from '../../../src/utils/asyncFileOperations';

const mockFs = fs as jest.Mocked<typeof fs>;

describe('asyncFileOperations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('ensureDirectoryExists', () => {
    it('should not create directory if it exists', async () => {
      mockFs.access.mockResolvedValue(undefined);

      await ensureDirectoryExists('/test/dir');

      expect(mockFs.access).toHaveBeenCalled();
      expect(mockFs.mkdir).not.toHaveBeenCalled();
    });

    it('should create directory if it does not exist', async () => {
      mockFs.access.mockRejectedValue(new Error('ENOENT'));
      mockFs.mkdir.mockResolvedValue(undefined);

      await ensureDirectoryExists('/test/dir');

      expect(mockFs.mkdir).toHaveBeenCalledWith('/test/dir', { recursive: true });
    });
  });

  describe('fileExists', () => {
    it('should return true if file exists', async () => {
      mockFs.access.mockResolvedValue(undefined);

      const result = await fileExists('/test/file.txt');

      expect(result).toBe(true);
    });

    it('should return false if file does not exist', async () => {
      mockFs.access.mockRejectedValue(new Error('ENOENT'));

      const result = await fileExists('/test/nonexistent.txt');

      expect(result).toBe(false);
    });
  });

  describe('readJsonFile', () => {
    it('should read and parse JSON file', async () => {
      mockFs.readFile.mockResolvedValue('{"key": "value"}');

      const result = await readJsonFile('/test/file.json');

      expect(result).toEqual({ key: 'value' });
    });

    it('should return null on error', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'));

      const result = await readJsonFile('/test/nonexistent.json');

      expect(result).toBeNull();
    });

    it('should return null on invalid JSON', async () => {
      mockFs.readFile.mockResolvedValue('invalid json');

      const result = await readJsonFile('/test/invalid.json');

      expect(result).toBeNull();
    });
  });

  describe('writeJsonFile', () => {
    it('should write JSON file with formatting', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);

      await writeJsonFile('/test/file.json', { key: 'value' });

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/test/file.json',
        JSON.stringify({ key: 'value' }, null, 2),
        'utf8'
      );
    });
  });

  describe('readTextFile', () => {
    it('should read text file', async () => {
      mockFs.readFile.mockResolvedValue('file content');

      const result = await readTextFile('/test/file.txt');

      expect(result).toBe('file content');
    });

    it('should return null on error', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'));

      const result = await readTextFile('/test/nonexistent.txt');

      expect(result).toBeNull();
    });
  });

  describe('writeTextFile', () => {
    it('should write text file', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);

      await writeTextFile('/test/file.txt', 'content');

      expect(mockFs.writeFile).toHaveBeenCalledWith('/test/file.txt', 'content', 'utf8');
    });
  });

  describe('copyFile', () => {
    it('should copy file', async () => {
      mockFs.copyFile.mockResolvedValue(undefined);

      await copyFile('/source.txt', '/dest.txt');

      expect(mockFs.copyFile).toHaveBeenCalledWith('/source.txt', '/dest.txt');
    });
  });

  describe('deleteFile', () => {
    it('should delete file and return true', async () => {
      mockFs.unlink.mockResolvedValue(undefined);

      const result = await deleteFile('/test/file.txt');

      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      mockFs.unlink.mockRejectedValue(new Error('ENOENT'));

      const result = await deleteFile('/test/nonexistent.txt');

      expect(result).toBe(false);
    });
  });

  describe('listFiles', () => {
    it('should list all files', async () => {
      mockFs.readdir.mockResolvedValue(['file1.txt', 'file2.txt', 'file3.json'] as any);

      const result = await listFiles('/test/dir');

      expect(result).toEqual(['file1.txt', 'file2.txt', 'file3.json']);
    });

    it('should filter by extension', async () => {
      mockFs.readdir.mockResolvedValue(['file1.txt', 'file2.txt', 'file3.json'] as any);

      const result = await listFiles('/test/dir', '.txt');

      expect(result).toEqual(['file1.txt', 'file2.txt']);
    });

    it('should return empty array on error', async () => {
      mockFs.readdir.mockRejectedValue(new Error('ENOENT'));

      const result = await listFiles('/test/nonexistent');

      expect(result).toEqual([]);
    });
  });

  describe('getFileStats', () => {
    it('should return file stats', async () => {
      const mockStats = { size: 100, isFile: () => true };
      mockFs.stat.mockResolvedValue(mockStats as any);

      const result = await getFileStats('/test/file.txt');

      expect(result).toEqual(mockStats);
    });

    it('should return null on error', async () => {
      mockFs.stat.mockRejectedValue(new Error('ENOENT'));

      const result = await getFileStats('/test/nonexistent.txt');

      expect(result).toBeNull();
    });
  });

  describe('safePath', () => {
    it('should resolve safe path', () => {
      const result = safePath('/base', 'subdir/file.txt');

      expect(result).toContain('file.txt');
    });

    it('should reject absolute paths', () => {
      expect(() => safePath('/base', '/etc/passwd')).toThrow('Path traversal detected');
    });

    it('should reject path traversal attempts', () => {
      expect(() => safePath('/base', '../etc/passwd')).toThrow('Path traversal detected');
    });

    it('should reject paths with leading slashes as absolute', () => {
      // Paths starting with / are treated as absolute and rejected
      expect(() => safePath('/base', '///subdir/file.txt')).toThrow('Path traversal detected');
    });
  });

  describe('createBackup', () => {
    it('should create backup with timestamp', async () => {
      mockFs.copyFile.mockResolvedValue(undefined);

      const result = await createBackup('/test/file.txt');

      expect(result).toContain('.backup.');
      expect(mockFs.copyFile).toHaveBeenCalled();
    });
  });

  describe('readFileWithRetry', () => {
    it('should read file on first try', async () => {
      mockFs.readFile.mockResolvedValue('content');

      const result = await readFileWithRetry('/test/file.txt');

      expect(result).toBe('content');
      expect(mockFs.readFile).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure', async () => {
      mockFs.readFile
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockResolvedValueOnce('content');

      const result = await readFileWithRetry('/test/file.txt', 3, 10);

      expect(result).toBe('content');
      expect(mockFs.readFile).toHaveBeenCalledTimes(2);
    });

    it('should throw after max retries', async () => {
      mockFs.readFile.mockRejectedValue(new Error('Persistent error'));

      await expect(readFileWithRetry('/test/file.txt', 3, 10))
        .rejects.toThrow('Persistent error');

      expect(mockFs.readFile).toHaveBeenCalledTimes(3);
    });
  });

  describe('safeWriteFile', () => {
    it('should write file atomically', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      await safeWriteFile('/test/file.txt', 'content');

      expect(mockFs.writeFile).toHaveBeenCalledWith('/test/file.txt.tmp', 'content', 'utf8');
      expect(mockFs.rename).toHaveBeenCalledWith('/test/file.txt.tmp', '/test/file.txt');
    });

    it('should clean up temp file on error', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockRejectedValue(new Error('Rename failed'));
      mockFs.unlink.mockResolvedValue(undefined);

      await expect(safeWriteFile('/test/file.txt', 'content'))
        .rejects.toThrow('Rename failed');

      expect(mockFs.unlink).toHaveBeenCalledWith('/test/file.txt.tmp');
    });

    it('should ignore cleanup errors', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockRejectedValue(new Error('Rename failed'));
      mockFs.unlink.mockRejectedValue(new Error('Cleanup failed'));

      await expect(safeWriteFile('/test/file.txt', 'content'))
        .rejects.toThrow('Rename failed');
    });
  });
});
