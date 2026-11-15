import express, { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { uuidv4 } from '../utils/uuid';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import { fromRouteMapping, ROUTE_TRANSFORMATIONS } from '../domain/mapping/adapters/fromRouteMapping';
import { MappingContractError, validateMappingSet } from '../domain/mapping/MappingContract';
import { isDemo } from '../utils/features';

/**
 * Task A3 (tranche 2): this surface is DEMO-ONLY. The store is one global flat
 * file with no tenant column, so the family mounts only under isDemo() and is
 * classified `demo` in ROUTE_MANIFEST. It is not a Blueprint source.
 *
 * The accepted vocabulary is exactly what the engine executes; the previous
 * list carried six words (format, conditional, uppercase, lowercase, trim,
 * replace) that no engine branch implemented. Every field is adapted through
 * fromRouteMapping(), which validates against the canonical contract.
 */
const ALLOWED_TRANSFORMATIONS = ROUTE_TRANSFORMATIONS;

/** The flat file exists but cannot be read as a mapping array. Never silently `[]`. */
export class MappingStoreCorruptError extends Error {
  constructor(public readonly storePath: string, cause?: unknown) {
    super(`mapping store is corrupt: ${storePath}`, cause === undefined ? undefined : { cause });
    this.name = 'MappingStoreCorruptError';
  }
}

const FieldSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  transformation: z.string().min(1),
  params: z.record(z.string(), z.any()).optional(),
});

const MappingSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  sourceSystem: z.string().min(1),
  targetSystem: z.string().min(1),
  fields: z.array(FieldSchema).min(1),
  // metadata
  version: z.number().int().positive().optional(),
  notes: z.string().optional(),
  createdBy: z.string().optional(),
  publish: z.boolean().optional(),
  published: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  publishedAt: z.string().optional(),
});

/**
 * What the store may hold: a request-shaped mapping WITH the id the /:id
 * routes address it by (the request schema leaves id optional because POST
 * assigns one; Codex round 11 on PR #1253).
 */
const StoredMappingSchema = MappingSchema.extend({ id: z.string().min(1) });

type Field = z.infer<typeof FieldSchema>;
type Mapping = z.infer<typeof MappingSchema> & {
  id: string;
  status?: string;
  fieldCount?: number;
  lastUpdated?: string;
  completeness?: number;
  publish?: boolean;  // Ensure publish property is typed
};

function getStorePath(): string {
  const dir = path.resolve(process.cwd(), 'config');
  try { 
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); 
  } catch {
    // Ignore directory creation errors
  }
  return path.join(dir, 'mappings.json');
}

function readAll(): Mapping[] {
  const p = getStorePath();
  if (!fs.existsSync(p)) return [];
  // Task A3: a store that exists but cannot be read as an array is corrupt.
  // The old `catch { return []; }` reported an empty catalogue over a broken
  // file, and a subsequent write would have replaced the file with that [].
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new MappingStoreCorruptError(p, err);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new MappingStoreCorruptError(p, err);
  }
  if (!Array.isArray(data)) throw new MappingStoreCorruptError(p, new Error('store is not an array'));
  // Codex round 10 on PR #1253: an entry persisted before the contract (or
  // edited on disk) survived every later write unchanged and unvalidated. An
  // entry that fails the route schema or the contract is store corruption:
  // nothing is read from, or written over, a store holding one.
  const ids = new Set<string>();
  data.forEach((entry, i) => {
    const parsed = StoredMappingSchema.safeParse(entry);
    if (!parsed.success) {
      throw new MappingStoreCorruptError(p, new Error(`entry [${i}] fails the mapping schema: ${parsed.error.issues.map((x) => x.message).join('; ')}`));
    }
    const contract = validateThroughContract(parsed.data.fields);
    if (!contract.ok) {
      throw new MappingStoreCorruptError(p, new Error(`entry [${i}] fails the mapping contract: ${contract.issues.join('; ')}`));
    }
    // Codex round 13 on PR #1253: two entries with one id — GET answered the
    // first, DELETE removed both. An id addresses exactly one entry.
    if (ids.has(parsed.data.id)) {
      throw new MappingStoreCorruptError(p, new Error(`entry [${i}] repeats id '${parsed.data.id}'`));
    }
    ids.add(parsed.data.id);
  });
  return data as Mapping[];
}

function writeAll(mappings: Mapping[]) {
  const p = getStorePath();
  fs.writeFileSync(p, JSON.stringify(mappings, null, 2), 'utf8');
}

function normalize(mapping: Mapping): Mapping {
  const m = { ...mapping };
  m.fieldCount = m.fields?.length || 0;
  m.status = m.status || 'active';
  m.lastUpdated = new Date().toISOString();
  m.completeness = m.fieldCount ? 100 : 0;
  // initialize metadata defaults with proper typing
  m.version = mapping.version || 1;
  m.publish = mapping.publish || false;
  return m;
}

function validateNoDuplicates(fields: Field[]) {
  const seen = new Set<string>();
  for (const f of fields) {
    const key = `${f.source}|${f.target}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * Every field must adapt to the canonical contract, and the adapted SET must
 * validate as a set (Codex round 5 on PR #1253: two spellings of one lodash
 * target slot passed field-by-field and were stored). Issues are collected,
 * not thrown.
 */
function validateThroughContract(fields: Field[]): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const adapted = [];
  for (const f of fields) {
    try {
      adapted.push(fromRouteMapping({ source: f.source, target: f.target, transformation: f.transformation, params: f.params }));
    } catch (err) {
      if (err instanceof MappingContractError) issues.push(...err.issues);
      else throw err;
    }
  }
  if (issues.length === 0) issues.push(...validateMappingSet(adapted).issues);
  return { ok: issues.length === 0, issues };
}

export function createMappingsRouter(): Router {
  const router = Router();
  const logger = container.get<Logger>(TYPES.Logger);

  // Codex on PR #1253: the mount gate in RouteSetup is evaluated once at
  // startup, but demo mode can be switched off at runtime
  // (adminSettings -> DemoModeService.setDemoMode). Decide per request too,
  // so a router mounted under demo goes dark the moment demo mode ends.
  router.use((_req, res, next) => {
    if (!isDemo()) {
      res.status(404).json({ error: 'Not Found' });
      return;
    }
    next();
  });

  // List all mappings
  router.get('/', asyncHandler(async (_req, res) => {
    const all = readAll();
    res.json(all.map(normalize));
  }));

  // Export all
  router.get('/export', asyncHandler(async (_req, res) => {
    const all = readAll();
    res.json({ mappings: all });
  }));

  // Get by id
  router.get('/:id', asyncHandler(async (req, res) => {
    const all = readAll();
    const found = all.find(m => m.id === req.params.id);
    if (!found) {
      res.status(404).json({ error: 'Not Found' });
      return;
    }
    res.json(normalize(found));
  }));

  // Create
  router.post('/', asyncHandler(async (req, res) => {
    const parsed = MappingSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_FAILED', details: parsed.error.flatten() });
      return;
    }
    const body = parsed.data as any;
    if (!validateNoDuplicates(body.fields)) {
      res.status(400).json({ error: 'DUPLICATE_FIELDS', message: 'Duplicate source-target field pairs found' });
      return;
    }
    const contract = validateThroughContract(body.fields as Field[]);
    if (!contract.ok) {
      res.status(400).json({ error: 'mapping_contract', allowed: ALLOWED_TRANSFORMATIONS, issues: contract.issues });
      return;
    }
    const id = uuidv4();
    const now = new Date().toISOString();
    const toSave: Mapping = normalize({ ...body, id, version: 1, createdAt: now, updatedAt: now, createdBy: body.createdBy || 'demo-user', published: !!body.publish, publishedAt: body.publish ? now : undefined } as Mapping);
    const all = readAll();
    all.unshift(toSave);
    writeAll(all);
    logger.info('Mapping created', { id, name: toSave.name });
    res.status(201).json(toSave);
  }));

  // Bulk import
  router.post('/import', asyncHandler(async (req, res) => {
  const payloadCandidate = Array.isArray(req.body)
    ? req.body
    : (Array.isArray(req.body?.mappings) ? req.body.mappings : null);

  if (!Array.isArray(payloadCandidate)) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }
  const payload = payloadCandidate;
    const all = readAll();
    // Codex round 13 on PR #1253: an imported id that already exists (in the
    // store or earlier in the payload) is rejected, never a second entry.
    const ids = new Set(all.map((m) => m.id));
    let imported = 0;
    let rejected = 0;
    for (const raw of payload) {
      // Codex on PR #1253: every skipped entry counts as rejected, whatever the reason.
      const parsed = MappingSchema.safeParse(raw);
      if (!parsed.success) { rejected++; continue; }
      const body = parsed.data;
      if (!validateNoDuplicates(body.fields)) { rejected++; continue; }
      if (!validateThroughContract(body.fields as Field[]).ok) { rejected++; continue; }
      // Codex round 12 on PR #1253: a blank client id was persisted verbatim,
      // reported imported, and the very next read declared the store corrupt.
      const id = (raw && typeof raw.id === 'string' && raw.id.trim()) ? raw.id : uuidv4();
      if (ids.has(id)) { rejected++; continue; }
      ids.add(id);
      const now = new Date().toISOString();
      const toSave: Mapping = normalize({ ...body, id, version: 1, createdAt: now, updatedAt: now, createdBy: body.createdBy || 'demo-user', published: !!body.publish, publishedAt: body.publish ? now : undefined } as Mapping);
      all.unshift(toSave);
      imported++;
      logger.info('Mapping imported', { id, name: toSave.name });
    }
    writeAll(all);
    res.json({ imported, rejected, total: all.length });
  }));

  // Export all
  router.get('/export', asyncHandler(async (_req, res) => {
    const all = readAll();
    res.json({ mappings: all });
  }));

  // Update
  router.put('/:id', asyncHandler(async (req, res) => {
    const parsed = MappingSchema.partial({ id: true }).safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_FAILED', details: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;
    const all = readAll();
    const index = all.findIndex(m => m.id === req.params.id);
    if (index === -1) {
      res.status(404).json({ error: 'Not Found' });
      return;
    }
    if (body.fields && !validateNoDuplicates(body.fields)) {
      res.status(400).json({ error: 'DUPLICATE_FIELDS' });
      return;
    }
    if (body.fields) {
      const contract = validateThroughContract(body.fields);
      if (!contract.ok) {
        res.status(400).json({ error: 'mapping_contract', allowed: ALLOWED_TRANSFORMATIONS, issues: contract.issues });
        return;
      }
    }
    const existing = all[index];
    if (!existing) {
      res.status(404).json({ error: 'Not Found' });
      return;
    }
    const bump = body.publish === true;
    const updatedVersion = bump ? ((existing.version || 1) + 1) : (existing.version || 1);
    const now = new Date().toISOString();
    const updated = normalize({
      ...existing,
      ...body,
      id: existing.id,
      version: updatedVersion,
      updatedAt: now,
      published: body.publish !== undefined ? !!body.publish : existing.published,
      publishedAt: body.publish ? now : existing.publishedAt
    });
    all[index] = updated;
    writeAll(all);
    logger.info('Mapping updated', { id: updated.id, name: updated.name });
    res.json(updated);
  }));

  // Delete
  router.delete('/:id', asyncHandler(async (req, res) => {
    const all = readAll();
    const next = all.filter(m => m.id !== req.params.id);
    if (next.length === all.length) {
      res.status(404).json({ error: 'Not Found' });
      return;
    }
    writeAll(next);
    logger.info('Mapping deleted', { id: req.params.id });
    res.json({ success: true });
  }));

  // Export single mapping
  router.get('/:id/export', asyncHandler(async (req, res) => {
    const all = readAll();
    const found = all.find(m => m.id === req.params.id);
    if (!found) {
      res.status(404).json({ error: 'Not Found' });
      return;
    }
    res.type('application/json').send(JSON.stringify(found, null, 2));
  }));

  // Diff two mappings
  router.post('/diff', asyncHandler(async (req, res) => {
    const { aId, bId, id1, id2 } = req.body || {};
    const leftId = aId || id1;
    const rightId = bId || id2;

    if (!leftId || !rightId) {
      res.status(400).json({ error: 'MISSING_IDS' });
      return;
    }
    const all = readAll();
    const a = all.find(m => m.id === leftId);
    const b = all.find(m => m.id === rightId);
    if (!a || !b) {
      res.status(404).json({ error: 'NOT_FOUND', missing: { a: !a, b: !b } });
      return;
    }

    const topLevelChanges: Record<string, { a: unknown; b: unknown }> = {};
    for (const k of ['name', 'sourceSystem', 'targetSystem']) {
      if ((a as any)[k] !== (b as any)[k]) topLevelChanges[k] = { a: (a as any)[k], b: (b as any)[k] };
    }
    const key = (f: Field) => `${f.source}|${f.target}`.toLowerCase();
    const aMap = new Map(a.fields.map(f => [key(f as Field), f]));
    const bMap = new Map(b.fields.map(f => [key(f as Field), f]));
    const added: Field[] = [];
    const removed: Field[] = [];
    const changed: { key: string; a: Field; b: Field }[] = [];
    for (const [k, f] of bMap) { if (!aMap.has(k)) added.push(f as Field); }
    for (const [k, f] of aMap) { if (!bMap.has(k)) removed.push(f as Field); }
    for (const [k, fa] of aMap) {
      const fb = bMap.get(k) as Field | undefined;
      if (fb && fa.transformation !== fb.transformation) changed.push({ key: k, a: fa as Field, b: fb });
    }
    res.json({ aId, bId, topLevelChanges, added, removed, changed });
  }));

  // Task A3: a corrupt store is a 500 with a stable code, never an empty list.
  router.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof MappingStoreCorruptError) {
      // Copilot on PR #1253: the message carries the absolute store path and the
      // cause; both belong in the log, neither in the response body.
      logger.error('Mapping store corrupt', { storePath: err.storePath, error: err, cause: err.cause });
      res.status(500).json({ error: 'mapping_store_corrupt' });
      return;
    }
    next(err);
  });

  return router;
}
