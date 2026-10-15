import type { Request, Response, NextFunction } from 'express';
import { gzipSync, deflateSync, brotliCompressSync } from 'zlib';

/**
 * Minimal compression middleware supporting gzip, deflate and brotli.
 * It inspects the `Accept-Encoding` header and compresses the response
 * using the best algorithm supported by the client.
 */
export function compressionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const accept = req.headers['accept-encoding'];
  if (typeof accept !== 'string') {
    return next();
  }

  const enc = accept.toLowerCase();
  let algorithm: 'br' | 'gzip' | 'deflate' | null = null;

  if (enc.includes('br')) {
    algorithm = 'br';
  } else if (enc.includes('gzip')) {
    algorithm = 'gzip';
  } else if (enc.includes('deflate')) {
    algorithm = 'deflate';
  }

  if (!algorithm) {
    return next();
  }

  const chunks: Buffer[] = [];
  const originalEnd = res.end;

  res.setHeader('Vary', 'Accept-Encoding');

  // Capture response body
  res.write = function (this: Response, chunk: unknown, encoding?: unknown): boolean {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any, encoding as any));
    return true;
  } as any;

  res.end = function (this: Response, chunk?: unknown, encoding?: unknown): Response {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any, encoding as any));
    }
    const buffer = Buffer.concat(chunks);
    let compressed: Buffer;

    try {
      switch (algorithm) {
      case 'br':
        compressed = brotliCompressSync(buffer);
        break;
      case 'gzip':
        compressed = gzipSync(buffer);
        break;
      case 'deflate':
        compressed = deflateSync(buffer);
        break;
      default:
        return originalEnd.call(this, buffer, encoding);
      }
    } catch {
      return originalEnd.call(this, buffer, encoding);
    }

    res.setHeader('Content-Encoding', algorithm);
    res.setHeader('Content-Length', compressed.length.toString());
    return originalEnd.call(this, compressed, encoding);
  } as any;

  next();
}
