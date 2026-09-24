#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = process.cwd();
const nodeModulesDir = path.join(repoRoot, 'node_modules');
const markerPath = path.join(repoRoot, '.node-modules-runtime.json');

function isWsl() {
  return process.platform === 'linux' && (
    Boolean(process.env.WSL_DISTRO_NAME) ||
    Boolean(process.env.WSL_INTEROP)
  );
}

function currentFingerprint() {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0] || 0),
    isWsl: isWsl(),
  };
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return null;
  }
}

function mismatchReason(current, marker) {
  if (!marker) return 'missing marker';
  if (marker.platform !== current.platform) return `platform mismatch (${marker.platform} -> ${current.platform})`;
  if (marker.arch !== current.arch) return `arch mismatch (${marker.arch} -> ${current.arch})`;
  if (Number(marker.nodeMajor) !== Number(current.nodeMajor)) return `node major mismatch (${marker.nodeMajor} -> ${current.nodeMajor})`;
  if (Boolean(marker.isWsl) !== Boolean(current.isWsl)) return `WSL mode mismatch (${marker.isWsl} -> ${current.isWsl})`;
  return '';
}

function isLikelyBinaryMismatch(errorMessage) {
  const msg = String(errorMessage || '').toLowerCase();
  return (
    msg.includes('not a valid win32 application') ||
    msg.includes('invalid elf header') ||
    msg.includes('wrong elf class') ||
    msg.includes('bad cpu type in executable') ||
    msg.includes('module did not self-register')
  );
}

function probeNativeModules() {
  try {
    // better-sqlite3 is a native module used in this project and a common
    // failure point when switching between Windows and WSL in one folder.
    require('better-sqlite3');
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNpmCi() {
  process.stdout.write('[runtime] reinstalling dependencies for current runtime (npm ci)...\n');
  const result = spawnSync(npmCommand(), ['ci', '--no-audit', '--no-fund'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    process.stderr.write('\n[runtime] automatic reinstall failed.\n');
    process.stderr.write('[runtime] if this includes EIO/EPERM unlink errors, stop running Node servers in both Windows and WSL and retry.\n');
    process.stderr.write('[runtime] then run `npm ci` manually in this same environment.\n');
    process.exit(result.status || 1);
  }
}

function failWithInstructions(reason) {
  process.stderr.write(`\n[runtime] node_modules is not compatible with this environment: ${reason}\n`);
  process.stderr.write('[runtime] this usually happens when switching between Windows and WSL in the same folder.\n');
  process.stderr.write('[runtime] run `npm ci` in the current shell, then retry.\n');
  process.exit(1);
}

function main() {
  const current = currentFingerprint();
  const autoFix = process.env.AUTO_FIX_NODE_MODULES !== '0' && process.env.CI !== 'true';

  if (!fs.existsSync(nodeModulesDir)) {
    if (autoFix) {
      runNpmCi();
      return;
    }
    failWithInstructions('node_modules directory missing');
  }

  const marker = readMarker();
  const markerMismatch = mismatchReason(current, marker);
  if (markerMismatch) {
    if (autoFix) {
      runNpmCi();
    } else {
      failWithInstructions(markerMismatch);
    }
    return;
  }

  const nativeProbe = probeNativeModules();
  if (!nativeProbe.ok) {
    const reason = isLikelyBinaryMismatch(nativeProbe.message)
      ? nativeProbe.message
      : `native dependency probe failed (${nativeProbe.message})`;

    if (autoFix) {
      runNpmCi();
    } else {
      failWithInstructions(reason);
    }
    return;
  }

  process.stdout.write(`[runtime] dependency runtime check OK (${current.platform}/${current.arch}${current.isWsl ? ', wsl' : ''})\n`);
}

main();
