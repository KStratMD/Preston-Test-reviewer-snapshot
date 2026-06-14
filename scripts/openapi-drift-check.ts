#!/usr/bin/env ts-node
/*
  OpenAPI Drift Check
  Provides both a reusable library function and CLI entry point for comparing the served /openapi.json
  output with the committed spec file (prefers openapi.full.yaml -> openapi.yaml) and reporting drift.
*/
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import yaml from 'js-yaml';

function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(v => stableStringify(v)).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

async function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout for ${url}`));
    });
    req.setTimeout(8000);
    req.on('error', reject);
  });
}

function locateSpecRoot(start: string): string | null {
  const maxLevels = 6;
  let current = start;
  for (let i = 0; i < maxLevels; i++) {
    const full = path.join(current, 'openapi.full.yaml');
    const base = path.join(current, 'openapi.yaml');
    if (fs.existsSync(full) || fs.existsSync(base)) return current;
    const parent = path.dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }
  return null;
}

function normalize(o: any): any {
  if (o && typeof o === 'object') {
    const clone: any = Array.isArray(o) ? [] : {};
    for (const k of Object.keys(o)) {
      if (k === 'version' && (o as any).title) continue;
      clone[k] = normalize(o[k]);
    }
    return clone;
  }
  return o;
}

interface DriftCheckOptions {
  baseUrl?: string;
  specRoot?: string;
  debug?: boolean;
}

class DriftCheckError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

export async function runOpenApiDriftCheck(options: DriftCheckOptions = {}): Promise<string> {
  const debug = options.debug ?? process.env.DRIFT_DEBUG === '1';
  const startRoot = options.specRoot
    ? path.resolve(options.specRoot)
    : process.env.DRIFT_SPEC_ROOT
      ? path.resolve(process.env.DRIFT_SPEC_ROOT)
      : process.cwd();

  const specRoot = locateSpecRoot(startRoot);
  if (!specRoot) {
    throw new DriftCheckError(`No OpenAPI spec root found starting from ${startRoot}`, 1);
  }
  if (debug) {
    console.log('[drift] spec root resolved to', specRoot);
  }

  const fullPath = path.join(specRoot, 'openapi.full.yaml');
  const basePath = path.join(specRoot, 'openapi.yaml');

  const candidateSpecs: { name: string; obj: any; hash: string }[] = [];
  for (const p of [fullPath, basePath]) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const obj = yaml.load(raw);
        candidateSpecs.push({ name: path.basename(p), obj, hash: '' });
      } catch (e) {
        console.warn('Failed to parse spec candidate', p, e);
      }
    }
  }
  if (candidateSpecs.length === 0) {
    throw new DriftCheckError(`No OpenAPI spec file found (openapi.full.yaml or openapi.yaml) under ${specRoot}`, 1);
  }
  if (debug) {
    console.log('[drift] candidate specs:', candidateSpecs.map(c => c.name));
  }

  for (const c of candidateSpecs) {
    const canonical = stableStringify(normalize(c.obj));
    c.hash = crypto.createHash('sha256').update(canonical).digest('hex');
  }
  if (debug) {
    console.log('[drift] candidate hashes:', candidateSpecs.map(c => `${c.name}:${c.hash}`));
  }

  const baseUrl = (options.baseUrl || process.env.DRIFT_CHECK_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const servedUrl = `${baseUrl}/openapi.json`;
  let served: any;
  try {
    if (debug) {
      console.log('[drift] fetching served spec from', servedUrl);
    }
    served = await fetchJson(servedUrl);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new DriftCheckError(`Failed to fetch served spec: ${message}`, 2);
  }

  const canonicalServed = stableStringify(normalize(served));
  const servedHash = crypto.createHash('sha256').update(canonicalServed).digest('hex');
  if (debug) {
    console.log('[drift] served hash:', servedHash);
  }

  const match = candidateSpecs.find(c => c.hash === servedHash);
  if (!match) {
    const hashes = candidateSpecs.map(c => `${c.name}:${c.hash}`).join(', ');
    throw new DriftCheckError(`OPENAPI DRIFT DETECTED (no variant matched). Served hash ${servedHash}. Candidates: ${hashes}`, 3);
  }
  if (debug) {
    console.log('[drift] matched variant', match.name);
  }
  return match.name;
}

async function runCli(): Promise<void> {
  try {
    const variant = await runOpenApiDriftCheck();
    console.log(`OpenAPI drift check passed using variant: ${variant}`);
    process.exit(0);
  } catch (e) {
    if (e instanceof DriftCheckError) {
      console.error(e.message);
      process.exit(e.exitCode);
    }
    console.error('Drift check failure:', e);
    process.exit(99);
  }
}

if (require.main === module) {
  runCli();
}
