/**
 * Compression Middleware Unit Tests
 * Tests for response compression middleware
 */

import { Request, Response } from 'express';

// Mock compression module
const mockCompressionMiddleware = jest.fn();
const mockFilter = jest.fn();

jest.mock('compression', () => {
  const compressionFn = jest.fn().mockReturnValue(mockCompressionMiddleware);
  compressionFn.filter = mockFilter;
  return compressionFn;
});

import {
  createCompressionMiddleware,
  createApiCompressionMiddleware,
  createStaticCompressionMiddleware,
  CompressionConfig,
} from '../../../src/middleware/compression';
import compression from 'compression';

describe('Compression Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFilter.mockReturnValue(true);
    mockReq = {
      headers: {
        'accept-encoding': 'gzip, deflate, br',
      },
    };
    mockRes = {
      getHeader: jest.fn(),
    };
  });

  describe('createCompressionMiddleware', () => {
    it('should create middleware with default config', () => {
      const middleware = createCompressionMiddleware();

      expect(compression).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 6,
          threshold: 1024,
          memLevel: 8,
          strategy: 0,
        })
      );
      expect(middleware).toBe(mockCompressionMiddleware);
    });

    it('should use custom compression level', () => {
      createCompressionMiddleware({ level: 9 });

      expect(compression).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 9,
        })
      );
    });

    it('should use custom threshold', () => {
      createCompressionMiddleware({ threshold: 2048 });

      expect(compression).toHaveBeenCalledWith(
        expect.objectContaining({
          threshold: 2048,
        })
      );
    });

    it('should use custom memLevel and strategy', () => {
      createCompressionMiddleware({ memLevel: 4, strategy: 1 });

      expect(compression).toHaveBeenCalledWith(
        expect.objectContaining({
          memLevel: 4,
          strategy: 1,
        })
      );
    });

    it('should use custom filter function', () => {
      const customFilter = jest.fn().mockReturnValue(true);
      createCompressionMiddleware({ filter: customFilter });

      expect(compression).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: customFilter,
        })
      );
    });

    describe('default filter behavior', () => {
      let filterFn: (req: Request, res: Response) => boolean;

      beforeEach(() => {
        createCompressionMiddleware();
        const lastCall = (compression as jest.Mock).mock.calls[
          (compression as jest.Mock).mock.calls.length - 1
        ];
        filterFn = lastCall[0].filter;
      });

      it('should not compress if accept-encoding header is missing', () => {
        mockReq.headers = {};
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(false);
      });

      it('should not compress server-sent events', () => {
        (mockRes.getHeader as jest.Mock).mockImplementation((header: string) => {
          if (header === 'Content-Type') return 'text/event-stream';
          return undefined;
        });
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(false);
      });

      it('should not compress if already compressed', () => {
        (mockRes.getHeader as jest.Mock).mockImplementation((header: string) => {
          if (header === 'Content-Encoding') return 'gzip';
          return undefined;
        });
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(false);
      });

      it('should use default filter for other cases', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue(undefined);
        filterFn(mockReq as Request, mockRes as Response);
        expect(mockFilter).toHaveBeenCalledWith(mockReq, mockRes);
      });
    });
  });

  describe('createApiCompressionMiddleware', () => {
    it('should create middleware with API-optimized config', () => {
      createApiCompressionMiddleware();

      expect(compression).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 7,
          threshold: 512,
        })
      );
    });

    describe('API filter behavior', () => {
      let filterFn: (req: Request, res: Response) => boolean;

      beforeEach(() => {
        createApiCompressionMiddleware();
        const lastCall = (compression as jest.Mock).mock.calls[
          (compression as jest.Mock).mock.calls.length - 1
        ];
        filterFn = lastCall[0].filter;
      });

      it('should compress JSON responses', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('application/json');
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(true);
      });

      it('should compress CSV responses', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('text/csv');
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(true);
      });

      it('should compress XML responses', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('application/xml');
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(true);
      });

      it('should compress text/xml responses', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('text/xml');
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(true);
      });

      it('should not compress image responses', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('image/png');
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(false);
      });

      it('should not compress video responses', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('video/mp4');
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(false);
      });

      it('should use default filter for other types', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('text/plain');
        filterFn(mockReq as Request, mockRes as Response);
        expect(mockFilter).toHaveBeenCalledWith(mockReq, mockRes);
      });
    });
  });

  describe('createStaticCompressionMiddleware', () => {
    it('should create middleware with static-optimized config', () => {
      createStaticCompressionMiddleware();

      expect(compression).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 9,
          threshold: 2048,
        })
      );
    });

    describe('static filter behavior', () => {
      let filterFn: (req: Request, res: Response) => boolean;

      beforeEach(() => {
        createStaticCompressionMiddleware();
        const lastCall = (compression as jest.Mock).mock.calls[
          (compression as jest.Mock).mock.calls.length - 1
        ];
        filterFn = lastCall[0].filter;
      });

      it('should compress CSS files', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('text/css');
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(true);
      });

      it('should compress JavaScript files', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('application/javascript');
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(true);
      });

      it('should compress HTML files', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('text/html');
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(true);
      });

      it('should compress SVG images', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('image/svg+xml');
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(true);
      });

      it('should not compress PNG images', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('image/png');
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(false);
      });

      it('should not compress JPEG images', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('image/jpeg');
        const result = filterFn(mockReq as Request, mockRes as Response);
        expect(result).toBe(false);
      });

      it('should use default filter for other types', () => {
        (mockRes.getHeader as jest.Mock).mockReturnValue('application/octet-stream');
        filterFn(mockReq as Request, mockRes as Response);
        expect(mockFilter).toHaveBeenCalledWith(mockReq, mockRes);
      });
    });
  });
});
