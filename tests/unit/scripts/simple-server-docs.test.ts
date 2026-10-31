/**
 * scripts/simple-server.js (demo / SuiteCentral mock server) no longer serves documentation.
 * Its old /docs copy rendered unsanitised Markdown and joined request paths onto scripts/
 * with no containment, so `/docs/../../<any>.md` read Markdown from anywhere on disk. The
 * CRUD mock and /health documented in docs/squire/squire-suitecentral-mock.md must keep working.
 */
import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';
import * as path from 'path';

jest.useRealTimers();

let child: ChildProcess;
let port: number;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/** Raw HTTP/1.1 exchange so `..` and `<` reach the server unnormalised. */
function raw(method: string, p: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const head = [`${method} ${p} HTTP/1.1`, 'Host: x', 'Connection: close'];
      if (body !== undefined) head.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`);
      s.write(head.join('\r\n') + '\r\n\r\n' + (body ?? ''));
    });
    let d = '';
    s.on('data', c => { d += c; });
    s.on('end', () => resolve({ status: Number(d.slice(9, 12)), text: d }));
    s.on('error', reject);
  });
}

beforeAll(async () => {
  port = await freePort();
  child = spawn(process.execPath, [path.join(process.cwd(), 'scripts', 'simple-server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('simple-server did not start')), 20000);
    child.stdout?.on('data', (c: Buffer) => {
      if (c.toString().includes('Simple server running')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`simple-server exited ${code}`)); });
  });
}, 30000);

afterAll(() => {
  child?.kill();
});

it('does not serve documentation, including traversal paths', async () => {
  for (const p of ['/docs', '/docs/README.md', '/docs/../../docs/README.md', '/docs/<img/src=x/onerror=alert(1)>.md']) {
    const r = await raw('GET', p);
    expect(r.status).toBe(404);
    expect(r.text).toContain('npm run dev');
    expect(r.text).not.toContain('<img');
    expect(r.text).not.toMatch(/<h1|<strong>/);
  }
});

it('keeps the SuiteCentral CRUD mock and /health working', async () => {
  const health = await raw('GET', '/health');
  expect(health.status).toBe(200);
  const created = await raw('POST', '/vendors', JSON.stringify({ name: 'Acme' }));
  expect(created.status).toBe(201);
  expect(created.text).toContain('"name":"Acme"');
  const list = await raw('GET', '/vendors');
  expect(list.status).toBe(200);
  expect(list.text).toContain('Acme');
});
