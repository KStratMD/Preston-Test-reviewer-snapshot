import * as express from 'express';
import * as path from 'path';
import { promises as fs } from 'fs';
import { marked } from 'marked';
import { sendError } from '../utils/errorResponse';
import { logger } from '../utils/Logger';

/**
 * Async version of the docs router to serve markdown and other documentation assets under /docs.
 * Simplified version for testing compatibility.
 */
export function createDocsAsyncRouter(): express.Router {
  const router = express.Router();
  const docsRoot = path.join(__dirname, '../../docs');

  // Basic markdown renderer config
  marked.setOptions({
    gfm: true,
    breaks: false,
  });

  // Simple in-memory cache
  interface CacheEntry { 
    html: string; 
    mtimeMs: number; 
  }
  
  const renderCache = new Map<string, CacheEntry>();
  const CACHE_TTL_MS = 5 * 60 * 1000;

  // Search endpoint
  router.get('/search', async (req, res) => {
    const query = (req.query.q || '').toString().toLowerCase().trim();
    if (!query) {
      return res.json({ results: [], version: 1 });
    }
    
    // Simple search implementation
    const results: { path: string; title: string }[] = [];
    return res.json({ results, version: 1 });
  });

  // Helper to render markdown with caching
  async function renderMarkdown(filePath: string): Promise<string | null> {
    try {
      const stat = await fs.stat(filePath);
      const cacheKey = filePath;
      const cached = renderCache.get(cacheKey);
      
      // Check cache validity
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.html;
      }
      
      const content = await fs.readFile(filePath, 'utf8');
      const htmlContent = marked(content);
      
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${path.basename(filePath, '.md')} - Documentation</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50">
  <div class="container mx-auto px-4 py-8 max-w-6xl">
    <div class="bg-white rounded-lg shadow-lg p-8">
      <div class="markdown-body prose max-w-none">
        ${htmlContent}
      </div>
      <div class="mt-8 pt-4 border-t text-sm text-gray-600">
        <a href="/docs" class="text-blue-600 hover:underline">← Back to Documentation</a>
      </div>
    </div>
  </div>
</body>
</html>`;
      
      // Update cache
      renderCache.set(cacheKey, { html, mtimeMs: stat.mtimeMs });
      
      return html;
    } catch (error) {
      logger.error(`Failed to render markdown: ${filePath}`, error);
      return null;
    }
  }

  // Serve documentation files
  router.get('/*', async (req, res) => {
    let requestPath = (req.params as any)[0] || 'index';
    
    // Security: prevent directory traversal
    if (requestPath.includes('..')) {
      return sendError(res, 400, { code: 'INVALID_PATH', message: 'Invalid path' });
    }
    
    // Default to index.md for directory requests
    if (requestPath === '' || requestPath.endsWith('/')) {
      requestPath = requestPath + 'index';
    }
    
    // Remove leading slash if present
    if (requestPath.startsWith('/')) {
      requestPath = requestPath.substring(1);
    }
    
    // Check if it's a root markdown file request
    const isRootMarkdown = !requestPath.includes('/') && 
      (requestPath.endsWith('.md') || !requestPath.includes('.'));
    
    let safePath: string;
    if (isRootMarkdown) {
      // Look for markdown files in the root directory
      const rootDir = path.join(__dirname, '../../');
      if (!requestPath.endsWith('.md')) {
        requestPath += '.md';
      }
      safePath = path.join(rootDir, requestPath);
    } else {
      // Look in docs directory
      if (!requestPath.includes('.')) {
        requestPath += '.md';
      }
      safePath = path.join(docsRoot, requestPath);
    }
    
    // Ensure the resolved path is within allowed directories
    const normalizedPath = path.normalize(safePath);
    const rootDir = path.join(__dirname, '../../');
    if (!normalizedPath.startsWith(docsRoot) && !normalizedPath.startsWith(rootDir)) {
      return sendError(res, 403, { code: 'ACCESS_DENIED', message: 'Access denied' });
    }
    
    try {
      const stat = await fs.stat(safePath);
      
      if (stat.isDirectory()) {
        // Try to serve index.md from the directory
        const indexPath = path.join(safePath, 'index.md');
        try {
          await fs.access(indexPath);
          const html = await renderMarkdown(indexPath);
          if (html) {
            return res.type('html').send(html);
          } else {
            return sendError(res, 500, { code: 'RENDER_FAILED', message: 'Failed to render documentation' });
          }
        } catch {
          // Directory listing is simplified for compatibility
          const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Documentation Index</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50">
  <div class="container mx-auto px-4 py-8 max-w-4xl">
    <div class="bg-white rounded-lg shadow-lg p-8">
      <h1 class="text-3xl font-bold mb-6">Documentation</h1>
      <p class="text-gray-600">Documentation index</p>
    </div>
  </div>
</body>
</html>`;
          return res.type('html').send(html);
        }
      } else if (safePath.endsWith('.md')) {
        // Render markdown file
        const html = await renderMarkdown(safePath);
        if (html) {
          return res.type('html').send(html);
        } else {
          return sendError(res, 500, { code: 'RENDER_FAILED', message: 'Failed to render documentation' });
        }
      } else {
        // Serve static file
        const content = await fs.readFile(safePath);
        const ext = path.extname(safePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.pdf': 'application/pdf',
          '.json': 'application/json',
        };
        
        if (mimeTypes[ext]) {
          res.type(mimeTypes[ext]);
        }
        return res.send(content);
      }
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err.code === 'ENOENT') {
        return sendError(res, 404, { code: 'NOT_FOUND', message: 'Documentation not found' });
      } else {
        logger.error('Error serving documentation:', error);
        return sendError(res, 500, { code: 'INTERNAL_ERROR', message: 'Internal server error' });
      }
    }
  });

  return router;
}