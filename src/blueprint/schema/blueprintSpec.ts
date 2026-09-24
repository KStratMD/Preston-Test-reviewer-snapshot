// src/blueprint/schema/blueprintSpec.ts
import { z } from 'zod';
import { FieldMappingSchema } from '../../domain/mapping/MappingContract';

const Id = z.string().min(1);
const EvidenceRung = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]);

export const BlueprintSpecSchema = z.object({
  schemaVersion: z.literal(1),
  metadata: z.object({
    id: Id, name: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+$/),
    customerRef: z.string(),
    author: z.string(), createdAt: z.string(),
    evidenceLevel: z.enum(['discovery', 'validated', 'approved']),
  }).strict(),
  goals: z.array(z.object({ id: Id, statement: z.string(), successCriteria: z.array(z.string()), measurable: z.boolean() }).strict()).min(1),
  systems: z.array(z.object({
    id: Id, role: z.enum(['commerce', 'erp', 'payments', 'fulfillment', 'tax', 'other']),
    vendor: z.string(), edition: z.string().optional(), apiVersion: z.string().optional(),
    authModel: z.string(), evidenceLevel: EvidenceRung,
  }).strict()).min(2),
  integrationPaths: z.array(z.object({ id: Id, from: Id, to: Id, owner: z.enum(['existing_vendor_connector', 'partner_product', 'customer_built', 'ipaas', 'squire']), product: z.string().optional(), squireRole: z.enum(['observe_and_propose', 'observe_reconcile_apply', 'own_transport']) }).strict()),
  objects: z.array(z.object({ id: Id, system: Id, apiObject: z.string(), keyFields: z.array(z.string()).min(1) }).strict()),
  ownership: z.array(z.object({ entity: Id, owner: Id, consumers: z.array(Id), conflictPolicy: z.enum(['source_wins', 'target_wins', 'reject_with_alert', 'merge_field_level', 'queue_for_human']), fieldOverrides: z.array(z.object({ field: z.string(), owner: Id }).strict()) }).strict()),
  mappings: z.array(z.object({ id: Id, sourceObject: Id, targetObject: Id, fieldMappings: z.array(FieldMappingSchema).min(1), goldenCases: z.array(z.object({ name: Id, input: z.object({ id: z.string().optional(), externalId: z.string().optional(), fields: z.record(z.string(), z.unknown()), metadata: z.record(z.string(), z.unknown()) }).strict(), expected: z.union([z.object({ fields: z.record(z.string(), z.unknown()) }).strict(), z.object({ error: z.string().min(1).max(200) }).strict()]) }).strict()).min(1) }).strict()),
  transformations: z.array(z.unknown()),
  exceptions: z.array(z.object({ id: Id, type: z.enum(['missing_in_target', 'missing_in_source', 'duplicate_key', 'amount_mismatch', 'sku_mismatch', 'customer_mismatch', 'tax_mismatch', 'currency_mismatch', 'fulfillment_mismatch', 'refund_mismatch', 'downstream_failure', 'ownership_conflict']), description: z.string(), severity: z.enum(['low', 'medium', 'high']), disposition: z.enum(['propose_create', 'propose_correction', 'escalate', 'ignore_with_reason']) }).strict()),
  approvals: z.object({ separationOfDuties: z.literal(true), requiredApprovers: z.number().int().min(1), roles: z.array(z.string()) }).strict(),
  dlp: z.object({ posture: z.enum(['autoRedact', 'block']), sensitiveFields: z.array(z.string()), allowPII: z.boolean() }).strict(),
  testPlan: z.object({ fixtureSets: z.array(z.string()), goldenRecords: z.array(z.string()), acceptance: z.array(z.string()).min(1), tolerances: z.object({ amountMinorUnits: z.number().int().min(0) }).strict() }).strict(),
  adapterRequirements: z.array(z.object({ system: Id, capabilities: z.array(z.string()).min(1) }).strict()),
  architecture: z.object({ summary: z.string(), diagramMermaid: z.string() }).strict(),
  backlog: z.array(z.object({ id: Id, title: z.string(), phase: z.enum(['discovery', 'prototype', 'sandbox', 'pilot', 'scale']), estimateDays: z.number().positive() }).strict()),
  risks: z.array(z.object({ id: Id, statement: z.string(), mitigation: z.string(), severity: z.enum(['low', 'medium', 'high']) }).strict()),
  blockers: z.array(z.object({ id: Id, statement: z.string(), owner: z.string() }).strict()),
  openQuestions: z.array(z.string()),
  exclusions: z.array(z.string()),
  proposalInputs: z.object({ phases: z.array(z.string()), pricingPlaceholder: z.string(), sowSections: z.array(z.string()) }).strict(),
  outcomes: z.array(z.object({ id: Id, unit: z.string(), verification: z.string(), attributionRule: z.string() }).strict()),
}).strict();

export type BlueprintSpec = z.infer<typeof BlueprintSpecSchema>;
