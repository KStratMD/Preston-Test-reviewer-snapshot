/**
 * Unit tests for Field Analysis Prompts
 * Tests prompt template population, validation, and structure
 */

import {
  FIELD_MAPPING_PROMPT,
  SEMANTIC_SIMILARITY_PROMPT,
  SCHEMA_ANALYSIS_PROMPT,
  INDUSTRY_CONTEXT_PROMPT,
  TRANSFORMATION_LOGIC_PROMPT,
  CONFIDENCE_EXPLANATION_PROMPT,
  populateTemplate,
  validateTemplateVariables
} from '../../../../../src/services/ai/prompts/FieldAnalysisPrompts';

describe('FieldAnalysisPrompts', () => {
  describe('Template Structure', () => {
    test('FIELD_MAPPING_PROMPT should have required properties', () => {
      expect(FIELD_MAPPING_PROMPT).toHaveProperty('name', 'field_mapping_analysis');
      expect(FIELD_MAPPING_PROMPT).toHaveProperty('template');
      expect(FIELD_MAPPING_PROMPT).toHaveProperty('systemMessage');
      expect(FIELD_MAPPING_PROMPT).toHaveProperty('variables');
      expect(FIELD_MAPPING_PROMPT.temperature).toBe(0.1);
      expect(FIELD_MAPPING_PROMPT.maxTokens).toBe(2000);
    });

    test('SEMANTIC_SIMILARITY_PROMPT should be configured for low cost', () => {
      expect(SEMANTIC_SIMILARITY_PROMPT).toHaveProperty('name', 'semantic_similarity');
      expect(SEMANTIC_SIMILARITY_PROMPT.temperature).toBe(0.1);
      expect(SEMANTIC_SIMILARITY_PROMPT.maxTokens).toBe(500); // Low token limit for cost
    });

    test('SCHEMA_ANALYSIS_PROMPT should have higher token limit', () => {
      expect(SCHEMA_ANALYSIS_PROMPT).toHaveProperty('name', 'schema_analysis');
      expect(SCHEMA_ANALYSIS_PROMPT.maxTokens).toBe(3000); // Higher for comprehensive analysis
    });

    test('TRANSFORMATION_LOGIC_PROMPT should allow more creativity', () => {
      expect(TRANSFORMATION_LOGIC_PROMPT).toHaveProperty('name', 'transformation_logic');
      expect(TRANSFORMATION_LOGIC_PROMPT.temperature).toBe(0.2); // Slightly higher for code generation
    });

    test('All prompts should have system messages', () => {
      expect(FIELD_MAPPING_PROMPT.systemMessage).toBeTruthy();
      expect(SEMANTIC_SIMILARITY_PROMPT.systemMessage).toBeTruthy();
      expect(SCHEMA_ANALYSIS_PROMPT.systemMessage).toBeTruthy();
      expect(INDUSTRY_CONTEXT_PROMPT.systemMessage).toBeTruthy();
      expect(TRANSFORMATION_LOGIC_PROMPT.systemMessage).toBeTruthy();
      expect(CONFIDENCE_EXPLANATION_PROMPT.systemMessage).toBeTruthy();
    });
  });

  describe('populateTemplate', () => {
    test('should replace simple variables', () => {
      const mockTemplate = {
        name: 'TEST',
        template: 'Hello {{name}}, your age is {{age}}',
        systemMessage: 'Test',
        variables: ['name', 'age'],
        temperature: 0.1,
        maxTokens: 100
      };
      const variables = { name: 'John', age: '30' };
      const result = populateTemplate(mockTemplate, variables);
      
      expect(result).toBe('Hello John, your age is 30');
    });

    test('should handle nested object variables with JSON stringify', () => {
      const mockTemplate = {
        name: 'TEST',
        template: 'Field: {{field}}',
        systemMessage: 'Test',
        variables: ['field'],
        temperature: 0.1,
        maxTokens: 100
      };
      const variables = {
        field: { name: 'email', type: 'string' }
      };
      const result = populateTemplate(mockTemplate, variables);
      
      expect(result).toContain('email');
      expect(result).toContain('string');
    });

    test('should handle array serialization', () => {
      const mockTemplate = {
        name: 'TEST',
        template: 'Fields: {{fields}}',
        systemMessage: 'Test',
        variables: ['fields'],
        temperature: 0.1,
        maxTokens: 100
      };
      const variables = {
        fields: ['name', 'email', 'phone']
      };
      const result = populateTemplate(mockTemplate, variables);
      
      expect(result).toContain('name');
      expect(result).toContain('email');
      expect(result).toContain('phone');
    });

    test('should leave missing variables as-is', () => {
      const mockTemplate = {
        name: 'TEST',
        template: 'Hello {{name}}, your age is {{age}}',
        systemMessage: 'Test',
        variables: ['name', 'age'],
        temperature: 0.1,
        maxTokens: 100
      };
      const variables = { name: 'John' };
      const result = populateTemplate(mockTemplate, variables);
      
      expect(result).toBe('Hello John, your age is {{age}}');
    });

    test('should handle complex field mapping template', () => {
      const variables = {
        sourceField: { name: 'customer_email', type: 'string' },
        targetFields: [
          { name: 'email_address', type: 'string' },
          { name: 'contact_email', type: 'string' }
        ],
        context: { industry: 'E-Commerce', regulations: ['GDPR'] }
      };

      const result = populateTemplate(FIELD_MAPPING_PROMPT, variables);
      
      expect(result).toContain('customer_email');
      expect(result).toContain('email_address');
      expect(result).toContain('E-Commerce');
      expect(result).toContain('GDPR');
    });
  });

  describe('validateTemplateVariables', () => {
    test('should pass when all required variables are present', () => {
      const mockTemplate = {
        name: 'TEST',
        template: 'Hello {{name}} {{age}}',
        systemMessage: 'Test',
        variables: ['name', 'age'],
        temperature: 0.1,
        maxTokens: 100
      };
      const providedVars = { name: 'John', age: '30', extra: 'ignored' };
      
      const result = validateTemplateVariables(mockTemplate, providedVars);
      
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    test('should fail when required variables are missing', () => {
      const mockTemplate = {
        name: 'TEST',
        template: 'Hello {{name}} {{age}} {{email}}',
        systemMessage: 'Test',
        variables: ['name', 'age', 'email'],
        temperature: 0.1,
        maxTokens: 100
      };
      const providedVars = { name: 'John' };
      
      const result = validateTemplateVariables(mockTemplate, providedVars);
      
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('age');
      expect(result.missing).toContain('email');
    });

    test('should handle empty variables array', () => {
      const mockTemplate = {
        name: 'TEST',
        template: 'Hello world',
        systemMessage: 'Test',
        variables: [],
        temperature: 0.1,
        maxTokens: 100
      };
      const result = validateTemplateVariables(mockTemplate, { name: 'John' });
      
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    test('should validate FIELD_MAPPING_PROMPT required variables', () => {
      const validVars = {
        sourceField: { name: 'email', type: 'string' },
        targetFields: [{ name: 'email_address', type: 'string' }],
        context: {},
        samples: { source: ['test@example.com'] }
      };

      const result = validateTemplateVariables(
        FIELD_MAPPING_PROMPT,
        validVars
      );

      expect(result.valid).toBe(true);
    });
  });

  describe('Prompt Content Quality', () => {
    test('FIELD_MAPPING_PROMPT should request JSON output', () => {
      expect(FIELD_MAPPING_PROMPT.template).toContain('JSON');
      expect(FIELD_MAPPING_PROMPT.template).toContain('confidence');
      expect(FIELD_MAPPING_PROMPT.template).toContain('reasoning');
    });

    test('SEMANTIC_SIMILARITY_PROMPT should ask for similarity score', () => {
      expect(SEMANTIC_SIMILARITY_PROMPT.template).toContain('similarity');
      expect(SEMANTIC_SIMILARITY_PROMPT.template).toContain('<0-1 score>');
    });

    test('SCHEMA_ANALYSIS_PROMPT should request integration strategy', () => {
      expect(SCHEMA_ANALYSIS_PROMPT.template).toContain('integration');
      expect(SCHEMA_ANALYSIS_PROMPT.template).toContain('schema');
    });

    test('INDUSTRY_CONTEXT_PROMPT should mention regulations', () => {
      expect(INDUSTRY_CONTEXT_PROMPT.template).toContain('regulation');
      expect(INDUSTRY_CONTEXT_PROMPT.template).toContain('REGULATIONS');
    });

    test('System messages should establish expert persona', () => {
      expect(FIELD_MAPPING_PROMPT.systemMessage).toContain('expert');
      expect(SCHEMA_ANALYSIS_PROMPT.systemMessage).toContain('integration');
    });
  });

  describe('Prompt Consistency', () => {
    test('All prompts should use low temperature for consistency', () => {
      const prompts = [
        FIELD_MAPPING_PROMPT,
        SEMANTIC_SIMILARITY_PROMPT,
        SCHEMA_ANALYSIS_PROMPT,
        INDUSTRY_CONTEXT_PROMPT,
        CONFIDENCE_EXPLANATION_PROMPT
      ];

      prompts.forEach(prompt => {
        expect(prompt.temperature).toBeLessThanOrEqual(0.2);
      });
    });

    test('Token limits should be appropriate for task complexity', () => {
      // Simple tasks should have lower token limits
      expect(SEMANTIC_SIMILARITY_PROMPT.maxTokens).toBeLessThan(1000);
      
      // Complex tasks can have higher limits
      expect(SCHEMA_ANALYSIS_PROMPT.maxTokens).toBeGreaterThan(2000);
    });

    test('All prompts should have required variables defined', () => {
      const prompts = [
        FIELD_MAPPING_PROMPT,
        SEMANTIC_SIMILARITY_PROMPT,
        SCHEMA_ANALYSIS_PROMPT,
        INDUSTRY_CONTEXT_PROMPT,
        TRANSFORMATION_LOGIC_PROMPT,
        CONFIDENCE_EXPLANATION_PROMPT
      ];

      prompts.forEach(prompt => {
        expect(Array.isArray(prompt.variables)).toBe(true);
      });
    });
  });

  describe('Real-world Template Population', () => {
    test('should populate field mapping prompt with realistic data', () => {
      const variables = {
        sourceField: {
          name: 'customer_email',
          type: 'string',
          samples: ['john@example.com', 'jane@example.com'],
          constraints: { required: true, format: 'email' }
        },
        targetFields: [
          {
            name: 'email_address',
            type: 'string',
            samples: ['contact@company.com']
          },
          {
            name: 'primary_email',
            type: 'string',
            samples: ['user@domain.com']
          }
        ],
        context: {
          industry: 'Healthcare',
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          regulations: ['HIPAA', 'GDPR'],
          businessProcess: 'Patient data synchronization'
        }
      };

      const result = populateTemplate(FIELD_MAPPING_PROMPT, variables);

      // Verify all key information is included
      expect(result).toContain('customer_email');
      expect(result).toContain('email_address');
      expect(result).toContain('Healthcare');
      expect(result).toContain('HIPAA');
      expect(result).toContain('Salesforce');
      expect(result).toContain('NetSuite');
      expect(result.length).toBeGreaterThan(100); // Should be substantial
    });

    test('should populate similarity prompt efficiently', () => {
      const variables = {
        field1: { name: 'customer_email', type: 'string' },
        field2: { name: 'email_address', type: 'string' },
        context: 'CRM integration'
      };

      const result = populateTemplate(SEMANTIC_SIMILARITY_PROMPT, variables);

      expect(result).toContain('customer_email');
      expect(result).toContain('email_address');
      expect(result.length).toBeGreaterThan(100); // Should have content
      expect(result.length).toBeLessThan(700); // Should be reasonably concise
    });
  });
});
