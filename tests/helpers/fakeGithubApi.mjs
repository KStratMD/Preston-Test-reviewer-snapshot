import http from 'node:http';
import fs from 'node:fs';

// Local-only fixture API. Re-read state per request so tests can dismiss reviews without restarting.
const [stateFile, portFile, requestsFile] = process.argv.slice(2);
if (!stateFile || !portFile || !requestsFile) throw new Error('state, port and request-log paths required');
let pullReads = 0;
const server = http.createServer(async (request, response) => {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const url = new URL(request.url, 'http://127.0.0.1');
  if (state.unavailable) { response.writeHead(503); response.end('unavailable'); return; }
  let body = ''; for await (const chunk of request) body += chunk;
  fs.appendFileSync(requestsFile, JSON.stringify({ method: request.method, path: url.pathname, body: body ? JSON.parse(body) : null }) + '\n');
  const send = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (request.method === 'POST' && /\/statuses\//.test(url.pathname)) { send({}); return; }
  if (/\/pulls\/5$/.test(url.pathname)) {
    pullReads++;
    send(state.moveAfterPullReads && pullReads > state.moveAfterPullReads ? { ...state.pull, head: { ...state.pull.head, sha: 'f'.repeat(40) } } : state.pull); return;
  }
  if (/\/reviews$/.test(url.pathname)) { send(state.reviews); return; }
  if (/\/files$/.test(url.pathname)) { send(state.files); return; }
  if (/\/branches\//.test(url.pathname)) { send({ commit: { sha: state.canonical ?? state.pull.base.sha } }); return; }
  const contents = url.pathname.split('/contents/')[1];
  if (contents) {
    const path = contents.split('/').map(decodeURIComponent).join('/');
    const bytes = state.contents?.[`${url.searchParams.get('ref')}:${path}`] ?? state.contents?.[path];
    if (typeof bytes === 'string') { response.end(bytes); return; }
  }
  response.writeHead(404); response.end('unknown fixture resource');
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
process.on('SIGTERM', () => server.close());
