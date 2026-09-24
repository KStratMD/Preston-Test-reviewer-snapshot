import * as path from 'path';
import { promises as fs } from 'fs';
import {
  ensureDirectoryExists,
  fileExists,
  readJsonFile,
  writeJsonFile,
  readTextFile,
  writeTextFile,
  safePath,
  createBackup,
  safeWriteFile
} from '../asyncFileOperations';

// Mock fs promises
jest.mock('fs', () => ({
  promises: {
    access: jest.fn(),
    mkdir: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    copyFile: jest.fn(),
    rename: jest.fn(),
    unlink: jest.fn(),
  }
}));

const mockFs = fs as jest.Mocked<typeof fs>;

describe('AsyncFileOperations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('ensureDirectoryExists', () => {
    it('should not create directory if it already exists', async () => {
      mockFs.access.mockResolvedValue(undefined);

      await ensureDirectoryExists('/existing/path');

      expect(mockFs.access).toHaveBeenCalledWith('/existing/path');
      expect(mockFs.mkdir).not.toHaveBeenCalled();
    });

    it('should create directory if it does not exist', async () => {
      mockFs.access.mockRejectedValue(new Error('ENOENT'));
      mockFs.mkdir.mockResolvedValue(undefined);

      await ensureDirectoryExists('/new/path');

      expect(mockFs.access).toHaveBeenCalledWith('/new/path');
      expect(mockFs.mkdir).toHaveBeenCalledWith('/new/path', { recursive: true });
    });
  });

  describe('fileExists', () => {
    it('should return true if file exists', async () => {
      mockFs.access.mockResolvedValue(undefined);

      const result = await fileExists('/test/file.txt');

      expect(result).toBe(true);
      expect(mockFs.access).toHaveBeenCalledWith('/test/file.txt');
    });

    it('should return false if file does not exist', async () => {
      mockFs.access.mockRejectedValue(new Error('ENOENT'));

      const result = await fileExists('/test/missing.txt');

      expect(result).toBe(false);
    });
  });

  describe('readJsonFile', () => {
    it('should read and parse JSON file', async () => {
      const testData = { name: 'test', value: 123 };
      mockFs.readFile.mockResolvedValue(JSON.stringify(testData));

      const result = await readJsonFile('/test/data.json');

      expect(result).toEqual(testData);
      expect(mockFs.readFile).toHaveBeenCalledWith('/test/data.json', 'utf8');
    });

    it('should return null for invalid JSON', async () => {
      mockFs.readFile.mockResolvedValue('invalid json');

      const result = await readJsonFile('/test/invalid.json');

      expect(result).toBeNull();
    });

    it('should return null when file cannot be read', async () => {
      mockFs.readFile.mockRejectedValue(new Error('Permission denied'));

      const result = await readJsonFile('/test/denied.json');

      expect(result).toBeNull();
    });
  });

  describe('writeJsonFile', () => {
    it('should write JSON data to file', async () => {
      const testData = { name: 'test', value: 123 };
      mockFs.writeFile.mockResolvedValue(undefined);

      await writeJsonFile('/test/output.json', testData);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/test/output.json',
        JSON.stringify(testData, null, 2),
        'utf8'
      );
    });
  });

  describe('readTextFile', () => {
    it('should read text file', async () => {
      const testContent = 'Hello, World!';
      mockFs.readFile.mockResolvedValue(testContent);

      const result = await readTextFile('/test/file.txt');

      expect(result).toBe(testContent);
      expect(mockFs.readFile).toHaveBeenCalledWith('/test/file.txt', 'utf8');
    });

    it('should return null when file cannot be read', async () => {
      mockFs.readFile.mockRejectedValue(new Error('File not found'));

      const result = await readTextFile('/test/missing.txt');

      expect(result).toBeNull();
    });
  });

  describe('writeTextFile', () => {
    it('should write text content to file', async () => {
      const content = 'Test content';
      mockFs.writeFile.mockResolvedValue(undefined);

      await writeTextFile('/test/output.txt', content);

      expect(mockFs.writeFile).toHaveBeenCalledWith('/test/output.txt', content, 'utf8');
    });
  });

  describe('safePath', () => {
    const basePath = '/safe/base';

    it('should resolve safe paths within base directory', () => {
      const result = safePath(basePath, 'file.txt');
      expect(result).toBe(path.resolve(basePath, 'file.txt'));
    });

    it('should resolve safe nested paths', () => {
      const result = safePath(basePath, 'subdir/file.txt');
      expect(result).toBe(path.resolve(basePath, 'subdir/file.txt'));
    });

    it('should prevent path traversal attacks', () => {
      expect(() => safePath(basePath, '../outside.txt')).toThrow('Path traversal detected');
      expect(() => safePath(basePath, '../../etc/passwd')).toThrow('Path traversal detected');
      expect(() => safePath(basePath, '/absolute/path')).toThrow('Path traversal detected');
    });

    it('should handle complex path traversal attempts', () => {
      expect(() => safePath(basePath, 'subdir/../../../outside.txt')).toThrow('Path traversal detected');
      expect(() => safePath(basePath, 'valid/path/../../../../../../etc/passwd')).toThrow('Path traversal detected');
    });
  });

  describe('createBackup', () => {
    it('should create a backup of existing file', async () => {
      mockFs.copyFile.mockResolvedValue(undefined);
      
      const backupPath = await createBackup('/test/original.txt');

      expect(mockFs.copyFile).toHaveBeenCalledWith('/test/original.txt', backupPath);
      expect(backupPath).toMatch(/\/test\/original\.txt\.backup\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    });
  });

  describe('safeWriteFile', () => {
    it('should write file atomically using temporary file', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      await safeWriteFile('/test/target.txt', 'test content');

      expect(mockFs.writeFile).toHaveBeenCalledWith('/test/target.txt.tmp', 'test content', 'utf8');
      expect(mockFs.rename).toHaveBeenCalledWith('/test/target.txt.tmp', '/test/target.txt');
    });

    it('should clean up temporary file on write error', async () => {
      mockFs.writeFile.mockRejectedValue(new Error('Write failed'));
      mockFs.unlink.mockResolvedValue(undefined);

      await expect(safeWriteFile('/test/target.txt', 'test content')).rejects.toThrow('Write failed');

      expect(mockFs.unlink).toHaveBeenCalledWith('/test/target.txt.tmp');
    });

    it('should clean up temporary file on rename error', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockRejectedValue(new Error('Rename failed'));
      mockFs.unlink.mockResolvedValue(undefined);

      await expect(safeWriteFile('/test/target.txt', 'test content')).rejects.toThrow('Rename failed');

      expect(mockFs.unlink).toHaveBeenCalledWith('/test/target.txt.tmp');
    });
  });

  describe('error handling', () => {
    it('should handle file system errors gracefully', async () => {
      mockFs.readFile.mockRejectedValue(new Error('Permission denied'));

      const result = await readJsonFile('/restricted/file.json');

      expect(result).toBeNull();
    });

    it('should preserve error information when appropriate', async () => {
      const writeError = new Error('Disk full');
      mockFs.writeFile.mockRejectedValue(writeError);

      await expect(writeTextFile('/test/file.txt', 'content')).rejects.toThrow('Disk full');
    });
  });

  describe('integration scenarios', () => {
    it('should handle directory creation and file writing together', async () => {
      mockFs.access.mockRejectedValue(new Error('ENOENT')); // Directory doesn't exist
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await ensureDirectoryExists('/new/dir');
      await writeTextFile('/new/dir/file.txt', 'content');

      expect(mockFs.mkdir).toHaveBeenCalledWith('/new/dir', { recursive: true });
      expect(mockFs.writeFile).toHaveBeenCalledWith('/new/dir/file.txt', 'content', 'utf8');
    });

    it('should handle backup and safe write workflow', async () => {
      mockFs.copyFile.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const backupPath = await createBackup('/test/config.json');
      await safeWriteFile('/test/config.json', '{"updated": true}');

      expect(mockFs.copyFile).toHaveBeenCalled();
      expect(mockFs.writeFile).toHaveBeenCalledWith('/test/config.json.tmp', '{"updated": true}', 'utf8');
      expect(mockFs.rename).toHaveBeenCalledWith('/test/config.json.tmp', '/test/config.json');
    });
  });
});