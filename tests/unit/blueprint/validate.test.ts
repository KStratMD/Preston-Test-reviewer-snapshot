import fs from 'node:fs';
import { validateBlueprint, contentHash } from '../../../src/blueprint/validate';
import { deriveAttestations, isVerified, HeadMovedError } from '../../../src/blueprint/githubReviews';
import { fixture, ready, registry, pull, approved, stubApi, deriveArgs } from './helpers';

it('validates the discovery fixture without making it executable', async () => {
  const r = await validateBlueprint(fixture());
  expect(r.ok).toBe(true); expect(r.executable).toBe(false);
  expect(r.reasons).toContain('evidence level is discovery');
  expect(r.reasons).toContain('attestations not verified against GitHub');
});
it('executes all golden cases with the default engine and verified approvals', async () => {
  const spec = ready(); const { attestations } = await deriveAttestations(deriveArgs(spec));
  expect(await validateBlueprint(spec, { registry, attestations })).toMatchObject({ ok: true, executable: true, issues: [], reasons: [] });
});
it('rejects forged containers and freezes every attestation item', async () => {
  const spec = ready(); const { attestations } = await deriveAttestations(deriveArgs(spec));
  for (const forged of [attestations.items, { items: attestations.items }, { ...attestations }, Object.assign(Object.create(null), attestations)]) {
    const r = await validateBlueprint(spec, { registry, attestations: forged });
    expect(r.executable).toBe(false); expect(r.reasons).toContain('attestations not verified against GitHub');
  }
  expect(isVerified(attestations)).toBe(true);
  for (const key of ['hash', 'approver', 'role']) {
    expect(() => { (attestations.items[0] as unknown as Record<string, unknown>)[key] = 'forged'; }).toThrow(TypeError);
  }
  expect(Object.isFrozen(attestations)).toBe(true); expect(Object.isFrozen(attestations.items)).toBe(true);
  expect((await validateBlueprint(spec, { registry, attestations })).executable).toBe(true);
});
it('binds approvals to the finalized content and distinct registered approvers', async () => {
  const spec = ready(); spec.approvals.requiredApprovers = 2;
  const { attestations } = await deriveAttestations(deriveArgs(spec, stubApi([approved(), approved(undefined, 'abc', 'APPROVED', 78)])));
  expect(await validateBlueprint(spec, { registry, attestations })).toMatchObject({ ok: true, issues: [], executable: false, reasons: ['requires 2 distinct verified attestation(s), found 1'] });
  spec.approvals.requiredApprovers = 1;
  expect((await validateBlueprint(spec, { registry, attestations })).executable).toBe(false);
});
it('blocks denied system access independently of unresolved blockers', async () => {
  const spec = ready(); spec.systems.find((s: { id: string }) => s.id === 'netsuite').evidenceLevel = 1;
  spec.blockers = [{ id: 'b_netsuite_access', statement: 'Access refused', owner: 'customer-erp-admin' }];
  let verified = await deriveAttestations(deriveArgs(spec));
  expect((await validateBlueprint(spec, { registry, attestations: verified.attestations })).reasons).toEqual(['system netsuite evidence rung 1 is below 2', '1 unresolved blocker(s)']);
  spec.blockers = []; verified = await deriveAttestations(deriveArgs(spec));
  expect((await validateBlueprint(spec, { registry, attestations: verified.attestations })).reasons).toEqual(['system netsuite evidence rung 1 is below 2']);
});
it.each(['owner', 'consumer', 'fieldOverride', 'adapter'])('rejects unknown %s system references', async kind => {
  const spec = ready();
  if (kind === 'owner') spec.ownership[0].owner = 'missing';
  if (kind === 'consumer') spec.ownership[0].consumers.push('missing');
  if (kind === 'fieldOverride') spec.ownership[0].fieldOverrides.push({ field: 'total', owner: 'missing' });
  if (kind === 'adapter') spec.adapterRequirements[0].system = 'missing';
  expect(await validateBlueprint(spec)).toMatchObject({ ok: false, executable: false, issues: expect.arrayContaining([expect.stringContaining('unknown system missing')]) });
});
it('requires target ownership and canonical executable mappings', async () => {
  const spec = ready(); expect(spec.ownership.some((o: { entity: string }) => o.entity === 'salesorder')).toBe(true);
  spec.ownership = spec.ownership.filter((o: { entity: string }) => o.entity !== 'salesorder');
  expect((await validateBlueprint(spec)).ok).toBe(false);
  const bad = ready(); bad.mappings[0].fieldMappings.push({ sourceField: 'a', targetField: 'z', transformationType: 'split', isRequired: false });
  expect((await validateBlueprint(bad)).ok).toBe(false);
});
it('compares exact golden output and treats error text literally', async () => {
  for (const expected of [{ fields: { externalId: 'WRONG' } }, { error: '[' }]) {
    const spec = ready(); spec.mappings[0].goldenCases[0].expected = expected;
    const r = await validateBlueprint(spec); expect(r.ok).toBe(true); expect(r.reasons.some(x => x.startsWith('golden case'))).toBe(true);
  }
});
it('hashes content independent of object key order', () => {
  const spec = ready(); const reordered = Object.fromEntries(Object.entries(spec).reverse());
  expect(contentHash(spec)).toBe(contentHash(reordered as never));
  reordered.goals = []; expect(contentHash(spec)).not.toBe(contentHash(reordered as never));
});
it('keeps real principals in the production registry', () => {
  const prod = JSON.parse(fs.readFileSync('docs/blueprint/approvers.json', 'utf8'));
  expect(prod.approvers.length).toBeGreaterThan(0);
  expect(prod.approvers.some((p: { id: string }) => p.id.endsWith('-fixture'))).toBe(false);
});
it('orders reviews deterministically, drops withdrawn approvals and binds author to GitHub', async () => {
  const reviews = [approved(), approved(undefined, 'abc', 'CHANGES_REQUESTED', 78, '2026-09-02T00:01:00Z'), approved(undefined, 'abc', 'APPROVED', 79, '2026-09-02T00:02:00Z')];
  const a = await deriveAttestations(deriveArgs(ready(), stubApi(reviews)));
  const b = await deriveAttestations(deriveArgs(ready(), stubApi([...reviews].reverse())));
  expect(a).toEqual(b); expect(a.attestations.items[0].reviewId).toBe('79');
  for (const rejected of [[approved(undefined, 'old')], [approved('unregistered')], [approved(undefined, 'abc', 'DISMISSED')], reviews.slice(0, 2)]) {
    expect((await deriveAttestations(deriveArgs(ready(), stubApi(rejected)))).attestations.items).toEqual([]);
  }
  const api = stubApi(); api.getPull = async () => pull('reviewer-fixture-gh');
  const spec = ready(); spec.metadata.author = 'someone-else';
  const result = await deriveAttestations(deriveArgs(spec, api));
  expect(result.attestations.items).toEqual([]); expect(result.issues).toContain('author_cannot_attest: reviewer-fixture-gh');
});
it('checks the head before and after reading reviews', async () => {
  for (const at of [1, 2]) {
    const api = stubApi(); let count = 0; api.getPull = async () => pull('x', ++count >= at ? 'moved' : 'abc');
    await expect(deriveAttestations(deriveArgs(ready(), api))).rejects.toBeInstanceOf(HeadMovedError);
  }
});
