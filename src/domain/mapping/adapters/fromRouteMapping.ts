/**
 * Boundary adapter: the `/api/mappings` flat-file shape → the canonical contract
 * (tranche 2, Workstream A, Task A3).
 *
 * The route stores `{ source, target, transformation, params }` and, before this
 * task, accepted ten transformation words of which the engine executes three.
 * Every accepted word now maps to an executable `transformationType` and the
 * result is validated through `FieldMappingSchema`, so a mapping the route
 * stores is one the engine can run. Anything else is a `MappingContractError`.
 *
 * This adapter is the ONLY place the route shape is interpreted; the store is
 * demo-only (global flat file, no tenant column) and is not a Blueprint source.
 */
import { FieldMappingSchema, MappingContractError, type FieldMapping } from '../MappingContract';

export interface RouteMappingField {
  source: string;
  target: string;
  transformation: string;
  params?: Record<string, unknown>;
}

/** The route vocabulary this adapter accepts — each word names an executable type. */
export const ROUTE_TRANSFORMATIONS = ['direct', 'lookup', 'calculation', 'concatenation'] as const;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function fromRouteMapping(field: RouteMappingField): FieldMapping {
  const p = field.params ?? {};
  let candidate: unknown;
  switch (field.transformation) {
    case 'direct':
      candidate = { sourceField: field.source, targetField: field.target, transformationType: 'direct', isRequired: false };
      break;
    case 'lookup':
      candidate = {
        sourceField: field.source,
        targetField: field.target,
        transformationType: 'lookup',
        isRequired: false,
        transformationConfig: {
          type: 'lookup',
          ...(str(p.table) !== undefined ? { lookupTable: str(p.table) } : {}),
          ...(p.map !== undefined && typeof p.map === 'object' && p.map !== null && !Array.isArray(p.map) ? { mappings: p.map as Record<string, unknown> } : {}),
        },
      };
      break;
    case 'calculation':
      candidate = {
        sourceField: field.source,
        targetField: field.target,
        transformationType: 'calculation',
        isRequired: false,
        transformationConfig: { type: 'calculation', ...(str(p.expr) !== undefined ? { expression: str(p.expr) } : {}) },
      };
      break;
    case 'concatenation':
      candidate = {
        sourceField: field.source,
        targetField: field.target,
        transformationType: 'concatenation',
        isRequired: false,
        transformationConfig: {
          type: 'concatenation',
          ...(Array.isArray(p.fields) ? { fields: p.fields } : {}),
          ...(str(p.separator) !== undefined ? { separator: str(p.separator) } : {}),
        },
      };
      break;
    default:
      throw new MappingContractError([
        `${field.source} -> ${field.target}: transformation '${field.transformation}' is not executable (allowed: ${ROUTE_TRANSFORMATIONS.join(', ')})`,
      ]);
  }
  const parsed = FieldMappingSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new MappingContractError(
      parsed.error.issues.map((i) => `${field.source} -> ${field.target}: ${i.path.join('.') || 'mapping'}: ${i.message}`),
    );
  }
  return parsed.data;
}
