// src/blueprint/export/exportBlueprint.ts
import type { BlueprintSpec } from '../schema/blueprintSpec';
import type { validateBlueprint } from '../validate';
import type { Attestation } from '../approvals';
import { BlueprintExportSchema, type BlueprintVerification, type BlueprintSource } from './exportSchema';

type Validation = Awaited<ReturnType<typeof validateBlueprint>>;
const text = (value: string): string => value.replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? character)
  .replace(/[\\`*\[\]_|#]/g, character => `&#${character.charCodeAt(0)};`).replace(/\r\n|\r|\n/g, '<br>');
const mermaid = (value: string): string => {
  const fence = '`'.repeat(Math.max(3, ...[...value.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}mermaid\n${value}\n${fence}`;
};
const table = (headers: string[], rows: string[][]) =>
  [`| ${headers.map(text).join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(text).join(' | ')} |`)].join('\n');

export function exportBlueprint(spec: BlueprintSpec, v: Validation, attestations: readonly Attestation[], verification: BlueprintVerification, source: BlueprintSource | null, opts: { exportedAt?: string } = {}): Record<'blueprint.export.json' | 'proposal.md' | 'backlog.md' | 'control-matrix.md' | 'test-plan.md', string> {
  const proposal = [
    `# ${text(spec.metadata.name)}`, '',
    `Version ${text(spec.metadata.version)} · schema ${spec.schemaVersion} · evidence ${spec.metadata.evidenceLevel}`, '',
    `## Executable: ${v.executable ? 'yes' : 'no'}`, ...(v.executable ? [] : v.reasons.map(r => `- ${text(r)}`)), '',
    '## Goals', ...spec.goals.map(g => `- ${text(g.statement)} (criteria: ${g.successCriteria.map(text).join('; ')})`), '',
    '## Systems and integration paths',
    table(['System', 'Role', 'Vendor', 'API version', 'Auth', 'Evidence rung'], spec.systems.map(s => [s.id, s.role, s.vendor, s.apiVersion ?? '—', s.authModel, String(s.evidenceLevel)])), '',
    table(['Path', 'From', 'To', 'Owner', 'Squire role'], spec.integrationPaths.map(p => [p.id, p.from, p.to, p.owner, p.squireRole])), '',
    '## Ownership', table(['Entity', 'Owner', 'Consumers', 'Conflict policy'], spec.ownership.map(o => [o.entity, o.owner, o.consumers.join(', '), o.conflictPolicy])), '',
    '## Approval and separation-of-duty requirements',
    `Required distinct approvers: ${spec.approvals.requiredApprovers}. Roles: ${spec.approvals.roles.map(text).join(', ')}. Separation of duties: ${spec.approvals.separationOfDuties}.`, '',
    'A governed write requested by a host-asserted principal is blocked at runtime until a Squire-verified requester re-submits it; executability of this document does not admit such a request.', '',
    '## Exceptions in scope', table(['Type', 'Severity', 'Disposition', 'Description'], spec.exceptions.map(x => [x.type, x.severity, x.disposition, x.description])), '',
    '## Architecture', text(spec.architecture.summary), '', mermaid(spec.architecture.diagramMermaid), '',
    '## Phases and gates', ...spec.proposalInputs.phases.map(p => `- ${text(p)}`), '',
    '## Exclusions', ...spec.exclusions.map(e => `- ${text(e)}`), '',
    '## Open questions', ...spec.openQuestions.map(q => `- ${text(q)}`), '',
    '## Risks', table(['Risk', 'Severity', 'Mitigation'], spec.risks.map(r => [r.statement, r.severity, r.mitigation])), '',
    '## Measurable outcomes', table(['Unit', 'Verification', 'Attribution rule'], spec.outcomes.map(o => [o.unit, o.verification, o.attributionRule])), '',
    `## Pricing`, text(spec.proposalInputs.pricingPlaceholder), '',
  ].join('\n');
  const backlog = ['# Implementation backlog', '', table(['Id', 'Phase', 'Title', 'Estimate (days)'], spec.backlog.map(b => [b.id, b.phase, b.title, String(b.estimateDays)]))].join('\n');
  const controls = ['# Control matrix', '', table(['Control', 'Setting'], [
    ['Separation of duties', String(spec.approvals.separationOfDuties)], ['Required approvers', String(spec.approvals.requiredApprovers)],
    ['Approver roles', spec.approvals.roles.join(', ')], ['DLP posture', spec.dlp.posture], ['Allow PII', String(spec.dlp.allowPII)],
    ['Sensitive fields', spec.dlp.sensitiveFields.join(', ')],
  ])].join('\n');
  const testPlan = ['# Test and evidence plan', '', '## Fixture sets', ...spec.testPlan.fixtureSets.map(f => `- ${text(f)}`), '', '## Golden records', ...spec.testPlan.goldenRecords.map(g => `- ${text(g)}`), '', '## Acceptance', ...spec.testPlan.acceptance.map(a => `- ${text(a)}`), '', `Amount tolerance (minor units): ${spec.testPlan.tolerances.amountMinorUnits}`].join('\n');
  const json = JSON.stringify(BlueprintExportSchema.parse({ exportSchemaVersion: 1, exportedAt: opts.exportedAt ?? new Date().toISOString(), spec, validation: { hash: v.hash ?? '', executable: v.executable, reasons: v.reasons, issues: v.issues }, attestations, verification, source }), null, 2);
  return { 'blueprint.export.json': json, 'proposal.md': proposal, 'backlog.md': backlog, 'control-matrix.md': controls, 'test-plan.md': testPlan };
}
