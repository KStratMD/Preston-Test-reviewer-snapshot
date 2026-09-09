// src/blueprint/githubReviews.ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { contentHash } from './validate';
import type { ApproverRegistry, Attestation } from './approvals';
import type { BlueprintSpec } from './schema/blueprintSpec';
export class HeadMovedError extends Error { constructor(public readonly asked: string, public readonly live: string) { super(`head moved: asked ${asked}, live ${live}`); } }
export interface ReviewsApi {
  getPull(): Promise<{ user: { login: string }; state: 'open' | 'closed'; merged: boolean; head: { sha: string; repo?: { full_name: string } | null }; base: { sha: string; ref: string } }>;
  getBranchHead(branch: string): Promise<string>; // GET /repos/{o}/{r}/branches/{branch} → commit.sha
  getFileAtRef(path: string, ref: string): Promise<string>; // GET /repos/{o}/{r}/contents/{path}?ref=<sha> with Accept: application/vnd.github.raw+json (raw bytes, no 1 MB base64 ceiling; above the API's 100 MB raw limit the call fails and the caller fails closed)
  listReviews(): Promise<{ id: number; state: string; commit_id: string; submitted_at: string; user: { login: string } }[]>;
  listFiles(): Promise<{ filename: string; status: string }[]>; // GET /repos/{o}/{r}/pulls/{n}/files, paginated
}
export interface VerifiedAttestations { readonly items: readonly Attestation[] }
const VERIFIED = new WeakSet<object>(); // module-private: the only registration is inside deriveAttestations
export function isVerified(x: unknown): x is VerifiedAttestations { return typeof x === 'object' && x !== null && VERIFIED.has(x); }
const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
export async function deriveAttestations(args: { owner: string; repo: string; pullNumber: number; headSha: string; registry: ApproverRegistry; spec: BlueprintSpec; api: ReviewsApi }) {
  const { pullNumber, headSha, registry, spec, api } = args;
  const pull = await api.getPull(); if (pull.head.sha !== headSha) throw new HeadMovedError(headSha, pull.head.sha); // never derive for a head that is no longer live
  const authorLogin = pull.user.login; const issues: string[] = []; const hash = contentHash(spec);
  // GitHub returns reviews chronologically; a CHANGES_REQUESTED after an APPROVED blocks until a later APPROVED. Keep each login's latest decisive review.
  const latest = new Map<string, { id: number; state: string; commit_id: string; submitted_at: string }>();
  const reviews = await api.listReviews();
  const after = await api.getPull(); if (after.head.sha !== headSha) throw new HeadMovedError(headSha, after.head.sha); // the reviews were read while the head was headSha at both bounds
  const reviewStateHash = createHash('sha256').update(JSON.stringify(reviews.map(r => [String(r.id), r.state, r.commit_id, r.user.login, r.submitted_at]).sort())).digest('hex'); // every review read, not only the decisive ones
  const ordered = [...reviews].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at) || a.id - b.id); // never trust page order
  for (const review of ordered) if (DECISIVE.has(review.state)) latest.set(review.user.login, review);
  const items: Attestation[] = [];
  for (const [login, review] of latest) {
    if (review.state !== 'APPROVED' || review.commit_id !== headSha) continue; // an approval of an earlier commit never counts
    const entry = registry.approvers.find(p => p.active && p.githubLogin === login);
    if (!entry) continue;
    if (login === authorLogin) { issues.push(`author_cannot_attest: ${login}`); continue; }
    const role = spec.approvals.roles.find(r => entry.roles.includes(r)); if (!role) continue;
    items.push({ approver: entry.id, role, hash, at: review.submitted_at, source: 'github_review', reviewId: String(review.id), pullNumber });
  }
  const attestations: VerifiedAttestations = Object.freeze({ items: Object.freeze(items.map(i => Object.freeze(i))) }); // AC-04: each item frozen, so a strict-mode write to it throws
  VERIFIED.add(attestations);
  return { attestations, authorLogin, issues, reviewStateHash };
}

const text = z.string().min(1);
const PullSchema = z.object({ user: z.object({ login: text }), state: z.enum(['open', 'closed']), merged: z.boolean(),
  head: z.object({ sha: text, repo: z.object({ full_name: text }).nullable().optional() }), base: z.object({ sha: text, ref: text }),
});
const ReviewSchema = z.object({ id: z.number().int().positive(), state: text, commit_id: text, submitted_at: text, user: z.object({ login: text }) });
const FileSchema = z.object({ filename: text, status: text });
const apiRoot = () => (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
const repositoryPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
async function request(token: string, url: string, init: RequestInit = {}, raw = false): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...init.headers },
  });
  if (!response.ok) throw new Error(`GitHub API refused request (${response.status})`);
  return response;
}
export function githubApi(token: string, owner: string, repo: string, pullNumber: number): ReviewsApi {
  const root = apiRoot() + repositoryPath(owner, repo);
  const pullRoot = `${root}/pulls/${pullNumber}`;
  async function pages<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    let url: string | undefined = `${path}?per_page=100`;
    const visited = new Set<string>(); const items: T[] = [];
    while (url) {
      const candidate = new URL(url); const expected = new URL(path);
      candidate.searchParams.sort(); candidate.hash = '';
      const key = candidate.href;
      if (candidate.origin !== expected.origin || candidate.pathname !== expected.pathname || visited.has(key)) throw new Error('Unsafe or cyclic GitHub pagination');
      if (visited.size >= 100) throw new Error('GitHub pagination exceeds 100 pages');
      visited.add(key);
      const response = await request(token, url);
      items.push(...z.array(schema).parse(await response.json()));
      const next = response.headers.get('link')?.split(',').find(link => /;\s*rel="next"/.test(link));
      url = next ? next.match(/<([^>]+)>/)?.[1] : undefined;
      if (next && !url) throw new Error('Malformed GitHub pagination');
    }
    return items;
  }
  return {
    getPull: async () => PullSchema.parse(await (await request(token, pullRoot)).json()),
    listReviews: () => pages(`${pullRoot}/reviews`, ReviewSchema),
    listFiles: () => pages(`${pullRoot}/files`, FileSchema),
    getBranchHead: async branch => z.object({ commit: z.object({ sha: text }) }).parse(await (await request(token, `${root}/branches/${encodeURIComponent(branch)}`)).json()).commit.sha,
    getFileAtRef: async (path, ref) => (await request(token, `${root}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, {}, true)).text(),
  };
}
export async function publishStatus(token: string, owner: string, repo: string, headSha: string, state: 'success' | 'failure', description: string): Promise<void> {
  await request(token, `${apiRoot()}${repositoryPath(owner, repo)}/statuses/${encodeURIComponent(headSha)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, context: 'blueprint-verify', description }),
  });
}
