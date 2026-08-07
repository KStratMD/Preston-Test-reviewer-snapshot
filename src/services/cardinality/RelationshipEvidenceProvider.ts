import type { CardinalityEdge, RelationshipEvidence } from '../../types/cardinality';
import { SchemaDiscoveryService } from '../ai/validation/SchemaDiscoveryService';
import { NetSuiteSchemaIntelligence } from '../ai/NetSuiteSchemaIntelligence';
import type { NetSuiteRelationship } from '../ai/AIFieldMappingService';
import type { EntityType, SchemaRelationship } from '../ai/validation/types';

/**
 * Normalizes connector-specific relationship metadata into server-trusted
 * RelationshipEvidence. See
 * docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * "Canonical relationship evidence". This module owns evidence
 * *normalization* only — no analyzer rules, fingerprints, or sample safety
 * (those stay in CardinalityAnalysisService / fingerprint / sampleSafety).
 *
 * Binding semantics (non-negotiable):
 * - NetSuite: relationship edges for catalogued entities come from the
 *   explicit static `NetSuiteSchemaIntelligence` catalog only — never from
 *   SchemaDiscoveryService's NetSuite path, which carries no relationship
 *   data. Entities outside `CATALOGUED_NETSUITE_ENTITIES` are unavailable.
 *   `NetSuiteSchemaIntelligence` performs no I/O, so this path can never
 *   throw a transport failure — it is injected fully constructed with its
 *   required logger; this provider never calls its constructor bare.
 * - Salesforce: a manual schema (real discovery disabled or unreachable at
 *   config level) is always unavailable, regardless of whether it happens to
 *   carry relationships — the gate is on provenance, not on edge count, so
 *   an empty manual/mock relationship list never becomes available evidence.
 *   An API-discovered schema's child relationships are re-oriented so the
 *   edge is traversable from the parent by the relationship name Salesforce
 *   exposes for SOQL subqueries (the child-collection field a mapping path
 *   walks through), landing on the real foreign key field that lives on the
 *   child.
 * - Business Central and every other system: unavailable. No discovery is
 *   attempted.
 * - A transport failure while a real Salesforce discovery call is enabled
 *   throws so the caller can surface an inability-to-decide (503), never a
 *   trustworthy "unavailable" evidence result. An unsupported capability
 *   (uncatalogued NetSuite entity, Business Central, any other system, or
 *   Salesforce discovery not configured) resolves to unavailable evidence
 *   without throwing.
 */

/** Explicit, maintained by hand — mirrors NetSuiteSchemaIntelligence's own
 * standard-field/relationship catalog. No fuzzy inference: an entity is
 * catalogued only if its record type literally appears here. */
const CATALOGUED_NETSUITE_ENTITIES: ReadonlySet<string> = new Set([
  'customer',
  'vendor',
  'item',
  'contact',
  'inventorynumber',
]);

/** NetSuite's canonical record-identity field, used as every catalog edge's
 * far-side field — NetSuiteRelationship carries no explicit FK field name. */
const NETSUITE_IDENTITY_FIELD = 'internalid';

export interface RelationshipEvidenceProviderDeps {
  schemaDiscoveryService: SchemaDiscoveryService;
  netSuiteSchemaIntelligence: NetSuiteSchemaIntelligence;
}

export class RelationshipEvidenceProvider {
  private readonly schemaDiscoveryService: SchemaDiscoveryService;
  private readonly netSuiteSchemaIntelligence: NetSuiteSchemaIntelligence;

  constructor(deps: RelationshipEvidenceProviderDeps) {
    this.schemaDiscoveryService = deps.schemaDiscoveryService;
    this.netSuiteSchemaIntelligence = deps.netSuiteSchemaIntelligence;
  }

  /**
   * Resolves server-trusted relationship evidence for one system/entity.
   * `system` is matched case-insensitively; `system`/`entity` are echoed back
   * verbatim on the returned evidence (the analyzer normalizes independently).
   */
  async getEvidence(system: string, entity: string): Promise<RelationshipEvidence> {
    const normalizedSystem = system.trim().toLocaleLowerCase('en-US');

    switch (normalizedSystem) {
      case 'netsuite':
        return this.getNetSuiteEvidence(system, entity);
      case 'salesforce':
        return this.getSalesforceEvidence(system, entity);
      default:
        return unavailableEvidence(
          system,
          entity,
          `Relationship discovery is not supported for system "${system}"`,
        );
    }
  }

  private getNetSuiteEvidence(system: string, entity: string): RelationshipEvidence {
    const recordType = entity.trim().toLocaleLowerCase('en-US');
    if (!CATALOGUED_NETSUITE_ENTITIES.has(recordType)) {
      return unavailableEvidence(
        system,
        entity,
        `NetSuite entity "${entity}" is not in the catalogued relationship set`,
      );
    }

    const relationships = this.netSuiteSchemaIntelligence.getRecordRelationships(recordType);
    const edges = relationships.map((relationship) =>
      toNetSuiteEdge(recordType, relationship, this.netSuiteSchemaIntelligence),
    );

    return {
      system,
      entity,
      status: 'available',
      edges,
      provenance: { source: 'manual_server' },
    };
  }

  private async getSalesforceEvidence(system: string, entity: string): Promise<RelationshipEvidence> {
    // SchemaDiscoveryService's EntityType union is a closed set of app-known
    // entity names, but its own entity->sObject mapping already falls back to
    // the raw string for anything outside that set (mapEntityToSalesforceType),
    // so a plan-supplied entity name outside the union is still handled
    // correctly at runtime.
    const schema = await this.schemaDiscoveryService.discoverSalesforceRelationshipSchema(
      entity as EntityType,
    );

    if (!schema || schema.metadata?.source !== 'api') {
      return unavailableEvidence(
        system,
        entity,
        'Salesforce relationship discovery is unavailable (manual schema)',
      );
    }

    const edges = schema.relationships
      .filter((relationship) => relationship.type === 'one-to-many' || relationship.type === 'many-to-one')
      .map((relationship) => toSalesforceEdge(entity, relationship));

    return {
      system,
      entity,
      status: 'available',
      edges,
      provenance: {
        source: 'api',
        ...(schema.metadata?.version ? { schemaVersion: schema.metadata.version } : {}),
      },
    };
  }
}

function unavailableEvidence(system: string, entity: string, reason: string): RelationshipEvidence {
  return {
    system,
    entity,
    status: 'unavailable',
    edges: [],
    provenance: { source: 'manual_server' },
    unavailableReason: reason,
  };
}

/**
 * NetSuite enrichment: child relationships become one_to_many, lookup/parent
 * relationships normalize to many_to_one (design doc, "Canonical relationship
 * evidence"). `toField` orientation mirrors the Salesforce principle — the
 * child foreign key must be labeled honestly, on the child entity, never a
 * plausible-but-wrong guess:
 * - many_to_one (lookup/parent): the join lands on the related record's own
 *   identity field, which for NetSuite is always `internalid`.
 * - one_to_many (child): the real FK lives on the CHILD entity and the
 *   catalog gives it no explicit name on the parent's own relationship
 *   entry. It is only knowable when the child entity is itself catalogued
 *   and documents a matching reverse parent/lookup edge back to this record
 *   type (e.g. `contact.company -> customer`); otherwise it is genuinely
 *   unknown and left as an empty-string sentinel rather than guessed.
 */
function toNetSuiteEdge(
  recordType: string,
  relationship: NetSuiteRelationship,
  netSuiteSchemaIntelligence: NetSuiteSchemaIntelligence,
): CardinalityEdge {
  const isChild = relationship.type === 'child';
  return {
    fromEntity: recordType,
    fromField: relationship.field,
    toEntity: relationship.relatedRecord,
    toField: isChild
      ? findNetSuiteChildForeignKeyField(netSuiteSchemaIntelligence, recordType, relationship.relatedRecord)
      : NETSUITE_IDENTITY_FIELD,
    cardinality: isChild ? 'one_to_many' : 'many_to_one',
    direction: 'source_to_target',
    required: relationship.required === true,
  };
}

/**
 * Derives the real child-side FK field for a `one_to_many` catalog edge by
 * looking at the CHILD entity's own catalogued relationships for a
 * parent/lookup edge pointing back at `parentRecordType`. Never fuzzy —
 * returns `''` (a loud, obviously-absent sentinel) when the child entity
 * carries no such catalogued reverse edge, rather than guessing a plausible
 * field name.
 */
function findNetSuiteChildForeignKeyField(
  netSuiteSchemaIntelligence: NetSuiteSchemaIntelligence,
  parentRecordType: string,
  childRecordType: string,
): string {
  const childRelationships = netSuiteSchemaIntelligence.getRecordRelationships(childRecordType);
  const reverseEdge = childRelationships.find(
    (candidate) =>
      (candidate.type === 'parent' || candidate.type === 'lookup') &&
      candidate.relatedRecord === parentRecordType,
  );
  return reverseEdge?.field ?? '';
}

/**
 * Salesforce orientation (load-bearing, per task brief): the parent's
 * childRelationships entry describes children pointing back via the FK.
 * SchemaDiscoveryService's SchemaRelationship (an existing, differently-named
 * shape) already carries both halves: `sourceField` is the FK field that
 * lives on the CHILD, and `targetField` is the relationshipName Salesforce
 * exposes for traversal FROM the parent (e.g. the "Contacts" in
 * `SELECT (SELECT Id FROM Contacts) FROM Account`). A mapping path walks the
 * parent by that traversal name, so it becomes the edge's `fromField`; the
 * real foreign key becomes `toField`.
 */
function toSalesforceEdge(parentEntity: string, relationship: SchemaRelationship): CardinalityEdge {
  return {
    fromEntity: parentEntity,
    fromField: relationship.targetField,
    toEntity: relationship.targetEntity,
    toField: relationship.sourceField,
    cardinality: relationship.type === 'many-to-one' ? 'many_to_one' : 'one_to_many',
    direction: 'source_to_target',
    required: false,
  };
}
