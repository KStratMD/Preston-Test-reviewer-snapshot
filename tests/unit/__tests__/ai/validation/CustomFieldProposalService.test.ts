import 'reflect-metadata';
import { CustomFieldProposalService, type ProposalConfig } from '../../../../../src/services/ai/validation/CustomFieldProposalService';
import { RedFlagType, type UnmappableField } from '../../../../../src/services/ai/validation/UnmappableFieldDetectionService';

describe('CustomFieldProposalService', () => {
  let service: CustomFieldProposalService;

  beforeEach(() => {
    service = new CustomFieldProposalService();
  });

  describe('generateProposal', () => {
    it('generates NetSuite SDF proposal for string field (and includes BC by default)', async () => {
      const unmappableField: UnmappableField = {
        sourceField: { name: 'legacy_sys_id', type: 'string', description: 'Legacy system identifier', sampleValues: ['SF-12345', 'XL-98765'] },
        unmappableConfidence: 85,
        redFlags: [RedFlagType.VERY_LOW_CONFIDENCE, RedFlagType.NO_HISTORICAL_MATCH],
        bestAttempt: { targetField: 'id', confidence: 30, reason: 'Poor match' },
        customFieldRecommended: true
      };

      const proposal = await service.generateProposal(unmappableField, 'NetSuite', { includeTemplates: true });

      expect(proposal.sourceField).toBe('legacy_sys_id');
      expect(proposal.reasoning).toContain('Custom field');
      expect(proposal.netSuite).toBeDefined();
      expect(proposal.netSuite?.fieldId).toMatch(/custentity_legacy_sys_id/);
      expect(proposal.netSuite?.type).toBe('text');
      expect(proposal.netSuite?.sdfXmlTemplate).toContain('<?xml version');
      // Default behavior includes BC unless explicitly excluded
      expect(proposal.businessCentral).toBeDefined();
      expect(proposal.implementationNotes).toContain('NetSuite');
      expect(proposal.implementationNotes).toContain('Business Central');
      expect(proposal.validationWarnings).toBeUndefined();
    });

    it('generates Business Central AL proposal and PascalCases names with acronyms', async () => {
      const unmappableField: UnmappableField = {
        sourceField: { name: 'old_crm_score', type: 'number', description: 'Proprietary CRM scoring', sampleValues: ['87.5', '72.3'] },
        unmappableConfidence: 90,
        redFlags: [RedFlagType.VERY_LOW_CONFIDENCE, RedFlagType.NO_TYPE_COMPATIBILITY, RedFlagType.NO_HISTORICAL_MATCH],
        bestAttempt: { targetField: 'rating', confidence: 25, reason: 'No match' },
        customFieldRecommended: true
      };

      const proposal = await service.generateProposal(unmappableField, 'BusinessCentral', { includeTemplates: true });

      expect(proposal.sourceField).toBe('old_crm_score');
      expect(proposal.businessCentral).toBeDefined();
      expect(proposal.businessCentral?.fieldName).toBe('OldCRMScore');
      expect(proposal.businessCentral?.type).toBe('Decimal');
      expect(proposal.businessCentral?.alCode).toContain('tableextension');
      expect(proposal.businessCentral?.alCode).toContain('field(');
      expect(proposal.businessCentral?.fieldNo).toBeGreaterThanOrEqual(50000);
    });

    it('generates both specs when requested', async () => {
      const unmappableField: UnmappableField = {
        sourceField: { name: 'ext_ref_code', type: 'string', description: 'External reference code' },
        unmappableConfidence: 80,
        redFlags: [RedFlagType.LOW_SEMANTIC_SIMILARITY, RedFlagType.NO_HISTORICAL_MATCH],
        bestAttempt: { targetField: 'externalId', confidence: 35, reason: 'Weak match' },
        customFieldRecommended: true
      };

      const config: ProposalConfig = { includeNetSuite: true, includeBusinessCentral: true, generateCode: true, includeTemplates: true };
      const proposal = await service.generateProposal(unmappableField, 'NetSuite', config);

      expect(proposal.netSuite).toBeDefined();
      expect(proposal.businessCentral).toBeDefined();
      expect(proposal.netSuite?.sdfXmlTemplate).toContain('<?xml version');
      expect(proposal.businessCentral?.alCode).toContain('tableextension');
    });

    it('maps boolean and currency types appropriately', async () => {
      const boolField: UnmappableField = {
        sourceField: { name: 'custom_flag_xyz', type: 'boolean', description: 'Custom business flag', sampleValues: ['TRUE', 'FALSE'] },
        unmappableConfidence: 75,
        redFlags: [RedFlagType.LOW_SEMANTIC_SIMILARITY],
        bestAttempt: { targetField: 'active', confidence: 40, reason: 'Different semantic meaning' },
        customFieldRecommended: true
      };
      const currencyField: UnmappableField = {
        sourceField: { name: 'annual_revenue', type: 'currency', description: 'Annual revenue in USD', sampleValues: ['1250000', '850000'] },
        unmappableConfidence: 70,
        redFlags: [RedFlagType.NO_HISTORICAL_MATCH],
        bestAttempt: { targetField: 'revenue', confidence: 45, reason: 'Similar but different calculation' },
        customFieldRecommended: true
      };

      const p1 = await service.generateProposal(boolField, 'NetSuite');
      expect(p1.netSuite?.type).toBe('checkbox');
      expect(p1.businessCentral?.type).toBe('Boolean');

      const p2 = await service.generateProposal(currencyField, 'NetSuite');
      expect(p2.netSuite?.type).toBe('currency');
      expect(p2.businessCentral?.type).toBe('Decimal');
    });

    it('emits valid SDF XML and AL code when includeTemplates is true', async () => {
      const field: UnmappableField = {
        sourceField: { name: 'test_field_1', type: 'string', description: 'Test field' },
        unmappableConfidence: 85,
        redFlags: [RedFlagType.VERY_LOW_CONFIDENCE],
        bestAttempt: { targetField: 'field', confidence: 30, reason: 'Poor match' },
        customFieldRecommended: true
      };

      const ns = await service.generateProposal(field, 'NetSuite', { includeTemplates: true });
      const xml = ns.netSuite?.sdfXmlTemplate;
      expect(xml).toBeDefined();
      expect(xml).toContain('<?xml version');
      expect(xml).toContain('<customrecordcustomfield');
      expect(xml).toContain('</customrecordcustomfield>');

      const bc = await service.generateProposal(field, 'BusinessCentral', { includeTemplates: true });
      const al = bc.businessCentral?.alCode;
      expect(al).toBeDefined();
      expect(al).toContain('tableextension');
      expect(al).toContain('fields');
      expect(al).toContain('field(');
    });
  });
});
