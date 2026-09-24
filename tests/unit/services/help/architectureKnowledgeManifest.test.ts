import {
  architectureKnowledgeNodes,
  getArchitectureKnowledgeNode,
} from '../../../../src/services/help/architectureKnowledgeManifest';

/**
 * Mirror-safe unit tests for architectureKnowledgeManifest.ts.
 *
 * These tests ONLY assert in-memory invariants derived from the exported
 * data — they do NOT read repo files from disk. This keeps them safe for
 * execution inside the reviewer snapshot, which ships src/** but not
 * docs/**, tests/e2e/**, or public/data/**.
 */
describe('architectureKnowledgeManifest', () => {
  describe('architectureKnowledgeNodes', () => {
    it('has exactly 7 nodes', () => {
      expect(architectureKnowledgeNodes).toHaveLength(7);
    });

    it('has unique IDs', () => {
      const ids = architectureKnowledgeNodes.map((n) => n.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it('every relatedNodeIds entry refers to an existing node ID', () => {
      const knownIds = new Set(architectureKnowledgeNodes.map((n) => n.id));
      for (const node of architectureKnowledgeNodes) {
        for (const related of node.relatedNodeIds) {
          expect(knownIds.has(related)).toBe(true);
        }
      }
    });

    it('every node has non-empty label, publicSummary, and internalSummary', () => {
      for (const node of architectureKnowledgeNodes) {
        expect(typeof node.label).toBe('string');
        expect(node.label.length).toBeGreaterThan(0);
        expect(typeof node.publicSummary).toBe('string');
        expect(node.publicSummary.length).toBeGreaterThan(0);
        expect(typeof node.internalSummary).toBe('string');
        expect(node.internalSummary.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getArchitectureKnowledgeNode', () => {
    it('returns the node for a known ID', () => {
      const node = getArchitectureKnowledgeNode('connector-integration-layer');
      expect(node).toBeDefined();
      expect(node?.id).toBe('connector-integration-layer');
    });

    it('returns undefined for an unknown ID', () => {
      const node = getArchitectureKnowledgeNode('does-not-exist');
      expect(node).toBeUndefined();
    });

    it('returns the correct node for each of the seven expected IDs', () => {
      const expectedIds = [
        'user-operator-surfaces',
        'http-api-edge',
        'core-application-services',
        'ai-intelligence',
        'governance-safety',
        'connector-integration-layer',
        'data-evidence-publishing',
      ];
      for (const id of expectedIds) {
        const node = getArchitectureKnowledgeNode(id);
        expect(node).toBeDefined();
        expect(node?.id).toBe(id);
      }
    });
  });
});
