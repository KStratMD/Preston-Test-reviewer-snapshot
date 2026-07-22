import 'reflect-metadata';
import { SemanticAnalyzer, type SemanticAnalysisConfig } from '../../services/ai/SemanticAnalyzer';
import type { FieldDefinition, NetSuiteSchema } from '../../services/ai/AIFieldMappingService';
import type { Logger } from '../../utils/Logger';

describe('SemanticAnalyzer', () => {
  let analyzer: SemanticAnalyzer;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    analyzer = new SemanticAnalyzer(mockLogger);
  });

  describe('analyzeFieldSemantics', () => {
    it('should find exact field name matches', async () => {
      const sourceField: FieldDefinition = {
        name: 'email',
        type: 'email',
        required: false,
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [
          { name: 'email', type: 'email', required: false },
          { name: 'phone', type: 'phone', required: false },
        ],
        customFields: [],
        relationships: [],
      };

      const matches = await analyzer.analyzeFieldSemantics(sourceField, targetSchema);

      expect(matches).toBeDefined();
      expect(matches.length).toBeGreaterThan(0);

      const exactMatch = matches.find(m => m.field === 'email');
      expect(exactMatch).toBeDefined();
      expect(exactMatch?.score).toBeGreaterThan(0.9);
      expect(exactMatch?.matchType).toBe('exact');
    });

    it('should find partial field name matches', async () => {
      const sourceField: FieldDefinition = {
        name: 'CompanyName',
        type: 'string',
        required: true,
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [
          { name: 'companyname', type: 'string', required: true },
        ],
        customFields: [],
        relationships: [],
      };

      const matches = await analyzer.analyzeFieldSemantics(sourceField, targetSchema);

      expect(matches.length).toBeGreaterThan(0);

      const partialMatch = matches.find(m => m.field === 'companyname');
      expect(partialMatch).toBeDefined();
      expect(partialMatch?.score).toBeGreaterThan(0.7);
      expect(partialMatch?.matchType).toBe('exact');
    });

    it('should find synonym matches', async () => {
      const sourceField: FieldDefinition = {
        name: 'client',
        type: 'string',
        required: false,
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [
          { name: 'customer', type: 'string', required: false },
        ],
        customFields: [],
        relationships: [],
      };

      const matches = await analyzer.analyzeFieldSemantics(sourceField, targetSchema);

      expect(matches.length).toBeGreaterThan(0);

      const synonymMatch = matches.find(m => m.field === 'customer');
      expect(synonymMatch).toBeDefined();
      expect(synonymMatch?.score).toBeGreaterThan(0.6);
      expect(synonymMatch?.matchType).toBe('synonym');
    });

    it('should analyze custom fields with labels', async () => {
      const sourceField: FieldDefinition = {
        name: 'Industry',
        type: 'string',
        required: false,
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [],
        customFields: [
          {
            id: 'custentity_industry',
            label: 'Industry Classification',
            type: 'string',
            recordType: 'customer',
          },
        ],
        relationships: [],
      };

      const matches = await analyzer.analyzeFieldSemantics(sourceField, targetSchema);

      expect(matches.length).toBeGreaterThan(0);

      const customMatch = matches.find(m => m.field === 'custentity_industry');
      expect(customMatch).toBeDefined();
      expect(customMatch?.score).toBeGreaterThan(0.5);
    });

    it('should handle fields with help text', async () => {
      const sourceField: FieldDefinition = {
        name: 'revenue',
        type: 'number',
        required: false,
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [],
        customFields: [
          {
            id: 'custentity_annual_revenue',
            label: 'Annual Revenue',
            type: 'number',
            helpText: 'Annual revenue for this customer account',
            recordType: 'customer',
          },
        ],
        relationships: [],
      };

      const matches = await analyzer.analyzeFieldSemantics(sourceField, targetSchema);

      expect(matches.length).toBeGreaterThan(0);

      const helpTextMatch = matches.find(m => m.field === 'custentity_annual_revenue');
      expect(helpTextMatch).toBeDefined();
      expect(helpTextMatch?.score).toBeGreaterThan(0.5);
    });

    it('should respect minimum confidence threshold', async () => {
      analyzer.updateConfiguration({ minimumConfidenceThreshold: 0.8 });

      const sourceField: FieldDefinition = {
        name: 'randomfield',
        type: 'string',
        required: false,
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [
          { name: 'completelydifferent', type: 'string', required: false },
        ],
        customFields: [],
        relationships: [],
      };

      const matches = await analyzer.analyzeFieldSemantics(sourceField, targetSchema);

      // Should return fewer matches due to higher threshold
      expect(matches.every(m => m.score >= 0.8)).toBe(true);
    });
  });

  describe('configuration management', () => {
    it('should update configuration', () => {
      const newConfig: Partial<SemanticAnalysisConfig> = {
        enableSynonymMatching: false,
        minimumConfidenceThreshold: 0.9,
      };

      analyzer.updateConfiguration(newConfig);

      const currentConfig = analyzer.getConfiguration();
      expect(currentConfig.enableSynonymMatching).toBe(false);
      expect(currentConfig.minimumConfidenceThreshold).toBe(0.9);
    });

    it('should add custom business terminology', () => {
      analyzer.addBusinessTerminology('revenue', ['income', 'earnings'], ['profit', 'sales']);

      // This is more of an integration test - the functionality is tested through semantic analysis
      expect(() => analyzer.addBusinessTerminology('revenue', ['income', 'earnings'], ['profit', 'sales'])).not.toThrow();
    });

    it('should add custom NetSuite mappings', () => {
      analyzer.addNetSuiteMapping('custentity_test', ['test', 'testing', 'demo']);

      expect(() => analyzer.addNetSuiteMapping('custentity_test', ['test', 'testing', 'demo'])).not.toThrow();
    });
  });

  describe('context analysis', () => {
    it('should analyze field context including types and descriptions', async () => {
      const sourceField: FieldDefinition = {
        name: 'user_email',
        type: 'email',
        required: true,
        maxLength: 255,
        description: 'Primary email address for user communication',
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [
          {
            name: 'email',
            type: 'email',
            required: true,
            maxLength: 254,
            description: 'Customer email address for correspondence',
          },
        ],
        customFields: [],
        relationships: [],
      };

      const matches = await analyzer.analyzeFieldSemantics(sourceField, targetSchema);

      expect(matches.length).toBeGreaterThan(0);

      const contextMatch = matches.find(m => m.field === 'email');
      expect(contextMatch).toBeDefined();
      // Should have high confidence due to type, description, and name similarity
      expect(contextMatch?.score).toBeGreaterThan(0.8);
    });

    it('should handle type compatibility', async () => {
      const sourceField: FieldDefinition = {
        name: 'phone_number',
        type: 'string',
        required: false,
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [
          { name: 'phone', type: 'phone', required: false },
        ],
        customFields: [],
        relationships: [],
      };

      const matches = await analyzer.analyzeFieldSemantics(sourceField, targetSchema);

      expect(matches.length).toBeGreaterThan(0);

      const phoneMatch = matches.find(m => m.field === 'phone');
      expect(phoneMatch).toBeDefined();
      expect(phoneMatch?.score).toBeGreaterThan(0.6);
    });
  });

  describe('edge cases', () => {
    it('should handle empty target schema', async () => {
      const sourceField: FieldDefinition = {
        name: 'test',
        type: 'string',
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [],
        customFields: [],
        relationships: [],
      };

      const matches = await analyzer.analyzeFieldSemantics(sourceField, targetSchema);

      expect(matches).toBeDefined();
      expect(Array.isArray(matches)).toBe(true);
      expect(matches.length).toBe(0);
    });

    it('should handle special characters in field names', async () => {
      const sourceField: FieldDefinition = {
        name: 'email_address_primary',
        type: 'email',
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [
          { name: 'email', type: 'email' },
        ],
        customFields: [],
        relationships: [],
      };

      const matches = await analyzer.analyzeFieldSemantics(sourceField, targetSchema);

      expect(matches.length).toBeGreaterThan(0);

      const emailMatch = matches.find(m => m.field === 'email');
      expect(emailMatch).toBeDefined();
      expect(emailMatch?.score).toBeGreaterThan(0.5);
    });

    it('should handle case-insensitive matching', async () => {
      const sourceField: FieldDefinition = {
        name: 'EMAIL',
        type: 'email',
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [
          { name: 'email', type: 'email' },
        ],
        customFields: [],
        relationships: [],
      };

      const matches = await analyzer.analyzeFieldSemantics(sourceField, targetSchema);

      expect(matches.length).toBeGreaterThan(0);

      const emailMatch = matches.find(m => m.field === 'email');
      expect(emailMatch).toBeDefined();
      expect(emailMatch?.score).toBeGreaterThan(0.9);
    });
  });
});
