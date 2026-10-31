import { readFileContent, ensureDirectoryExists, createBackup } from '../../utils/fileUtils';
import fs from 'fs/promises';

// Mock fs module
jest.mock('fs/promises');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('FileUtils', () => {
  let mockLogger: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = {
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
  });

  describe('readFileContent', () => {
    it('should read file content successfully', async () => {
      const testContent = 'test file content';
      mockFs.access.mockResolvedValue();
      mockFs.stat.mockResolvedValue({ size: testContent.length } as any);
      mockFs.readFile.mockResolvedValue(testContent);

      const result = await readFileContent('/test/path.txt', mockLogger, 1000);

      expect(result).toBe(testContent);
      expect(mockFs.access).toHaveBeenCalledWith('/test/path.txt', fs.constants.R_OK);
      expect(mockFs.readFile).toHaveBeenCalledWith('/test/path.txt', 'utf-8');
    });

    it('should return null for empty files', async () => {
      mockFs.access.mockResolvedValue();
      mockFs.stat.mockResolvedValue({ size: 0 } as any);

      const result = await readFileContent('/test/empty.txt', mockLogger, 1000);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith('File /test/empty.txt is empty, skipping');
    });

    it('should return null for files that are too large', async () => {
      mockFs.access.mockResolvedValue();
      mockFs.stat.mockResolvedValue({ size: 2000 } as any);

      const result = await readFileContent('/test/large.txt', mockLogger, 1000);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith('File /test/large.txt is too large (2000 bytes), skipping');
    });

    it('should handle file read errors', async () => {
      const error = new Error('File not found') as any;
      error.code = 'ENOENT';
      mockFs.access.mockRejectedValue(error);

      const result = await readFileContent('/test/missing.txt', mockLogger, 1000);

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('File not found: /test/missing.txt');
    });
  });

  describe('ensureDirectoryExists', () => {
    it('should create directory if it does not exist', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);

      await ensureDirectoryExists('/test/new/directory', mockLogger);

      expect(mockFs.mkdir).toHaveBeenCalledWith('/test/new/directory', { recursive: true });
    });

    it('should handle mkdir errors', async () => {
      const error = new Error('Permission denied');
      mockFs.mkdir.mockRejectedValue(error);

      await expect(ensureDirectoryExists('/test/protected', mockLogger)).rejects.toThrow('Permission denied');
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to create directory /test/protected:', error);
    });
  });

  describe('createBackup', () => {
    it('should create backup file successfully', async () => {
      mockFs.access.mockResolvedValue();
      mockFs.copyFile.mockResolvedValue();

      await createBackup('/test/file.txt', mockLogger);

      expect(mockFs.access).toHaveBeenCalledWith('/test/file.txt');
      expect(mockFs.copyFile).toHaveBeenCalledWith('/test/file.txt', '/test/file.txt.backup');
      expect(mockLogger.debug).toHaveBeenCalledWith('Created backup: /test/file.txt.backup');
    });

    it('should handle missing source file gracefully', async () => {
      const error = new Error('File not found') as any;
      error.code = 'ENOENT';
      mockFs.access.mockRejectedValue(error);

      await createBackup('/test/missing.txt', mockLogger);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should handle other backup errors', async () => {
      const error = new Error('Permission denied') as any;
      error.code = 'EACCES';
      mockFs.access.mockRejectedValue(error);

      await createBackup('/test/protected.txt', mockLogger);

      expect(mockLogger.warn).toHaveBeenCalledWith('Failed to create backup for /test/protected.txt:', error);
    });
  });
});
