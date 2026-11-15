import { z } from 'zod';
import { BlueprintSpecSchema } from '../schema/blueprintSpec';
import { AttestationSchema } from '../approvals';

export const VerificationSchema = z.object({
  contentHash: z.string(), headSha: z.string(), reviewStateHash: z.string().nullable(),
  registryHash: z.string(), derivedAt: z.string(),
}).strict();
export const SourceSchema = z.object({
  owner: z.string().min(1), repo: z.string().min(1), pullNumber: z.number().int().positive(), path: z.string().min(1),
}).strict();
export const BlueprintExportSchema = z.object({
  exportSchemaVersion: z.literal(1), exportedAt: z.string(), spec: BlueprintSpecSchema,
  validation: z.object({ hash: z.string(), executable: z.boolean(), reasons: z.array(z.string()), issues: z.array(z.string()) }).strict(),
  attestations: z.array(AttestationSchema), verification: VerificationSchema, source: SourceSchema.nullable(),
}).strict().refine(e => !e.validation.executable || (e.verification.reviewStateHash !== null && e.source !== null), {
  message: 'Executable exports require derived review state and source coordinates',
});
export type BlueprintExport = z.infer<typeof BlueprintExportSchema>;
export type BlueprintVerification = z.infer<typeof VerificationSchema>;
export type BlueprintSource = z.infer<typeof SourceSchema>;
