#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function isWsl() {
  return process.platform === 'linux' && (
    Boolean(process.env.WSL_DISTRO_NAME) ||
    Boolean(process.env.WSL_INTEROP)
  );
}

function getFingerprint() {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0] || 0),
    isWsl: isWsl(),
    createdAt: new Date().toISOString(),
  };
}

function main() {
  const repoRoot = process.cwd();
  const markerPath = path.join(repoRoot, '.node-modules-runtime.json');
  const fingerprint = getFingerprint();

  try {
    fs.writeFileSync(markerPath, `${JSON.stringify(fingerprint, null, 2)}\n`, 'utf8');
    process.stdout.write(`[runtime] wrote ${path.basename(markerPath)} (${fingerprint.platform}/${fingerprint.arch}${fingerprint.isWsl ? ', wsl' : ''})\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[runtime] warning: failed to write marker file: ${message}\n`);
  }
}

main();
