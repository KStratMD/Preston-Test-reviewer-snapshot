import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { uuidv4 } from '../utils/uuid';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';

const ALLOWED_TRANSFORMATIONS = [
  'direct',
  'format',
  'lookup',
  'calculation',
  'concatenation',
  'conditional',
  'uppercase',
  'lowercase',
  'trim',
  'replace',
] as const;

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
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data as Mapping[];
    return [];
  } catch {
    return [];
  }
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

function validateTransformations(fields: Field[]) {
  for (const f of fields) {
    if (!ALLOWED_TRANSFORMATIONS.includes(f.transformation as any)) return false;
  }
  return true;
}

function validateParams(fields: Field[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const f of fields) {
    const t = f.transformation as typeof ALLOWED_TRANSFORMATIONS[number];
    const p = (f as any).params || {};
    switch (t) {
      case 'format':
        if (!('format' in p) || String(p.format).length === 0) errors.push(`format: missing 'format' for ${f.source}->${f.target}`);
        break;
      case 'replace':
        if (!('pattern' in p)) errors.push(`replace: missing 'pattern' for ${f.source}->${f.target}`);
        if (!('with' in p)) errors.push(`replace: missing 'with' for ${f.source}->${f.target}`);
        break;
      case 'concatenation':
        if (!('template' in p) || String(p.template).length === 0) errors.push(`concatenation: missing 'template' for ${f.source}->${f.target}`);
        break;
      case 'lookup':
        if (!('map' in p)) errors.push(`lookup: missing 'map' for ${f.source}->${f.target}`);
        break;
      case 'calculation':
        if (!('expr' in p) || String(p.expr).length === 0) errors.push(`calculation: missing 'expr' for ${f.source}->${f.target}`);
        break;
      case 'conditional':
        if (!('expression' in p) || String(p.expression).length === 0) errors.push(`conditional: missing 'expression' for ${f.source}->${f.target}`);
        break;
      default:
        break;
    }
  }
  return { ok: errors.length === 0, errors };
}

export function createMappingsRouter(): Router {
  const router = Router();
  const logger = container.get<Logger>(TYPES.Logger);

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
    if (!validateTransformations(body.fields as Field[])) {
      res.status(400).json({ error: 'INVALID_TRANSFORMATION', allowed: ALLOWED_TRANSFORMATIONS });
      return;
    }
    const pv = validateParams(body.fields as Field[]);
    if (!pv.ok) {
      res.status(400).json({ error: 'INVALID_PARAMS', details: pv.errors });
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
    let imported = 0;
    for (const raw of payload) {
      const parsed = MappingSchema.safeParse(raw);
      if (!parsed.success) continue;
      const body = parsed.data;
      if (!validateNoDuplicates(body.fields)) continue;
      const id = (raw && typeof raw.id === 'string') ? raw.id : uuidv4();
      const now = new Date().toISOString();
      const toSave: Mapping = normalize({ ...body, id, version: 1, createdAt: now, updatedAt: now, createdBy: body.createdBy || 'demo-user', published: !!body.publish, publishedAt: body.publish ? now : undefined } as Mapping);
      all.unshift(toSave);
      imported++;
      logger.info('Mapping imported', { id, name: toSave.name });
    }
    writeAll(all);
    res.json({ imported, total: all.length });
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
    if (body.fields && !validateTransformations(body.fields)) {
      res.status(400).json({ error: 'INVALID_TRANSFORMATION', allowed: ALLOWED_TRANSFORMATIONS });
      return;
    }
    if (body.fields) {
      const pv = validateParams(body.fields);
      if (!pv.ok) {
        res.status(400).json({ error: 'INVALID_PARAMS', details: pv.errors });
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

  return router;
}
