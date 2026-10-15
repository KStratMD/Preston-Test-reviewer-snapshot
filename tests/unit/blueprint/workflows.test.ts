import fs from 'node:fs';
import yaml from 'js-yaml';
// A source-level tripwire, not data-flow proof: even aliases and multi-statement consumers
// must not access the stored envelope schema outside its two producer modules.
const storedEnvelopeParser = (source: string): boolean => /\bBlueprintExportSchema\b/.test(source);
it.each([
  'BlueprintExportSchema.parse(JSON.parse(fs.readFileSync(path)))',
  'const j = JSON.parse(readFileSync(path)); BlueprintExportSchema.parse(j)',
  'import { BlueprintExportSchema as Stored } from "./export/exportSchema"; Stored.safeParse(data)',
])('observes the stored-envelope tripwire firing on %s', source => {
  expect(storedEnvelopeParser(source)).toBe(true);
});
it('pins verifier code to base and checks out the PR only as data', () => {
  const workflow = yaml.load(fs.readFileSync('.github/workflows/blueprint-verify.yml', 'utf8')) as Record<string, unknown>;
  expect(workflow.on).toEqual({ pull_request_target: { types: ['opened', 'synchronize', 'reopened', 'ready_for_review'] }, workflow_dispatch: { inputs: { pull: { description: 'Pull request number', required: true, type: 'number' } } } });
  const jobs = workflow.jobs as Record<string, { permissions: object; steps: { uses?: string; if?: string; with?: Record<string, unknown>; run?: string; env?: object }[] }>;
  expect(jobs.resolve.permissions).toEqual({ 'pull-requests': 'read' });
  expect(jobs.verify.permissions).toEqual({ contents: 'read', 'pull-requests': 'read', statuses: 'write' });
  const checkouts = jobs.verify.steps.filter(s => s.uses?.startsWith('actions/checkout@'));
  expect(checkouts[0].with?.ref).toBe('${{ needs.resolve.outputs.base_sha }}');
  expect(checkouts[1].with).toMatchObject({ ref: '${{ needs.resolve.outputs.head_sha }}', path: 'pr', 'persist-credentials': false });
  expect(checkouts[1].if).toBe('${{ needs.resolve.outputs.head_repo == github.repository }}');
  expect(checkouts.some(s => s.with?.['allow-unsafe-pr-checkout'])).toBe(false);
  expect(jobs.verify.steps.some(s => /cd pr|npm.*--prefix pr/.test(s.run ?? ''))).toBe(false);
});
it('dispatches review events without checking out or executing PR code', () => {
  const workflow = yaml.load(fs.readFileSync('.github/workflows/blueprint-verify-dispatch.yml', 'utf8')) as { on: object; jobs: Record<string, { permissions: object; steps: { run: string; env: object }[] }> };
  expect(workflow.on).toEqual({ pull_request_review: { types: ['submitted', 'dismissed'] } });
  expect(workflow.jobs.dispatch.permissions).toEqual({ actions: 'write' });
  expect(workflow.jobs.dispatch.steps).toHaveLength(1);
  expect(workflow.jobs.dispatch.steps[0].run).toContain('gh workflow run blueprint-verify.yml');
});
it('has no stored-envelope consumer in src and the CLI cannot read an export', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []);
  const diskParsers = walk('src').filter(file => {
    const source = fs.readFileSync(file, 'utf8');
    return storedEnvelopeParser(source);
  });
  expect(diskParsers.sort()).toEqual(['src/blueprint/export/exportBlueprint.ts', 'src/blueprint/export/exportSchema.ts']);
  expect(fs.readFileSync('src/cli/blueprint.ts', 'utf8')).not.toMatch(/readFileSync\([^\n]*\.export\.json/);
});
