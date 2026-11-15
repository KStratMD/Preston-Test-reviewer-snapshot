// Pins how the installed Express + qs parse query strings and
// extended URL-encoded bodies, configured as src/middleware/setup/MiddlewareSetup.ts
// does (`express.urlencoded({ extended: true, limit: '10mb' })`). qs 6.16.1
// changed the shape of one mixed input (a key used both as an object and a
// value, then a bracket-only key); ordinary nested objects, arrays and dotted
// keys are controls that must not change. Servers listen on 127.0.0.1 port 0
// and are closed in finally blocks.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const express = createRequire(path.join(repoRoot, 'package.json'))('express');

const MIXED = 'a[z]=o&a=p&a[y]=q&[a]=r';
const MIXED_EXPECTED = { a: { 0: { z: 'o' }, 1: 'p', 2: 'r', y: 'q' } };

async function withServer(fn) {
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.get('/q', (req, res) => res.json(req.query));
  app.post('/f', (req, res) => res.json(req.body));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const getQuery = (base, qs) => fetch(`${base}/q?${qs}`).then((r) => r.json());
const postForm = (base, body) => fetch(`${base}/f`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body,
}).then((r) => r.json());

test('mixed object/value keys parse to the qs 6.16.1 shape in the query string and form bodies', async () => {
  await withServer(async (base) => {
    assert.deepEqual(await getQuery(base, MIXED), MIXED_EXPECTED);
    assert.deepEqual(await postForm(base, MIXED), MIXED_EXPECTED);
  });
});

test('ordinary nested objects, arrays and dotted keys keep their shape', async () => {
  await withServer(async (base) => {
    const input = 'user[name]=Ann&user[roles][]=a&user[roles][]=b&list[0]=x&list[1]=y&a.b=c';
    const expected = { user: { name: 'Ann', roles: ['a', 'b'] }, list: ['x', 'y'], 'a.b': 'c' };
    assert.deepEqual(await getQuery(base, input), expected);
    assert.deepEqual(await postForm(base, input), expected);
  });
});

test('prototype-named keys do not pollute and are not exposed', async () => {
  await withServer(async (base) => {
    const body = await postForm(base, '__proto__[polluted]=1&constructor[prototype][x]=1&ok=1');
    assert.equal(body.ok, '1');
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(({}).x, undefined);
  });
});
