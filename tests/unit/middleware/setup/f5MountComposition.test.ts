/**
 * F5 Task 6 (Codex R1 finding 4, source-composition half): /api/help mounts in
 * ServerBootstrap.start() (src/index.ts), which App-boot tests cannot reach —
 * the App class never runs the bootstrap path. Until a bootstrap-level test
 * seam exists (F6 candidate), this brittle-but-honest test reads src/index.ts
 * as TEXT and pins the composition:
 *
 *   (a) the strict helper `mountHelpRoutes(this.app,` is called;
 *   (b) the bare `app.use('/api/help'` mount pattern is absent (a revert to a
 *       gateless mount reintroduces it);
 *   (c) the EXACT aliased error-handler re-registration
 *       `this.app.use(helpErrorHandler(this.logger))` appears AFTER the
 *       mountHelpRoutes call site — the help router relies on the error
 *       handler being re-registered behind the late mount (Task 4, R2-6).
 */

import { readFileSync } from 'fs';
import path from 'path';

const INDEX_TS = path.resolve(__dirname, '../../../../src/index.ts');

describe('F5 mount composition — index.ts help mount (source evidence)', () => {
  const source = readFileSync(INDEX_TS, 'utf8');
  const lines = source.split(/\r?\n/);

  const lineOf = (needle: string): number =>
    lines.findIndex((line) => line.includes(needle));

  it('calls the strict mountHelpRoutes helper with this.app', () => {
    expect(lineOf('mountHelpRoutes(this.app,')).toBeGreaterThanOrEqual(0);
  });

  it('contains no bare /api/help mount', () => {
    expect(source).not.toContain("app.use('/api/help'");
  });

  it('re-registers the aliased error handler AFTER the help mount', () => {
    const mountLine = lineOf('mountHelpRoutes(this.app,');
    const handlerLine = lineOf('this.app.use(helpErrorHandler(this.logger))');

    expect(mountLine).toBeGreaterThanOrEqual(0);
    expect(handlerLine).toBeGreaterThanOrEqual(0);
    expect(handlerLine).toBeGreaterThan(mountLine);
  });
});
