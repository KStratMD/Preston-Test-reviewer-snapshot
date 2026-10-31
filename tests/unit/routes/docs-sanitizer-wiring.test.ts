/**
 * R6b: both renderers (real marked and the built-in fallback) funnel through sanitizeDocsHtml,
 * once per rendered document, for full pages and directory README prefaces alike.
 *
 * Each case loads docs.ts in an isolated module registry and spies on that registry's copy of
 * the helper module, so the spy observes exactly the calls the router makes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

type Loaded = {
  createDocsRouter: typeof import('../../../src/routes/docs').createDocsRouter;
  spy: jest.SpyInstance;
};

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-wiring-'));
  fs.mkdirSync(path.join(tmp, 'docs', 'dir'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'docs', 'page.md'), '# P\n\n**b**\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'docs', 'dir', 'README.md'), '# R\n', 'utf8');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function load(withRealMarked: boolean): Loaded {
  let loaded: Loaded | undefined;
  jest.isolateModules(() => {
    if (withRealMarked) {
      jest.doMock('marked', () =>
        jest.requireActual(path.join(path.dirname(require.resolve('marked/package.json')), 'lib', 'marked.umd.js')),
      );
    } else {
      jest.dontMock('marked');
    }
    const helpers = require('../../../src/utils/safeDocsHtml') as typeof import('../../../src/utils/safeDocsHtml');
    const spy = jest.spyOn(helpers, 'sanitizeDocsHtml');
    const docs = require('../../../src/routes/docs') as typeof import('../../../src/routes/docs');
    loaded = { createDocsRouter: docs.createDocsRouter, spy };
  });
  if (!loaded) throw new Error('module load failed');
  return loaded;
}

async function exercise({ createDocsRouter, spy }: Loaded): Promise<{ page: string; calls: number[] }> {
  const app = express();
  app.use('/docs', createDocsRouter({ docsRoot: path.join(tmp, 'docs'), repoRoot: path.join(tmp, 'repo') }));
  const calls: number[] = [];
  const page = (await request(app).get('/docs/page.md')).text;
  calls.push(spy.mock.calls.length);
  await request(app).get('/docs/dir');
  calls.push(spy.mock.calls.length);
  return { page, calls };
}

it('R6b: the real-marked path calls sanitizeDocsHtml once per rendered document', async () => {
  const { page, calls } = await exercise(load(true));
  expect(page).toContain('<strong>b</strong>'); // real marked, not the fallback
  expect(calls).toEqual([1, 2]);
});

it('R6b: the fallback path calls sanitizeDocsHtml once per rendered document', async () => {
  const { page, calls } = await exercise(load(false));
  expect(page).not.toContain('<strong>'); // fallback renderer
  expect(calls).toEqual([1, 2]);
});
