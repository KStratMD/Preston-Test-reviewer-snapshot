/**
 * R6 (fallback-safety guard): with `marked` unavailable, docs.ts uses its built-in renderer.
 * Under Jest the ESM-only `marked` cannot be imported, so this file deliberately does NOT map it
 * to the UMD build; the first assertion proves the fallback is the renderer in use. The guard
 * only claims the output is safe on that path; tests/unit/routes/docs-sanitizer-wiring.test.ts
 * proves the sanitiser also runs on it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import { createDocsRouter } from '../../../src/routes/docs';

let tmp: string;
let app: express.Express;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-fallback-'));
  fs.mkdirSync(path.join(tmp, 'docs'));
  fs.writeFileSync(
    path.join(tmp, 'docs', 'hostile.md'),
    [
      '**b**',
      '',
      'raw img: <img src=x onerror="alert(1)">',
      '',
      '[x](javascript:alert(1))',
      '',
      '<div onmouseover="alert(3)">html block text</div>',
      '',
    ].join('\n'),
    'utf8',
  );
  app = express();
  app.use('/docs', createDocsRouter({ docsRoot: path.join(tmp, 'docs'), repoRoot: path.join(tmp, 'repo') }));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

it('R6: the fallback renderer is in use and its output carries no active markup', async () => {
  const res = await request(app).get('/docs/hostile.md');
  const body = res.text.match(/<article[^>]*>([\s\S]*)<\/article>/)?.[1] ?? '';
  // Proves this is the fallback: real marked would emit <strong>.
  expect(body).not.toContain('<strong>');
  expect(body).toContain('**b**');
  for (const t of body.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    expect(t).not.toMatch(/\son[a-z]+\s*=/i);
    expect(t).not.toMatch(/javascript:/i);
  }
});
