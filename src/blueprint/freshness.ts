import { createHash } from 'node:crypto';
import { z } from 'zod';
import isEqual from 'lodash/isEqual';
import { REGISTRY_PATH, ApproverRegistrySchema } from './approvals';
import { SourceSchema, VerificationSchema } from './export/exportSchema';
import { BlueprintSpecSchema, type BlueprintSpec } from './schema/blueprintSpec';
import { contentHash, validateBlueprint } from './validate';
import { deriveAttestations, HeadMovedError, type ReviewsApi, type VerifiedAttestations } from './githubReviews';

export type FreshResult =
  | { executable: true; headSha: string; spec: BlueprintSpec; attestations: VerifiedAttestations }
  | { executable: false; reason: 'verification_stale' | 'verification_unavailable' | 'blueprint_not_in_pull' }
  | { executable: false; reason: 'not_executable'; headSha: string; reasons: string[] };

export function isBlueprintPath(path: string): boolean {
  return /^docs\/blueprints\/.+\.json$/.test(path) && !path.includes('\\')
    && [...path].every(character => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
    && path.split('/').every(segment => segment !== '.' && segment !== '..' && segment.length > 0);
}
// Intentionally select only these two fields. Never parse or inspect the stored verdict or payload.
const CoordinatesSchema = z.object({ source: SourceSchema.nullable(), verification: VerificationSchema });
const stale = (): FreshResult => ({ executable: false, reason: 'verification_stale' });

export async function assertFresh(envelope: unknown, args: {
  owner: string; repo: string; pullNumber: number; specPath: string; api: ReviewsApi;
}): Promise<FreshResult> {
  if (!isBlueprintPath(args.specPath)) throw new Error('specPath must be under docs/blueprints/ and end in .json');
  const { owner, repo, pullNumber, specPath, api } = args;
  try {
    const pull = await api.getPull();
    if (pull.state === 'closed' && !pull.merged) return stale();
    if (pull.head.repo?.full_name !== `${owner}/${repo}`) return stale();
    const parsed = CoordinatesSchema.safeParse(envelope);
    if (!parsed.success) return stale();
    const { source, verification } = parsed.data;
    if (!isEqual(source, { owner, repo, pullNumber, path: specPath }) || verification.headSha !== pull.head.sha) return stale();
    const files = await api.listFiles();
    if (!files.some(f => f.filename === specPath && f.status !== 'removed')) return { executable: false, reason: 'blueprint_not_in_pull' };
    const bytes = await api.getFileAtRef(specPath, pull.head.sha);
    let spec: BlueprintSpec;
    try { spec = BlueprintSpecSchema.parse(JSON.parse(bytes)); } catch { return stale(); }
    if (contentHash(spec) !== verification.contentHash) return stale();
    let registryRef = pull.base.sha;
    const merged = pull.state === 'closed' && pull.merged;
    if (merged) {
      registryRef = await api.getBranchHead(pull.base.ref);
      const canonicalBytes = await api.getFileAtRef(specPath, registryRef);
      try {
        if (contentHash(BlueprintSpecSchema.parse(JSON.parse(canonicalBytes))) !== contentHash(spec)) return stale();
      } catch { return stale(); }
    }
    const registryBytes = await api.getFileAtRef(REGISTRY_PATH, registryRef);
    if (!merged && createHash('sha256').update(registryBytes).digest('hex') !== verification.registryHash) return stale();
    const registry = ApproverRegistrySchema.parse(JSON.parse(registryBytes));
    const derived = await deriveAttestations({ owner, repo, pullNumber, headSha: pull.head.sha, registry, spec, api });
    if (verification.reviewStateHash === null || verification.reviewStateHash !== derived.reviewStateHash) return stale();
    const validation = await validateBlueprint(spec, { registry, attestations: derived.attestations });
    if (!validation.executable) return { executable: false, reason: 'not_executable', headSha: pull.head.sha, reasons: validation.reasons };
    return { executable: true, headSha: pull.head.sha, spec, attestations: derived.attestations };
  } catch (error) {
    return error instanceof HeadMovedError ? stale() : { executable: false, reason: 'verification_unavailable' };
  }
}
