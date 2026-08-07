import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type AuditFinding = {
  file: string;
  recordId?: string;
  category: string;
  keyPath: string;
};

const scriptUrl = pathToFileURL(
  path.resolve(process.cwd(), 'scripts/audit-configuration-artifacts.mjs'),
).href;

function invokeAudit(options: Record<string, unknown>): AuditFinding[] {
  const source = [
    `import { auditConfigurationArtifacts } from ${JSON.stringify(scriptUrl)};`,
    `const findings = auditConfigurationArtifacts(${JSON.stringify(options)});`,
    'process.stdout.write(JSON.stringify(findings));',
  ].join('\n');

  return JSON.parse(execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { encoding: 'utf8' },
  )) as AuditFinding[];
}

function invokeAuditExpectingFailure(options: Record<string, unknown>): string {
  const source = [
    `import { auditConfigurationArtifacts } from ${JSON.stringify(scriptUrl)};`,
    `auditConfigurationArtifacts(${JSON.stringify(options)});`,
  ].join('\n');

  try {
    execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw new Error('Expected the audit invocation to fail');
  } catch (error) {
    const result = error as { stderr?: string };
    return result.stderr ?? String(error);
  }
}

describe('configuration artifact audit', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'configuration-artifact-audit-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports credential locations without exposing values and skips ignored directories', () => {
    fs.writeFileSync(path.join(root, 'safe-placeholder.json'), JSON.stringify({
      id: 'safe-placeholder',
      sourceAuthentication: {
        credentials: {
          apiKey: '<API_KEY>',
          clientSecret: 'squire-demo-client-secret',
          username: 'integration.user@example.com',
        },
      },
      targetAuthentication: {
        credentials: { username: 'testuser@invalid.local' },
      },
    }));
    fs.writeFileSync(path.join(root, 'unsafe-current.json'), JSON.stringify({
      id: 'unsafe-current',
      sourceAuthentication: {
        credentials: {
          apiKey: 'current-sensitive-sentinel',
          baseUrl: 'https://api.example.invalid',
          environment: 'sandbox',
        },
      },
    }));
    fs.writeFileSync(path.join(root, 'unsafe-legacy.json'), JSON.stringify({
      configurations: [
        {
          id: 'unsafe-legacy',
          authentication: {
            source: {
              credentials: { clientSecret: 'legacy-sensitive-sentinel' },
            },
          },
        },
      ],
    }));
    fs.mkdirSync(path.join(root, 'node_modules', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'fixture', 'ignored.json'), JSON.stringify({
      id: 'ignored',
      password: 'ignored-sensitive-sentinel',
    }));

    const findings = invokeAudit({ root, scanPaths: ['.'] });

    expect(findings).toEqual([
      {
        file: 'unsafe-current.json',
        recordId: 'unsafe-current',
        category: 'current-authentication',
        keyPath: 'sourceAuthentication.credentials.apiKey',
      },
      {
        file: 'unsafe-legacy.json',
        recordId: 'unsafe-legacy',
        category: 'legacy-authentication',
        keyPath: 'configurations[0].authentication.source.credentials.clientSecret',
      },
    ]);

    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain('current-sensitive-sentinel');
    expect(serialized).not.toContain('legacy-sensitive-sentinel');
    expect(serialized).not.toContain('ignored-sensitive-sentinel');
  });

  it('follows symlinks inside the root so a link cannot hide credential JSON from the gate', () => {
    const scanned = path.join(root, 'scanned');
    const unscanned = path.join(root, 'unscanned');
    fs.mkdirSync(scanned);
    fs.mkdirSync(unscanned);
    fs.writeFileSync(path.join(unscanned, 'behind-link.json'), JSON.stringify({
      id: 'behind-link',
      sourceAuthentication: {
        credentials: { apiKey: 'linked-sensitive-sentinel' },
      },
    }));
    // A junction rather than a file symlink: Windows needs elevation for the
    // latter and not the former, and POSIX ignores the type argument. The link
    // is the audit's ONLY route to the credential file, because `unscanned/` is
    // not a scan path — which is exactly the shape that used to slip through.
    fs.symlinkSync(unscanned, path.join(scanned, 'linked'), 'junction');

    const findings = invokeAudit({ root, scanPaths: ['scanned'] });

    expect(findings).toEqual([
      {
        file: 'unscanned/behind-link.json',
        recordId: 'behind-link',
        category: 'current-authentication',
        keyPath: 'sourceAuthentication.credentials.apiKey',
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain('linked-sensitive-sentinel');
  });

  it('requires an explicit root and refuses scan paths outside it', () => {
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'configuration-artifact-outside-'));
    fs.writeFileSync(path.join(sibling, 'outside.json'), JSON.stringify({
      password: 'outside-sensitive-sentinel',
    }));

    try {
      const missingRootError = invokeAuditExpectingFailure({ scanPaths: ['.'] });
      const outsideRootError = invokeAuditExpectingFailure({ root, scanPaths: [sibling] });

      expect(missingRootError).toContain('explicit root');
      expect(outsideRootError).toContain('outside explicit root');
      expect(outsideRootError).not.toContain('outside-sensitive-sentinel');
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });
});
