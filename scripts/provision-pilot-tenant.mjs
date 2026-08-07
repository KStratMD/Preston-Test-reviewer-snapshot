#!/usr/bin/env node
import process from 'node:process';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, chmodSync, renameSync, unlinkSync, accessSync, statSync, constants as fsConstants } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `npm run rotate-embedded-service-token` resolves the script via the
// nearest package.json, so the spawn must execute with this repo's root
// as cwd. Otherwise an operator running `node /abs/path/to/scripts/...`
// from a different directory would either get a "no package.json" failure
// or, worse, run a *different* project's same-named script.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const VALID_PLATFORMS = new Set(['netsuite', 'business_central']);

/**
 * Recompute the token hash for verify-mode integrity. MUST stay in sync with
 * `EmbeddedServiceTokenRepository.hashToken` in
 * `src/services/embedded/EmbeddedServiceTokenRepository.ts` (sha256-hex of the
 * raw token). If the canonical hash function ever changes there, this helper
 * has to track it — see the verify-mode test for the regression net.
 */
function hashToken(rawToken) {
  return createHash('sha256').update(rawToken).digest('hex');
}

function requireValue(flag, next) {
  if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}

function parseArgs(argv) {
  const out = {
    mode: null,
    tenantId: null,
    platform: null,
    platformAccountId: null,
    output: null,
    provisioningOutput: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--tenant') { out.tenantId = requireValue('--tenant', next); i += 1; continue; }
    if (token === '--platform') { out.platform = requireValue('--platform', next); i += 1; continue; }
    if (token === '--platform-account-id') { out.platformAccountId = requireValue('--platform-account-id', next); i += 1; continue; }
    if (token === '--output') { out.output = requireValue('--output', next); i += 1; continue; }
    if (token === '--provisioning-output') { out.provisioningOutput = requireValue('--provisioning-output', next); i += 1; continue; }
    if (token === '--dry-run' || token === '--apply' || token === '--verify') {
      if (out.mode !== null) throw new Error('Pass exactly one of --dry-run, --apply, or --verify');
      out.mode = token.slice(2);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!out.mode) throw new Error('Pass exactly one of --dry-run, --apply, or --verify');
  if (!out.tenantId) throw new Error('--tenant is required');
  if (!out.platform || !VALID_PLATFORMS.has(out.platform)) {
    throw new Error(`--platform must be one of ${[...VALID_PLATFORMS].join(', ')}`);
  }
  if (!out.platformAccountId) throw new Error('--platform-account-id is required');
  if (out.mode === 'apply' && !out.output) throw new Error('--output is required for --apply');
  if (out.mode === 'verify' && !out.provisioningOutput) {
    throw new Error('--provisioning-output is required for --verify');
  }
  return out;
}

function buildPlan(args) {
  return {
    mode: args.mode,
    tenantId: args.tenantId,
    platform: args.platform,
    platformAccountId: args.platformAccountId,
    // Only list actions this orchestration wrapper actually performs.
    // Tenant-lifecycle and governance-posture writes belong to the operator's
    // separate tooling; the runbook directs operators to those audits via the
    // companion `audit-secret-key-encryption` + `audit-governance-posture-reads`
    // commands. Conflating them here would mislead operators about what
    // `--apply` mutates.
    actions: [
      'mint embedded service token via rotate-embedded-service-token CLI',
      'record provisioning artifact for --verify',
      'emit manual governance-posture keys for operator follow-up',
    ],
  };
}

/**
 * Mint an embedded service token by delegating to the existing TypeScript CLI
 * (`npm run rotate-embedded-service-token`). The CLI is the only path that
 * writes to embedded-token storage; this wrapper never does.
 *
 * Test-only escape hatch: when BOTH `PROVISION_PILOT_TENANT_TEST_MODE=1` AND
 * `PROVISION_PILOT_TENANT_TEST_TOKEN_JSON=<json>` are set, the spawn is
 * skipped and the env JSON is returned verbatim. Requiring two env vars makes
 * accidental production triggering effectively impossible.
 */
function mintEmbeddedServiceToken(args) {
  if (
    process.env.PROVISION_PILOT_TENANT_TEST_MODE === '1' &&
    typeof process.env.PROVISION_PILOT_TENANT_TEST_TOKEN_JSON === 'string'
  ) {
    try {
      return JSON.parse(process.env.PROVISION_PILOT_TENANT_TEST_TOKEN_JSON);
    } catch (err) {
      throw new Error(
        `PROVISION_PILOT_TENANT_TEST_TOKEN_JSON is not valid JSON: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  // `--silent` (`-s`) suppresses npm's own progress and lifecycle output so
  // stdout is just the rotate CLI's JSON payload, removing the need for the
  // trailing-`{` heuristic to skip past `> business-systems-integration-hub@...`
  // banner lines.
  const result = spawnSync(
    'npm',
    [
      '--silent',
      'run',
      'rotate-embedded-service-token',
      '--',
      '--tenant',
      args.tenantId,
      '--platform',
      args.platform,
      '--platform-account-id',
      args.platformAccountId,
    ],
    { encoding: 'utf8', cwd: REPO_ROOT },
  );
  // `result.error` is set when the spawn itself fails (npm not on PATH, EACCES,
  // etc.); `result.status` is null in that case. Surface both so operators can
  // tell a spawn failure apart from a non-zero exit from the rotate CLI.
  if (result.error) {
    throw new Error(
      `embedded token provisioning could not spawn npm: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const exitCode = result.status === null ? 'unknown' : String(result.status);
    throw new Error(
      `embedded token provisioning failed (exit ${exitCode}): ${result.stderr || result.stdout || 'no output'}`,
    );
  }
  // The rotate CLI emits other log lines on stderr; the JSON payload is the
  // last block of stdout. Parse the trailing JSON object.
  const stdout = result.stdout || '';
  const jsonStart = stdout.lastIndexOf('{');
  if (jsonStart < 0) {
    throw new Error(`embedded token provisioning produced no JSON on stdout: ${stdout}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
}

function preflightOutputWritable(outputPath) {
  // Validate writability of the artifact path BEFORE minting the token.
  // The rotate CLI mutates embedded-token storage and (per the storage
  // contract) burns the previous active token; if we minted and then failed
  // to persist, the operator would lose the only persisted copy of the new
  // bearer and be forced to rotate again. Fail closed here instead.

  // A trailing slash syntactically implies a directory — refuse early so the
  // operator gets a clear error instead of an EISDIR mid-write.
  if (outputPath.endsWith('/')) {
    throw new Error(`cannot write provisioning artifact to ${outputPath}: path looks like a directory (ends with /)`);
  }
  const dir = dirname(outputPath) || '.';
  // Confirm the parent path is actually a directory before checking
  // permissions. A regular file at the parent path can satisfy
  // `accessSync(W_OK | X_OK)` (read/write/execute bits on a regular file),
  // and the subsequent write/rename would then fail with ENOTDIR — after
  // the rotate CLI has already burned the previous token.
  let parentStat;
  try {
    parentStat = statSync(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`cannot write provisioning artifact to ${outputPath}: directory does not exist (${dir})`);
    }
    throw new Error(`cannot stat provisioning output directory ${dir}: ${err instanceof Error ? err.message : err}`);
  }
  if (!parentStat.isDirectory()) {
    throw new Error(`cannot write provisioning artifact to ${outputPath}: parent path is not a directory (${dir})`);
  }
  try {
    // W_OK alone isn't sufficient: creating/replacing a file in a directory
    // also requires search/execute (X_OK) on that directory. Checking both
    // makes the preflight actually predict success of the atomic-rename
    // write below, not just its first byte.
    accessSync(dir, fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    throw new Error(`cannot write provisioning artifact to ${outputPath}: directory is not writable or not searchable (${dir})`);
  }
  // If the path itself already exists, it must be a regular file the rename
  // can replace. A directory at this path would let the parent-dir check
  // above pass and then EISDIR the write/rename later, after the token has
  // already been minted — exactly the regression preflight exists to
  // prevent.
  let existing;
  try {
    existing = statSync(outputPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;  // path will be created — fine
    throw new Error(`cannot stat provisioning output ${outputPath}: ${err instanceof Error ? err.message : err}`);
  }
  if (existing.isDirectory()) {
    throw new Error(`cannot write provisioning artifact to ${outputPath}: path is a directory`);
  }
  try {
    accessSync(outputPath, fsConstants.W_OK);
  } catch {
    throw new Error(`cannot write provisioning artifact to ${outputPath}: existing file is not writable`);
  }
}

function apply(args) {
  const plan = buildPlan(args);
  preflightOutputWritable(args.output);
  const token = mintEmbeddedServiceToken(args);
  if (!token || typeof token.rawToken !== 'string' || typeof token.tokenHash !== 'string') {
    throw new Error('embedded token provisioning returned malformed payload');
  }
  // Symmetric to the verify-side integrity gate: refuse to persist an
  // artifact whose tokenHash doesn't match sha256(rawToken). A bad stub,
  // future CLI bug, or accidental operator edit could otherwise produce an
  // artifact that *must* fail verify/integration later — fail closed at
  // mint time instead of writing the inconsistent record to disk.
  if (hashToken(token.rawToken) !== token.tokenHash) {
    throw new Error('embedded token provisioning returned a tokenHash that does not match sha256(rawToken)');
  }
  const artifact = {
    mode: 'apply',
    tenantId: args.tenantId,
    platform: args.platform,
    platformAccountId: args.platformAccountId,
    plan,
    embeddedServiceToken: { rawToken: token.rawToken, tokenHash: token.tokenHash },
    manualGovernanceKeys: [
      'governance.allow_pii',
      'governance.block_on_detection',
      'governance.auto_redact',
      'governance.pii_types_csv',
    ],
  };
  // The artifact carries the raw embedded service token, so it must never
  // exist on disk at broader-than-0o600 permissions — not even briefly.
  // `writeFileSync(..., { mode: 0o600 })` only honors the mode when the file
  // is CREATED; rerunning `--apply` against an existing artifact path would
  // truncate the existing inode but inherit its previous permissions.
  // Atomic temp-file + rename eliminates that window and the
  // chmod-after-write race entirely.
  writeArtifactAtomic(args.output, JSON.stringify(artifact, null, 2));
  // Return a redacted SUMMARY for stdout. The raw token is sensitive and must
  // stay inside the 0o600 artifact file; printing it to stdout would leak it
  // into terminal scrollback, CI logs, and any process-tree inspection. The
  // tokenHash is non-secret (it's the validator-side handle) and is kept in
  // the summary so operators can correlate the apply log with downstream
  // audits. Operators retrieve the rawToken from the artifact file via the
  // secure channel the runbook documents.
  return {
    mode: 'apply',
    tenantId: args.tenantId,
    platform: args.platform,
    platformAccountId: args.platformAccountId,
    outputPath: args.output,
    embeddedServiceToken: { tokenHash: token.tokenHash, rawTokenRedacted: true },
    manualGovernanceKeys: artifact.manualGovernanceKeys,
  };
}

function writeArtifactAtomic(target, contents) {
  const tempPath = join(
    dirname(target),
    `.${basename(target)}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`,
  );
  let needsCleanup = true;
  try {
    writeFileSync(tempPath, contents, { mode: 0o600 });
    // belt-and-suspenders: a hostile umask can clear bits at creation on
    // some filesystems; chmod the new inode before it becomes visible at
    // the operator-supplied path.
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, target);
    needsCleanup = false;
  } finally {
    if (needsCleanup) {
      try { unlinkSync(tempPath); } catch { /* tempfile may not exist if writeFileSync failed */ }
    }
  }
}

function verify(args) {
  let raw;
  try {
    raw = readFileSync(args.provisioningOutput, 'utf8');
  } catch (err) {
    // Distinguish a genuinely missing artifact (ENOENT) from one that exists
    // but can't be read (EACCES) or is the wrong kind of inode (EISDIR) —
    // the operator's remediation is different in each case.
    const code = err && typeof err === 'object' ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'ENOENT') {
      throw new Error(`provisioning artifact not found at ${args.provisioningOutput}: ${message}`);
    }
    throw new Error(`provisioning artifact not readable at ${args.provisioningOutput}: ${message}`);
  }
  let artifact;
  try {
    artifact = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `provisioning artifact is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
  // `JSON.parse` happily returns `null`, arrays, numbers, strings, and
  // booleans — none of which the verify path can read fields off without
  // throwing TypeError. Reject everything that isn't a plain object up front
  // so the operator sees a clear provisioning-artifact error.
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('provisioning artifact must be a JSON object');
  }
  const mismatches = [];
  if (artifact.tenantId !== args.tenantId) mismatches.push('tenantId');
  if (artifact.platform !== args.platform) mismatches.push('platform');
  if (artifact.platformAccountId !== args.platformAccountId) mismatches.push('platformAccountId');
  if (mismatches.length > 0) {
    throw new Error(`provisioning artifact mismatch on: ${mismatches.join(', ')}`);
  }
  const token = artifact.embeddedServiceToken;
  const tokenPresent =
    Boolean(token) && typeof token.rawToken === 'string' && token.rawToken.length > 0 &&
    typeof token.tokenHash === 'string' && token.tokenHash.length > 0;
  if (!tokenPresent) {
    throw new Error('provisioning artifact is missing embeddedServiceToken.rawToken or .tokenHash');
  }
  // Integrity check: a tampered artifact that satisfies the presence and
  // tenant/platform/account assertions could still carry a rawToken whose
  // hash doesn't match the stored tokenHash — i.e. the bearer is no longer
  // the one the rotate CLI minted. Recompute the canonical sha256 hash and
  // refuse the artifact on mismatch so verify is a real integrity gate, not
  // just a shape check.
  if (hashToken(token.rawToken) !== token.tokenHash) {
    throw new Error('provisioning artifact hash mismatch: tokenHash does not match sha256(rawToken)');
  }
  return {
    mode: 'verify',
    tenantId: args.tenantId,
    platform: args.platform,
    platformAccountId: args.platformAccountId,
    embeddedTokenPresent: true,
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.mode === 'dry-run') {
    result = buildPlan(args);
  } else if (args.mode === 'apply') {
    result = apply(args);
  } else {
    result = verify(args);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
