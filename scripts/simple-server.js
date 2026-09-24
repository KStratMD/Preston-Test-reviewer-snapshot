const express = require('express');
const path = require('path');
const fs = require('fs');
const promClient = require('prom-client');

const app = express();
const port = process.env.PORT || 3000;
const publicRoot = path.join(__dirname, 'public');

// Basic middleware
app.use(express.json());

function resolveWikiExportFallback(requestPath) {
  const normalizedRequestPath = path.posix.normalize(requestPath);
  const isWikiPath = normalizedRequestPath === '/wiki' || normalizedRequestPath.startsWith('/wiki/');
  if (!isWikiPath || path.posix.extname(normalizedRequestPath)) return null;

  const relativePath = normalizedRequestPath.replace(/^\/+/, '');
  const htmlCandidate = path.join(publicRoot, `${relativePath}.html`);
  if (fs.existsSync(htmlCandidate) && fs.statSync(htmlCandidate).isFile()) return htmlCandidate;

  const indexCandidate = path.join(publicRoot, relativePath, 'index.html');
  if (fs.existsSync(indexCandidate) && fs.statSync(indexCandidate).isFile()) return indexCandidate;

  return null;
}

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const fallbackPath = resolveWikiExportFallback(req.path);
  if (!fallbackPath) return next();

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(fallbackPath);
});

app.use(express.static(publicRoot));

// Documentation: served only by the full server (`npm run dev`, src/routes/docs.ts), which
// sanitises rendered Markdown and confines reads to the repo. This demo server used to carry
// an unsanitised copy with no path containment; it was removed on 2026-09-22
// (docs/superpowers/plans/2026-09-22-docs-markdown-sanitisation.md).
app.all(['/docs', '/docs/*'], (req, res) => {
  res.status(404).type('text/plain').send('Documentation is served by the full server: run `npm run dev` and open /docs.');
});

// Helper to register basic in-memory CRUD endpoints with change tracking
function registerResourceRoutes(resource) {
  const base = `/${resource}`;
  const store = new Map();
  let idCounter = 1;
  let changes = [];

  app.get(base, (req, res) => {
    res.json(Array.from(store.values()));
  });

  app.post(base, (req, res) => {
    const item = { id: idCounter++, ...req.body };
    store.set(String(item.id), item);
    changes.push({ id: item.id, type: 'create', data: item });
    res.status(201).json(item);
  });

  app.get(`${base}/:id`, (req, res) => {
    const item = store.get(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(item);
  });

  app.put(`${base}/:id`, (req, res) => {
    if (!store.has(req.params.id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const item = { ...store.get(req.params.id), ...req.body, id: Number(req.params.id) };
    store.set(req.params.id, item);
    changes.push({ id: item.id, type: 'update', data: item });
    res.json(item);
  });

  app.delete(`${base}/:id`, (req, res) => {
    if (!store.has(req.params.id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    store.delete(req.params.id);
    changes.push({ id: Number(req.params.id), type: 'delete' });
    res.status(204).end();
  });

  app.get(`${base}/changes`, (req, res) => {
    const result = changes;
    changes = [];
    res.json(result);
  });
}

['vendors', 'purchase-orders', 'payments'].forEach(registerResourceRoutes);

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0'
  });
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await promClient.register.metrics();
    res.set('Content-Type', promClient.register.contentType);
    res.end(metrics);
  } catch (error) {
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

// HTML Dashboard routes
app.get('/metrics.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'metrics.html'));
});

app.get('/system-status.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'system-status.html'));
});

// Basic API endpoints
app.get('/api/configurations', (req, res) => {
  res.json([]);
});

// Dashboard route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Simple server running on port ${port}`);
  console.log(`📊 Dashboard: http://localhost:${port}`);
  console.log(`🏥 Health: http://localhost:${port}/health`);
  console.log(`📈 Metrics: http://localhost:${port}/metrics`);
});
