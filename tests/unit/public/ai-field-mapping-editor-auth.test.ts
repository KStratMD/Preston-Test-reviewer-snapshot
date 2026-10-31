/**
 * Every same-origin API call in the AI Field Mapping editor must forward the
 * operator's bearer token through `_authHeaders`.
 *
 * Regression: the schema fetch, Generate suggestions, accept, feedback,
 * unmappable-field detection, the custom-field proposal, the configurations
 * list, the providers probe and the AI status check sent no Authorization
 * header. Every one of those routes needs an identity in a production
 * deployment (only some AI-proxy mapping routes admit anonymous callers, and
 * only in a hosted demo), so the central tenant gate answered
 * 403 TENANT_REQUIRED and the editor fell back to demo behaviour without
 * saying so. The shared help widget's provider-config call and the
 * demo-mode status store had the same gap on routes that always require
 * authentication.
 *
 * The check covers every `fetch(` in the file, not only literal `/api/`
 * paths: the status check built its URL in a variable and slipped past a
 * literal-path pattern. The only calls exempt are the ones that never reach
 * this server: direct third-party LLM provider requests (`endpoint`) and the
 * static `/sample-data/` files.
 */
import fs from 'fs';
import path from 'path';

const editorPath = path.resolve(__dirname, '../../../public/ai-field-mapping-editor.html');

const EXEMPT = [
  /\bfetch\(\s*endpoint\b/, // direct third-party LLM provider call
  /\bfetch\(\s*`\$\{endpoint\}/, // same, with a query string
  /\bfetch\(\s*`\/sample-data\//, // static sample files
];

describe('ai-field-mapping-editor API calls', () => {
  const lines = fs.readFileSync(editorPath, 'utf8').split(/\r?\n/);
  // The options object may continue on the following lines, so the call
  // window is the fetch line plus the next five.
  const calls = lines
    .map((line, i) => ({ line: i + 1, text: line, window: lines.slice(i, i + 6).join('\n') }))
    .filter(({ text }) => /\bfetch\(/.test(text));
  const serverCalls = calls.filter(({ text }) => !EXEMPT.some((re) => re.test(text)));

  it('finds the editor fetch calls (guards against the pattern silently matching nothing)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(25);
    expect(serverCalls.length).toBeGreaterThanOrEqual(20);
  });

  it('forwards the bearer token on every call to this server', () => {
    const missing = serverCalls
      .filter(({ window }) => !window.includes('this._authHeaders('))
      .map(({ line, text }) => `${line}: ${text.trim()}`);
    expect(missing).toEqual([]);
  });
});

describe('shared components loaded by the editor', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');

  it('the help widget forwards the token on its provider-config call', () => {
    const src = read('public/components/help-chat-widget.js');
    const at = src.indexOf("fetch('/api/ai-config/tasks");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toContain('getAuthHeaders()');
  });

  it('the demo-mode store forwards the token on its status call', () => {
    const src = read('public/universal/demo-mode-store.js');
    const at = src.indexOf('fetch(API_ENDPOINT');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toContain('authHeaders()');
  });
});
