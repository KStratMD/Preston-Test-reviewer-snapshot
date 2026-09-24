import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const ProvenanceSchema = z.object({
  vendor: z.string().min(1),
  entity: z.string().min(1),
  sourceUrl: z.string().url().refine(url => !/\/latest\//.test(url),
    'sourceUrl must be version-pinned (no /latest/ segment)'),
  docVersion: z.string().min(1),
  capturedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rung: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  notes: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;
const DEFAULT_ROOT = path.resolve(__dirname, '..', 'fixtures', 'contracts');

export function loadContractFixture<T = unknown>(
  vendor: string, entity: string, name: string, opts: { root?: string } = {},
): { data: T; provenance: Provenance } {
  const dir = path.join(opts.root ?? DEFAULT_ROOT, vendor, entity);
  const provPath = path.join(dir, '_provenance.json');
  if (!fs.existsSync(provPath)) throw new Error(`missing ${provPath} (_provenance.json is required per entity directory)`);
  const provenance = ProvenanceSchema.parse(JSON.parse(fs.readFileSync(provPath, 'utf8')));
  if (provenance.vendor !== vendor || provenance.entity !== entity) {
    throw new Error(`provenance mismatch: ${dir} claims ${provenance.vendor}/${provenance.entity}`);
  }
  if (provenance.rung < 3 && /cassette|replay/i.test(name)) {
    throw new Error(`${name} is named like a recording but provenance is rung ${provenance.rung}; only rung 3 may be called a cassette or replay`);
  }
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`missing fixture ${file}`);
  return { data: JSON.parse(fs.readFileSync(file, 'utf8')) as T, provenance };
}
