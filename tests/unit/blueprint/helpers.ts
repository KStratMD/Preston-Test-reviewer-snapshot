import fs from 'node:fs';
import type { ReviewsApi } from '../../../src/blueprint/githubReviews';
export const fixture = () => JSON.parse(fs.readFileSync('tests/fixtures/blueprints/shopify-netsuite-order-to-cash.v1.json', 'utf8'));
export const registry = { approvers: [
  { id: 'consultant-fixture', githubLogin: 'consultant-fixture-gh', roles: ['requester'], active: true },
  { id: 'reviewer-fixture', githubLogin: 'reviewer-fixture-gh', roles: ['approver'], active: true },
] };
export const ready = () => { const spec = fixture(); spec.metadata.evidenceLevel = 'validated'; spec.systems.forEach((s: { evidenceLevel: number }) => { s.evidenceLevel = 2; }); return spec; };
export const pull = (author = 'consultant-fixture-gh', head = 'abc') => ({ user: { login: author }, state: 'open' as const, merged: false, head: { sha: head, repo: { full_name: 'o/r' } }, base: { sha: 'base0', ref: 'Working-Branch' } });
export const approved = (login = 'reviewer-fixture-gh', commit = 'abc', state = 'APPROVED', id = 77, at = '2026-09-02T00:00:00Z') => ({ id, state, commit_id: commit, submitted_at: at, user: { login } });
export const stubApi = (reviews = [approved()]): ReviewsApi => ({ getPull: async () => pull(), listReviews: async () => reviews, getFileAtRef: async () => { throw new Error('unused'); }, listFiles: async () => [], getBranchHead: async () => 'base0' });
export const deriveArgs = (spec = ready(), api = stubApi()) => ({ owner: 'o', repo: 'r', pullNumber: 5, headSha: 'abc', registry, spec, api });
