import {
  deploymentOptionsKnowledgeNodes,
  getDeploymentOptionsKnowledgeNode,
} from '../../../../src/services/help/deploymentOptionsKnowledgeManifest';

describe('deploymentOptionsKnowledgeManifest', () => {
  it('has the expected public dashboard nodes', () => {
    expect(deploymentOptionsKnowledgeNodes).toHaveLength(11);

    const expectedIds = [
      'tier-0-observe-assist',
      'tier-1-governance-overlay',
      'tier-2-enhance-synccentral',
      'tier-3-embedded-host',
      'tier-4-marketplace-listing',
      'tier-5-full-native-app',
      'squire-product-fit',
      'netsuite-path',
      'business-central-path',
      'governance-data-custody',
      'pilot-gates',
    ];

    for (const id of expectedIds) {
      expect(getDeploymentOptionsKnowledgeNode(id)?.id).toBe(id);
    }
  });

  it('has unique IDs and valid related-node references', () => {
    const ids = deploymentOptionsKnowledgeNodes.map((node) => node.id);
    const knownIds = new Set(ids);

    expect(knownIds.size).toBe(ids.length);
    for (const node of deploymentOptionsKnowledgeNodes) {
      for (const related of node.relatedNodeIds) {
        expect(knownIds.has(related)).toBe(true);
      }
    }
  });

  it('keeps deployment dashboard enrichment public-safe', () => {
    for (const node of deploymentOptionsKnowledgeNodes) {
      expect(node.sourceFiles).toEqual([]);
      expect(node.testFiles).toEqual([]);
      expect(node.auditCommands).toEqual([]);
      expect(node.publicSummary).not.toMatch(/\bsrc\//);
      expect(node.internalSummary).not.toMatch(/\bsrc\//);
    }
  });

  it('returns undefined for an unknown node', () => {
    expect(getDeploymentOptionsKnowledgeNode('does-not-exist')).toBeUndefined();
  });
});
