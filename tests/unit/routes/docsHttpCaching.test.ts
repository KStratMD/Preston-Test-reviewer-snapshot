/**
 * HTTP cache validators for rendered /docs pages (markdown and Postman).
 *
 * The ETag used to be built from the source file's size and mtime only, and
 * the markdown renderer OR-ed If-Modified-Since into it. A change to the page
 * template in renderPage() therefore revalidated as 304, and browsers kept the
 * old HTML; removing back-to-dashboard.js from the template left warm-cache
 * clients still loading it. The validator must track the bytes actually served.
 *
 * Each renderer has two response paths (fresh render, and the in-memory render
 * cache on a repeat request), so every case runs against both.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createDocsRouter } from '../../../src/routes/docs';

const repoRoot = path.resolve(__dirname, '../../..');

// A fixture collection in a temp dir: the repo's own postman/ collections are
// excluded from the public reviewer mirror, so the test must not read them.
const postmanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-postman-'));
const COLLECTION = 'Fixture.postman_collection.json';
fs.writeFileSync(
  path.join(postmanRoot, COLLECTION),
  JSON.stringify({
    info: { name: 'Fixture collection' },
    item: [{ name: 'Health', request: { method: 'GET', url: '{{baseUrl}}/health' } }],
  }),
);
afterAll(() => fs.rmSync(postmanRoot, { recursive: true, force: true }));

const PAGES = [
  { name: 'markdown', url: '/docs/README.md', source: path.join(repoRoot, 'docs/README.md') },
  { name: 'postman', url: `/docs/postman/${COLLECTION}`, source: path.join(postmanRoot, COLLECTION) },
];

function buildApp() {
  const app = express();
  app.use('/docs', createDocsRouter({ postmanRoot }));
  return app;
}

// What a browser that cached the page before a template change holds: the old
// source-only ETag and a Last-Modified no older than the file mtime.
function staleValidators(source: string) {
  const stat = fs.statSync(source);
  return {
    'If-None-Match': `W/"${stat.size}-${stat.mtimeMs}"`,
    'If-Modified-Since': new Date(stat.mtimeMs + 60_000).toUTCString(),
  };
}

// docs.ts reuses a render-cache entry only while Date.now() - <source mtime>
// < 5 minutes, so an old checkout re-renders on every request. Pin the clock
// just after the source mtime and assert the source is not re-read, so the
// cache-path cases really take the cache branch.
async function secondRequestFromCache(
  app: express.Express,
  url: string,
  source: string,
  headers: Record<string, string>,
) {
  jest.spyOn(Date, 'now').mockReturnValue(fs.statSync(source).mtimeMs + 1_000);
  expect((await request(app).get(url)).status).toBe(200);
  const reads = jest.spyOn(fs, 'readFileSync');
  const res = await request(app).get(url).set(headers);
  expect(reads.mock.calls.filter(([file]) => file === source)).toEqual([]);
  return res;
}

afterEach(() => jest.restoreAllMocks());

describe.each(PAGES)('/docs $name page HTTP caching', ({ url, source }) => {
  it('answers a matching rendered ETag with 304 on the render cache path', async () => {
    const first = await request(buildApp()).get(url);
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeTruthy();
    expect(first.headers.etag).not.toBe(staleValidators(source)['If-None-Match']);

    const again = await secondRequestFromCache(buildApp(), url, source, { 'If-None-Match': first.headers.etag });
    expect(again.status).toBe(304);
  });

  it('does not 304 a validator derived only from the source file (fresh render path)', async () => {
    const res = await request(buildApp()).get(url).set(staleValidators(source));
    expect(res.status).toBe(200);
    expect(res.text).toContain('Integration Hub Docs');
  });

  it('does not 304 a validator derived only from the source file (render cache path)', async () => {
    const res = await secondRequestFromCache(buildApp(), url, source, staleValidators(source));
    expect(res.status).toBe(200);
    expect(res.text).toContain('Integration Hub Docs');
  });
});
