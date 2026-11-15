import path from 'node:path';
import type { Response } from 'express';
import { sendEmbeddedHtml } from '../../../src/middleware/embeddedHtmlHandler';

describe('sendEmbeddedHtml', () => {
  it.each([
    'sync-error-triage.html',
    'approvals.html',
    'lineage.html',
    'reconciliation.html',
  ])('uses public/embedded basename path when input is valid: %s', (basename) => {
    const sendFile = jest.fn();
    const handler = sendEmbeddedHtml(basename);
    handler({} as never, { sendFile } as unknown as Response);
    expect(sendFile).toHaveBeenCalledWith(
      path.resolve(process.cwd(), 'public', 'embedded', basename),
    );
  });

  it.each([
    '../sync-error-triage.html',
    '..\\sync-error-triage.html',
    'nested/sync-error-triage.html',
    'nested\\sync-error-triage.html',
    '',
  ])('throws for invalid basename: %s', (basename) => {
    expect(() => sendEmbeddedHtml(basename)).toThrow(
      'sendEmbeddedHtml expects a file basename without path separators',
    );
  });

  it('throws for basenames not in the allowlist', () => {
    expect(() => sendEmbeddedHtml('unknown.html')).toThrow(
      'sendEmbeddedHtml: basename not in allowlist: unknown.html',
    );
  });
});
