import { createHash } from 'node:crypto';
import isEqual from 'lodash/isEqual';
import { BlueprintSpecSchema, type BlueprintSpec } from './schema/blueprintSpec';
import { validateMappingSet } from '../domain/mapping/MappingContract';
import { TransformationEngine } from '../services/TransformationEngine';
import type { Logger } from '../utils/Logger';
import { ApproverRegistrySchema, type ApproverRegistry, type Attestation } from './approvals';
import { isVerified } from './githubReviews';

const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable((v as Record<string, unknown>)[k])])) : v;
export function contentHash(spec: BlueprintSpec): string {
  return createHash('sha256').update(JSON.stringify(stable(spec))).digest('hex');
}
// The engine uses these four logger methods only; local validation must be silent.
const noopLogger = { info() {}, error() {}, warn() {}, debug() {} } as unknown as Logger;
export interface BlueprintValidation {
  ok: boolean; issues: string[]; executable: boolean; reasons: string[]; hash?: string;
}
export async function validateBlueprint(input: unknown, opts: {
  attestations?: unknown; registry?: ApproverRegistry; engine?: TransformationEngine; logger?: Logger;
} = {}): Promise<BlueprintValidation> {
  const parsed = BlueprintSpecSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`), executable: false, reasons: ['schema invalid'] };
  const spec = parsed.data; const issues: string[] = [];
  const systemIds = new Set(spec.systems.map(s => s.id));
  const objectIds = new Set(spec.objects.map(o => o.id));
  const owned = new Set(spec.ownership.map(o => o.entity));
  for (const o of spec.objects) if (!systemIds.has(o.system)) issues.push(`object ${o.id} references unknown system ${o.system}`);
  for (const p of spec.integrationPaths) for (const s of [p.from, p.to]) if (!systemIds.has(s)) issues.push(`path ${p.id} references unknown system ${s}`);
  spec.ownership.forEach((o, i) => {
    for (const id of [o.owner, ...o.consumers, ...o.fieldOverrides.map(f => f.owner)]) {
      if (!systemIds.has(id)) issues.push(`ownership[${i}]: unknown system ${id}`);
    }
  });
  spec.adapterRequirements.forEach((a, i) => { if (!systemIds.has(a.system)) issues.push(`adapterRequirements[${i}]: unknown system ${a.system}`); });
  for (const m of spec.mappings) {
    for (const o of [m.sourceObject, m.targetObject]) if (!objectIds.has(o)) issues.push(`mapping ${m.id} references unknown object ${o}`);
    if (!owned.has(m.targetObject)) issues.push(`mapping ${m.id}: no ownership rule for target object ${m.targetObject}`);
    issues.push(...validateMappingSet(m.fieldMappings).issues.map(i => `mapping ${m.id}: ${i}`));
  }
  if (issues.length) return { ok: false, issues, executable: false, reasons: ['structural or contract issues'] };
  const hash = contentHash(spec); const reasons: string[] = [];
  if (spec.metadata.evidenceLevel === 'discovery') reasons.push('evidence level is discovery');
  for (const s of spec.systems) if (s.evidenceLevel < 2) reasons.push(`system ${s.id} evidence rung ${s.evidenceLevel} is below 2`);
  if (spec.blockers.length) reasons.push(`${spec.blockers.length} unresolved blocker(s)`);
  const registry = opts.registry ? ApproverRegistrySchema.parse(opts.registry) : { approvers: [] };
  const distinct = new Map<string, Attestation>();
  if (!isVerified(opts.attestations)) reasons.push('attestations not verified against GitHub');
  else for (const a of opts.attestations.items) {
    const entry = registry.approvers.find(p => p.id === a.approver && p.active);
    if (a.hash !== hash || !entry || !entry.roles.includes(a.role) || !spec.approvals.roles.includes(a.role)) continue;
    distinct.set(a.approver, a);
  }
  if (distinct.size < spec.approvals.requiredApprovers) reasons.push(`requires ${spec.approvals.requiredApprovers} distinct verified attestation(s), found ${distinct.size}`);
  const engine = opts.engine ?? new TransformationEngine(opts.logger ?? noopLogger);
  for (const m of spec.mappings) for (const g of m.goldenCases) {
    try {
      const out = await engine.transformRecord(g.input, m.fieldMappings, []);
      if ('error' in g.expected) reasons.push(`golden case ${m.id}/${g.name}: expected error ${g.expected.error} but transformation succeeded`);
      else if (!isEqual(out, g.expected.fields)) reasons.push(`golden case ${m.id}/${g.name}: output mismatch ${JSON.stringify(out)} != ${JSON.stringify(g.expected.fields)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!('error' in g.expected) || !msg.includes(g.expected.error)) reasons.push(`golden case ${m.id}/${g.name}: unexpected failure ${msg}`);
    }
  }
  return { ok: true, issues: [], executable: reasons.length === 0, reasons, hash };
}
