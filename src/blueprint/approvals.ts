import { z } from 'zod';

export const REGISTRY_PATH = 'docs/blueprint/approvers.json';
export const AttestationSchema = z.object({
  approver: z.string().min(1), role: z.string().min(1), hash: z.string().min(1),
  at: z.string().min(1), source: z.literal('github_review'), reviewId: z.string().min(1),
  pullNumber: z.number().int().positive(),
}).strict();
export type Attestation = z.infer<typeof AttestationSchema>;
export const ApproverRegistrySchema = z.object({ approvers: z.array(z.object({
  id: z.string().min(1), githubLogin: z.string().min(1), roles: z.array(z.string().min(1)), active: z.boolean(),
}).strict()) }).strict();
export type ApproverRegistry = z.infer<typeof ApproverRegistrySchema>;
