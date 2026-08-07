import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { z } from 'zod';
import * as path from 'path';
import { uuidv4 } from '../utils/uuid';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import {
  ensureDirectoryExists,
  fileExists,
  readJsonFile,
  writeJsonFile,
  safePath,
  createBackup,
  safeWriteFile
} from '../utils/asyncFileOperations';

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
};

async function getStorePath(): Promise<string> {
  const dir = path.resolve(process.cwd(), 'config');
  await ensureDirectoryExists(dir);
  return path.join(dir, 'mappings.json');
}

async function readAll(): Promise<Mapping[]> {
  const p = await getStorePath();
  const data = await readJsonFile<Mapping[]>(p);
  return Array.isArray(data) ? data : [];
}

async function writeAll(mappings: Mapping[]): Promise<void> {
  const p = await getStorePath();
  
  // Create backup if file exists
  if (await fileExists(p)) {
    await createBackup(p);
  }
  
  await writeJsonFile(p, mappings);
}

function normalize(mapping: Mapping): Mapping {
  const m = { ...mapping };
  m.fieldCount = m.fields?.length || 0;
  m.status = m.status || 'active';
  m.lastUpdated = new Date().toISOString();
  m.completeness = m.fieldCount ? 100 : 0;
  // initialize metadata defaults
  m.version = m.version || 1;
  m.published = m.published || false;
  return m;
}

function validateNoDuplicates(fields: Field[]) {
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const f of fields) {
    if (sources.has(f.source)) {
      throw new Error(`Duplicate source field: ${f.source}`);
    }
    if (targets.has(f.target)) {
      throw new Error(`Duplicate target field: ${f.target}`);
    }
    sources.add(f.source);
    targets.add(f.target);
  }
}

function validateTransformations(fields: Field[]) {
  for (const f of fields) {
    if (!ALLOWED_TRANSFORMATIONS.includes(f.transformation as any)) {
      throw new Error(`Invalid transformation: ${f.transformation}. Allowed: ${ALLOWED_TRANSFORMATIONS.join(', ')}`);
    }
  }
}

export function createMappingsAsyncRouter(): Router {
  const router = Router();
  const logger = container.get<Logger>(TYPES.Logger);

  // GET /mappings - list all mappings
  router.get('/mappings', asyncHandler(async (req, res) => {
    logger.info('Fetching all mappings');
    
    const mappings = await readAll();
    const withStats = mappings.map(m => normalize(m));
    
    res.json({
      success: true,
      data: withStats,
      count: withStats.length,
    });
  }));

  // GET /mappings/:id - get specific mapping
  router.get('/mappings/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    logger.info(`Fetching mapping: ${id}`);
    
    const mappings = await readAll();
    const mapping = mappings.find(m => m.id === id);
    
    if (!mapping) {
      return res.status(404).json({
        success: false,
        error: 'Mapping not found',
      });
    }
    
    return res.json({
      success: true,
      data: normalize(mapping),
    });
  }));

  // POST /mappings - create new mapping
  router.post('/mappings', asyncHandler(async (req, res) => {
    logger.info('Creating new mapping');
    
    const parsed = MappingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.issues,
      });
    }
    
    const mappingData = parsed.data;
    
    // Validate fields
    try {
      validateNoDuplicates(mappingData.fields);
      validateTransformations(mappingData.fields);
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: (err as Error).message,
      });
    }
    
    const mappings = await readAll();
    
    // Check for name conflicts
    if (mappings.some(m => m.name === mappingData.name)) {
      return res.status(400).json({
        success: false,
        error: 'A mapping with this name already exists',
      });
    }
    
    const newMapping: Mapping = {
      ...mappingData,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    mappings.push(normalize(newMapping));
    await writeAll(mappings);
    
    logger.info(`Created mapping: ${newMapping.id} (${newMapping.name})`);
    
    return res.status(201).json({
      success: true,
      data: normalize(newMapping),
      message: 'Mapping created successfully',
    });
  }));

  // PUT /mappings/:id - update existing mapping
  router.put('/mappings/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    logger.info(`Updating mapping: ${id}`);
    
    const parsed = MappingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.issues,
      });
    }
    
    const mappingData = parsed.data;
    
    // Validate fields
    try {
      validateNoDuplicates(mappingData.fields);
      validateTransformations(mappingData.fields);
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: (err as Error).message,
      });
    }
    
    const mappings = await readAll();
    const index = mappings.findIndex(m => m.id === id);
    
    if (index === -1) {
      return res.status(404).json({
        success: false,
        error: 'Mapping not found',
      });
    }
    
    // Check for name conflicts (excluding current mapping)
    if (mappings.some(m => m.id !== id && m.name === mappingData.name)) {
      return res.status(400).json({
        success: false,
        error: 'A mapping with this name already exists',
      });
    }
    
    const existingMapping = mappings[index];
    if (!existingMapping) {
      return res.status(404).json({
        success: false,
        error: 'Mapping not found',
      });
    }
    const updatedMapping: Mapping = {
      ...existingMapping,
      ...mappingData,
      id: id!, // Keep original ID
      updatedAt: new Date().toISOString(),
      version: (existingMapping.version || 1) + 1,
    };
    
    mappings[index] = normalize(updatedMapping);
    await writeAll(mappings);
    
    logger.info(`Updated mapping: ${id} (${updatedMapping.name})`);
    
    return res.json({
      success: true,
      data: normalize(updatedMapping),
      message: 'Mapping updated successfully',
    });
  }));

  // DELETE /mappings/:id - delete mapping
  router.delete('/mappings/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    logger.info(`Deleting mapping: ${id}`);
    
    const mappings = await readAll();
    const index = mappings.findIndex(m => m.id === id);
    
    if (index === -1) {
      return res.status(404).json({
        success: false,
        error: 'Mapping not found',
      });
    }
    
    const deletedMapping = mappings[index];
    if (!deletedMapping) {
      return res.status(404).json({
        success: false,
        error: 'Mapping not found',
      });
    }
    mappings.splice(index, 1);
    await writeAll(mappings);
    
    logger.info(`Deleted mapping: ${id} (${deletedMapping.name})`);
    
    return res.json({
      success: true,
      message: 'Mapping deleted successfully',
      data: { id, name: deletedMapping.name },
    });
  }));

  // POST /mappings/:id/duplicate - duplicate mapping
  router.post('/mappings/:id/duplicate', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { newName } = req.body;
    
    logger.info(`Duplicating mapping: ${id}`);
    
    if (!newName || typeof newName !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'New name is required',
      });
    }
    
    const mappings = await readAll();
    const original = mappings.find(m => m.id === id);
    
    if (!original) {
      return res.status(404).json({
        success: false,
        error: 'Mapping not found',
      });
    }
    
    // Check for name conflicts
    if (mappings.some(m => m.name === newName)) {
      return res.status(400).json({
        success: false,
        error: 'A mapping with this name already exists',
      });
    }
    
    const duplicatedMapping: Mapping = {
      ...original,
      id: uuidv4(),
      name: newName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      published: false,
    };
    
    mappings.push(normalize(duplicatedMapping));
    await writeAll(mappings);
    
    logger.info(`Duplicated mapping: ${id} -> ${duplicatedMapping.id} (${newName})`);
    
    return res.status(201).json({
      success: true,
      data: normalize(duplicatedMapping),
      message: 'Mapping duplicated successfully',
    });
  }));

  // POST /mappings/:id/publish - publish mapping
  router.post('/mappings/:id/publish', asyncHandler(async (req, res) => {
    const { id } = req.params;
    logger.info(`Publishing mapping: ${id}`);
    
    const mappings = await readAll();
    const index = mappings.findIndex(m => m.id === id);
    
    if (index === -1) {
      return res.status(404).json({
        success: false,
        error: 'Mapping not found',
      });
    }
    
    const mapping = mappings[index];
    if (!mapping) {
      return res.status(404).json({
        success: false,
        error: 'Mapping not found',
      });
    }
    mapping.published = true;
    mapping.publishedAt = new Date().toISOString();
    mapping.updatedAt = new Date().toISOString();
    
    mappings[index] = normalize(mapping);
    await writeAll(mappings);
    
    logger.info(`Published mapping: ${id} (${mapping.name})`);
    
    return res.json({
      success: true,
      data: normalize(mapping),
      message: 'Mapping published successfully',
    });
  }));

  // POST /mappings/validate - validate mapping without saving
  router.post('/mappings/validate', asyncHandler(async (req, res) => {
    logger.info('Validating mapping');
    
    const parsed = MappingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.json({
        success: false,
        valid: false,
        errors: parsed.error.issues,
      });
    }
    
    const mappingData = parsed.data;
    const errors: string[] = [];
    
    try {
      validateNoDuplicates(mappingData.fields);
    } catch (err) {
      errors.push((err as Error).message);
    }
    
    try {
      validateTransformations(mappingData.fields);
    } catch (err) {
      errors.push((err as Error).message);
    }
    
    // Check for name conflicts if creating new
    if (!mappingData.id) {
      const mappings = await readAll();
      if (mappings.some(m => m.name === mappingData.name)) {
        errors.push('A mapping with this name already exists');
      }
    }
    
    return res.json({
      success: true,
      valid: errors.length === 0,
      errors,
      warnings: [], // Could add warnings for best practices
    });
  }));

  return router;
}