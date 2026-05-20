/**
 * Embedded ERP Surface — static-HTML handler factory.
 *
 * Used to mount embedded module HTML pages (e.g. sync-error-triage.html) onto
 * dedicated routes inside the embedded route group so they inherit the
 * `embeddedCspMiddleware` `frame-ancestors` gate. The generic `htmlFiles`
 * whitelist in RouteSetup.ts is INTENTIONALLY NOT used for embedded pages —
 * it emits cache headers but no CSP, which would silently weaken the
 * iframe-embedding gate.
 */
import path from 'node:path';
import type { Request, Response } from 'express';

const PUBLIC_EMBEDDED = path.resolve(process.cwd(), 'public', 'embedded');

/**
 * Whitelist of basenames callers may serve. Adding a new embedded page
 * requires adding it here AND mounting the route in RouteSetup.ts so the
 * embeddedCspMiddleware gate is applied. Path-traversal hardening: even
 * though current call sites pass constants, the explicit allowlist + the
 * separator/path.basename checks below make it impossible to escape
 * PUBLIC_EMBEDDED if a future caller threads user input through.
 */
const ALLOWED_BASENAMES = new Set<string>([
  'sync-error-triage.html',
  'approvals.html',
]);

export function sendEmbeddedHtml(basename: string) {
  // Separator/empty-string guard FIRST so traversal attempts get a specific
  // error message (the unit test pins this exact text). Allowlist check
  // second so unknown basenames (e.g. `unknown.html`) get a different signal.
  if (
    basename.length === 0 ||
    basename !== path.basename(basename) ||
    basename.includes('/') ||
    basename.includes('\\')
  ) {
    throw new Error('sendEmbeddedHtml expects a file basename without path separators');
  }
  if (!ALLOWED_BASENAMES.has(basename)) {
    throw new Error(`sendEmbeddedHtml: basename not in allowlist: ${basename}`);
  }
  // Resolve once at factory time, not per-request — immutable closure capture.
  const filePath = path.join(PUBLIC_EMBEDDED, basename);
  return (_req: Request, res: Response): void => {
    res.sendFile(filePath);
  };
}
