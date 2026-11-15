import { createHash } from 'node:crypto';
import { exportBlueprint } from '../../../../src/blueprint/export/exportBlueprint';
import { BlueprintExportSchema } from '../../../../src/blueprint/export/exportSchema';
import { BlueprintSpecSchema } from '../../../../src/blueprint/schema/blueprintSpec';
import { validateBlueprint } from '../../../../src/blueprint/validate';
import { fixture } from '../helpers';

const fixed = '2026-09-07T00:00:00.000Z';
it('keeps untrusted text inside Markdown cells and the Mermaid code fence', async () => {
  const spec = BlueprintSpecSchema.parse(fixture());
  spec.metadata.name = 'Name\n# injected <img src=x>';
  spec.systems[0].vendor = 'vendor | injected\n# heading';
  spec.architecture.diagramMermaid = 'graph LR\n```\n# injected\n````';
  const validation = await validateBlueprint(spec);
  const out = exportBlueprint(spec, validation, [], { contentHash: validation.hash!, headSha: 'local', reviewStateHash: null, registryHash: 'hash', derivedAt: fixed }, null);
  expect(out['proposal.md']).toContain('vendor &#124; injected<br>&#35; heading');
  expect(out['proposal.md']).not.toContain('<img');
  expect(out['proposal.md']).toContain('`````mermaid\ngraph LR\n```\n# injected\n````\n`````');
  expect(out['proposal.md']).toContain('# Name<br>&#35; injected &lt;img src=x&gt;');
});
it('exports five artifacts and a strict round-trippable envelope', async () => {
  const spec = BlueprintSpecSchema.parse(fixture()); const validation = await validateBlueprint(spec);
  const verification = { contentHash: validation.hash!, headSha: 'local', reviewStateHash: null, registryHash: createHash('sha256').update('{}').digest('hex'), derivedAt: fixed };
  const out = exportBlueprint(spec, validation, [], verification, null, { exportedAt: fixed });
  expect(Object.keys(out).sort()).toEqual(['backlog.md', 'blueprint.export.json', 'control-matrix.md', 'proposal.md', 'test-plan.md']);
  const envelope = BlueprintExportSchema.parse(JSON.parse(out['blueprint.export.json']));
  expect(BlueprintSpecSchema.parse(envelope.spec)).toEqual(spec);
  expect(envelope.source).toBeNull(); expect(envelope.verification).toEqual(verification);
  expect(envelope.exportedAt).toBe(fixed);
  expect(out['proposal.md']).toContain('## Executable: no');
  expect(out['proposal.md']).not.toContain('customer-fixture-001');
  expect(out['proposal.md']).toContain('A governed write requested by a host-asserted principal is blocked at runtime until a Squire-verified requester re-submits it; executability of this document does not admit such a request.');
  expect(out['proposal.md']).toMatchSnapshot();
  for (const field of ['review', 'source']) {
    const forged = structuredClone(envelope); forged.validation.executable = true;
    if (field === 'review') forged.source = { owner: 'o', repo: 'r', pullNumber: 5, path: 'docs/' + 'blueprints/example.json' };
    else forged.verification.reviewStateHash = 'abc';
    expect(BlueprintExportSchema.safeParse(forged).success).toBe(false);
  }
});
