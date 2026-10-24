import { createHash } from 'node:crypto';
import { assertFresh } from '../../../src/blueprint/freshness';
import { deriveAttestations } from '../../../src/blueprint/githubReviews';
import { contentHash, validateBlueprint } from '../../../src/blueprint/validate';
import { exportBlueprint } from '../../../src/blueprint/export/exportBlueprint';
import { REGISTRY_PATH } from '../../../src/blueprint/approvals';
import { ready, registry, pull, approved, stubApi, deriveArgs } from './helpers';

const specPath = 'docs/' + 'blueprints/example.json';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
async function scenario() {
  const spec = ready(); const bytes = JSON.stringify(spec); const registryBytes = JSON.stringify(registry);
  const api = stubApi(); api.listFiles = async () => [{ filename: specPath, status: 'modified' }];
  api.getFileAtRef = async path => path === REGISTRY_PATH ? registryBytes : bytes;
  const verified = await deriveAttestations(deriveArgs(spec, api));
  const validation = await validateBlueprint(spec, { registry, attestations: verified.attestations });
  const envelope = JSON.parse(exportBlueprint(spec, validation, verified.attestations.items, {
    contentHash: contentHash(spec), headSha: 'abc', reviewStateHash: verified.reviewStateHash,
    registryHash: sha(registryBytes), derivedAt: '2026-09-07T00:00:00Z',
  }, { owner: 'o', repo: 'r', pullNumber: 5, path: specPath })['blueprint.export.json']);
  return { spec, api, envelope, args: { owner: 'o', repo: 'r', pullNumber: 5, specPath, api } };
}
it('returns fetched payload and never reads envelope spec, attestations or executable', async () => {
  const { spec, envelope, args } = await scenario();
  for (const key of ['spec', 'attestations', 'validation']) Object.defineProperty(envelope, key, { get() { throw new Error('untrusted property read'); } });
  const result = await assertFresh(envelope, args);
  expect(result).toMatchObject({ executable: true, headSha: 'abc', spec });
});
it.each(['fork-owner/repo', undefined])('rejects fork or unavailable head repository %s even with real approvals', async repository => {
  const { envelope, args, api } = await scenario();
  api.getPull = async () => ({ ...pull(), head: { ...pull().head, repo: repository ? { full_name: repository } : undefined } });
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'verification_stale' });
});
it.each(['../example.json', 'docs/' + 'blueprints/../example.json', 'docs/' + 'blueprints//x.json', 'docs/' + 'blueprints/x.txt', 'docs/' + 'blueprints/./x.json', 'docs/' + 'blueprint/x.json', 'docs\\blueprints\\x.json'])('rejects namespace %s before an API call', async path => {
  const { envelope, args, api } = await scenario(); api.getPull = jest.fn();
  await expect(assertFresh(envelope, { ...args, specPath: path })).rejects.toThrow();
  expect(api.getPull).not.toHaveBeenCalled();
});
it.each(['owner', 'repo', 'pullNumber', 'path', 'headSha', 'contentHash', 'registryHash', 'reviewStateHash'])('rejects stale %s', async key => {
  const { envelope, args } = await scenario();
  if (key in envelope.source) envelope.source[key] = key === 'pullNumber' ? 6 : 'other';
  else envelope.verification[key] = 'other';
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'verification_stale' });
});
it('rejects a forged spec and hash together', async () => {
  const { envelope, args } = await scenario(); envelope.spec.goals[0].statement = 'forged'; envelope.verification.contentHash = contentHash(envelope.spec);
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'verification_stale' });
});
it.each(['missing', 'removed', 'renamed-away'])('rejects %s blueprint membership', async mode => {
  const { envelope, args, api } = await scenario();
  api.listFiles = async () => mode === 'missing' ? [] : [{ filename: mode === 'renamed-away' ? 'elsewhere.json' : specPath, status: mode === 'removed' ? 'removed' : 'renamed' }];
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'blueprint_not_in_pull' });
});
it('accepts a rename addressed by its new in-namespace path', async () => {
  const { envelope, args, api } = await scenario(); api.listFiles = async () => [{ filename: specPath, status: 'renamed' }];
  expect((await assertFresh(envelope, args)).executable).toBe(true);
});
it('fails closed on closed-unmerged PRs and malformed head bytes', async () => {
  const { envelope, args, api } = await scenario(); api.getPull = async () => ({ ...pull(), state: 'closed', merged: false });
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'verification_stale' });
  api.getPull = async () => pull(); api.getFileAtRef = async () => '{}';
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'verification_stale' });
});
it.each(['getPull', 'listFiles', 'getFileAtRef', 'listReviews'])('reports unavailable when %s fails', async method => {
  const { envelope, args, api } = await scenario(); Object.assign(api, { [method]: async () => { throw new Error('unreachable'); } });
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'verification_unavailable' });
});
it('requires raw registry byte equality for open PRs', async () => {
  const { envelope, args, api, spec } = await scenario();
  api.getFileAtRef = async path => path === REGISTRY_PATH ? JSON.stringify(registry) + '\r\n' : JSON.stringify(spec);
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'verification_stale' });
});
it('recomputes at consumption when the review dispatcher failed', async () => {
  const { envelope, args, api } = await scenario();
  expect((await assertFresh(envelope, args)).executable).toBe(true);
  api.listReviews = async () => [approved(undefined, 'abc', 'DISMISSED')];
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'verification_stale' });
  api.getPull = async () => pull('x', 'new');
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'verification_stale' });
  api.getPull = async () => { throw new Error('offline'); };
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'verification_unavailable' });
});
it('maps a head movement during derivation to stale', async () => {
  const { envelope, args, api } = await scenario(); let calls = 0;
  api.getPull = async () => pull('x', ++calls === 3 ? 'new' : 'abc');
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'verification_stale' });
});
it('binds merged content to the canonical branch and applies its current registry', async () => {
  const { envelope, args, api, spec } = await scenario();
  api.getPull = async () => ({ ...pull(), state: 'closed', merged: true });
  api.getBranchHead = jest.fn(async () => 'canonical');
  expect((await assertFresh(envelope, args)).executable).toBe(true);
  expect(api.getBranchHead).toHaveBeenCalledWith('Working-Branch');
  api.getFileAtRef = async (path, ref) => path === REGISTRY_PATH ? JSON.stringify(registry) : JSON.stringify(ref === 'canonical' ? { ...spec, exclusions: ['changed'] } : spec);
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'verification_stale' });
  api.getFileAtRef = async (path, ref) => path === REGISTRY_PATH ? JSON.stringify(ref === 'canonical' ? { approvers: [] } : registry) : JSON.stringify(spec);
  expect(await assertFresh(envelope, args)).toEqual({ executable: false, reason: 'not_executable', headSha: 'abc', reasons: ['requires 1 distinct verified attestation(s), found 0'] });
});
