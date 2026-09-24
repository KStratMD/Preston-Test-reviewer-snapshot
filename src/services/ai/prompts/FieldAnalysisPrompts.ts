/**
 * Prompt Engineering Templates for Semantic Field Analysis
 * 
 * These prompts are designed to work with LMStudio, OpenAI, Claude, and other LLM providers.
 * They use structured formats that encourage consistent, parseable responses.
 * 
 * @module FieldAnalysisPrompts
 */

import { PromptTemplate, BusinessContext, FieldDefinition } from '../../../types/semantic.types';

/**
 * System message for field mapping analysis
 */
export const FIELD_MAPPING_SYSTEM_MESSAGE = `You are an expert data integration specialist with deep knowledge of:
- Business system integration (Salesforce, NetSuite, SAP, Oracle, etc.)
- Industry standards and regulations (HIPAA, GDPR, SOX, ISO, HL7, etc.)
- Data modeling and semantic understanding
- Field mapping and transformation logic

Your role is to analyze field mappings and provide intelligent recommendations with:
1. Clear reasoning based on semantic understanding
2. Confidence scores reflecting certainty
3. Risk identification and mitigation
4. Compliance considerations
5. Practical transformation suggestions

Always respond in valid JSON format that can be parsed programmatically.`;

/**
 * Main field mapping analysis prompt template
 */
export const FIELD_MAPPING_PROMPT: PromptTemplate = {
  name: 'field_mapping_analysis',
  systemMessage: FIELD_MAPPING_SYSTEM_MESSAGE,
  temperature: 0.1, // Low temperature for consistency
  maxTokens: 2000,
  variables: ['sourceField', 'targetFields', 'context', 'samples'],
  template: `Analyze the semantic relationship between a source field and potential target fields.

SOURCE FIELD:
Name: {{sourceField.name}}
Type: {{sourceField.type}}
Description: {{sourceField.description}}
Sample Values: {{sourceField.samples}}
{{#if sourceField.constraints}}
Constraints: {{json sourceField.constraints}}
{{/if}}

TARGET FIELD CANDIDATES:
{{#each targetFields}}
{{@index}}. Name: {{name}}
   Type: {{type}}
   Description: {{description}}
   {{#if samples}}Sample Values: {{samples}}{{/if}}
{{/each}}

BUSINESS CONTEXT:
{{#if context.industry}}Industry: {{context.industry}}{{/if}}
{{#if context.process}}Process: {{context.process}}{{/if}}
{{#if context.regulations}}Regulations: {{join context.regulations ", "}}{{/if}}
Source System: {{context.sourceSystem}}
Target System: {{context.targetSystem}}

{{#if samples}}
SAMPLE DATA:
Source Samples: {{json samples.source}}
{{#if samples.target}}Target Samples: {{json samples.target}}{{/if}}
{{/if}}

Provide a comprehensive analysis in the following JSON format:

{
  "primaryMapping": {
    "targetFieldIndex": <index of best match from target fields list>,
    "confidence": <0-1 score>,
    "semanticSimilarity": <0-1 score>,
    "reasons": [
      "<reason 1>",
      "<reason 2>"
    ],
    "typeCompatibility": {
      "compatible": <boolean>,
      "confidence": <0-1>,
      "conversionNeeded": "<conversion type if any>",
      "dataLossRisk": "<none|low|medium|high>"
    },
    "transformationType": "<direct|lookup|calculation|concatenation|conditional|formatting|encryption|custom>"
  },
  "alternativeMappings": [
    {
      "targetFieldIndex": <index>,
      "confidence": <0-1>,
      "semanticSimilarity": <0-1>,
      "reasons": ["<reason>"],
      "typeCompatibility": { ... },
      "transformationType": "<type>"
    }
  ],
  "reasoning": "<detailed explanation of your analysis>",
  "confidence": <overall 0-1 score>,
  "risks": [
    {
      "severity": "<low|medium|high|critical>",
      "category": "<data_loss|pii_exposure|compliance|business_logic|performance>",
      "description": "<risk description>",
      "affectedFields": ["<field names>"],
      "mitigation": ["<mitigation step 1>", "<mitigation step 2>"]
    }
  ],
  "compliance": [
    {
      "regulation": "<regulation name>",
      "requirement": "<specific requirement>",
      "compliant": <boolean>,
      "actionsNeeded": ["<action 1>"],
      "severity": "<low|medium|high|critical>"
    }
  ],
  "transformation": {
    "type": "<transformation type>",
    "logic": "<detailed transformation logic>",
    "example": "<code example if helpful>",
    "config": { <transformation configuration> },
    "validation": [
      {
        "type": "<required|format|range|custom>",
        "description": "<validation description>",
        "expression": "<validation expression>",
        "errorMessage": "<error message>"
      }
    ]
  }
}

Analyze thoroughly considering:
1. Semantic meaning of field names and descriptions
2. Data type compatibility and conversion needs
3. Sample data patterns and formats
4. Business context and industry standards
5. Regulatory compliance requirements
6. Potential risks and data quality issues
7. Transformation complexity and maintainability`
};

/**
 * Simplified semantic similarity prompt (faster, lower cost)
 */
export const SEMANTIC_SIMILARITY_PROMPT: PromptTemplate = {
  name: 'semantic_similarity',
  systemMessage: FIELD_MAPPING_SYSTEM_MESSAGE,
  temperature: 0.1,
  maxTokens: 500,
  variables: ['field1', 'field2', 'context'],
  template: `Compare the semantic similarity between two fields.

FIELD 1:
Name: {{field1.name}}
Type: {{field1.type}}
{{#if field1.description}}Description: {{field1.description}}{{/if}}

FIELD 2:
Name: {{field2.name}}
Type: {{field2.type}}
{{#if field2.description}}Description: {{field2.description}}{{/if}}

{{#if context}}
CONTEXT: {{context}}
{{/if}}

Respond with JSON:
{
  "similarity": <0-1 score>,
  "explanation": "<brief explanation of similarity>",
  "confidence": <0-1 confidence in score>,
  "semanticRelationship": "<identical|alias|related|unrelated>",
  "reasons": ["<reason 1>", "<reason 2>"]
}

Consider:
- Semantic meaning (not just string matching)
- Industry terminology and aliases
- Business context alignment
- Type compatibility`
};

/**
 * Schema-level analysis prompt
 */
export const SCHEMA_ANALYSIS_PROMPT: PromptTemplate = {
  name: 'schema_analysis',
  systemMessage: FIELD_MAPPING_SYSTEM_MESSAGE,
  temperature: 0.1,
  maxTokens: 3000,
  variables: ['sourceSchema', 'targetSchema', 'context'],
  template: `Analyze the compatibility and mapping strategy between two schemas.

SOURCE SCHEMA:
Name: {{sourceSchema.name}}
System: {{sourceSchema.systemType}}
Entity: {{sourceSchema.entityName}}
Fields: {{sourceSchema.fields.length}} fields
{{#each sourceSchema.fields}}
- {{name}} ({{type}}){{#if description}}: {{description}}{{/if}}
{{/each}}

TARGET SCHEMA:
Name: {{targetSchema.name}}
System: {{targetSchema.systemType}}
Entity: {{targetSchema.entityName}}
Fields: {{targetSchema.fields.length}} fields
{{#each targetSchema.fields}}
- {{name}} ({{type}}){{#if description}}: {{description}}{{/if}}
{{/each}}

BUSINESS CONTEXT:
{{#if context.industry}}Industry: {{context.industry}}{{/if}}
{{#if context.process}}Process: {{context.process}}{{/if}}
Source System: {{context.sourceSystem}} → Target System: {{context.targetSystem}}

Provide a comprehensive schema analysis in JSON format:

{
  "overallCompatibility": <0-1 score>,
  "integrationStrategy": {
    "syncMode": "<realtime|batch|hybrid>",
    "syncFrequency": "<frequency if batch>",
    "errorHandling": "<fail_fast|continue_on_error|retry>",
    "validation": "<strict|relaxed|custom>",
    "optimizations": ["<optimization 1>", "<optimization 2>"],
    "reasoning": "<explanation of recommended strategy>"
  },
  "schemaRisks": [
    {
      "severity": "<low|medium|high|critical>",
      "category": "<data_loss|pii_exposure|compliance|business_logic|performance>",
      "description": "<risk description>",
      "affectedFields": ["<field names>"],
      "mitigation": ["<mitigation steps>"]
    }
  ],
  "recommendations": [
    "<recommendation 1>",
    "<recommendation 2>"
  ],
  "estimatedComplexity": "<low|medium|high>",
  "estimatedEffort": "<hours or days>"
}

Consider:
1. Field coverage and unmapped fields
2. Data model compatibility
3. Transformation complexity
4. Performance implications
5. Compliance requirements
6. Error handling needs
7. Testing strategy`
};

/**
 * Industry-specific field analysis prompt
 */
export const INDUSTRY_CONTEXT_PROMPT: PromptTemplate = {
  name: 'industry_context_analysis',
  systemMessage: FIELD_MAPPING_SYSTEM_MESSAGE,
  temperature: 0.1,
  maxTokens: 1500,
  variables: ['field', 'industry', 'regulations'],
  template: `Analyze a field in the context of industry-specific requirements.

FIELD:
Name: {{field.name}}
Type: {{field.type}}
{{#if field.description}}Description: {{field.description}}{{/if}}
{{#if field.samples}}Sample Values: {{field.samples}}{{/if}}

INDUSTRY: {{industry}}

REGULATIONS: {{join regulations ", "}}

Provide industry-specific analysis in JSON:

{
  "industryClassification": {
    "category": "<PII|PHI|PCI|financial|operational|administrative>",
    "sensitivity": "<public|internal|confidential|restricted>",
    "retention": "<retention requirements>"
  },
  "regulatoryRequirements": [
    {
      "regulation": "<regulation name>",
      "requirements": ["<requirement 1>", "<requirement 2>"],
      "mandatoryControls": ["<control 1>"],
      "auditNeeds": "<audit requirements>"
    }
  ],
  "industryStandards": {
    "standardName": "<standard if applicable>",
    "fieldFormat": "<expected format>",
    "commonAliases": ["<alias 1>", "<alias 2>"],
    "validationRules": ["<rule 1>"]
  },
  "securityConsiderations": {
    "encryptionRequired": <boolean>,
    "maskingRequired": <boolean>,
    "accessControl": "<access control needs>",
    "auditLogging": "<logging requirements>"
  },
  "recommendations": [
    "<recommendation 1>",
    "<recommendation 2>"
  ]
}

Consider industry-specific:
- Field naming conventions
- Data formats and standards
- Security requirements
- Compliance obligations
- Best practices`
};

/**
 * Transformation logic generation prompt
 */
export const TRANSFORMATION_LOGIC_PROMPT: PromptTemplate = {
  name: 'transformation_logic',
  systemMessage: FIELD_MAPPING_SYSTEM_MESSAGE,
  temperature: 0.2, // Slightly higher for creative transformation logic
  maxTokens: 1500,
  variables: ['sourceField', 'targetField', 'transformationType', 'samples'],
  template: `Generate detailed transformation logic for mapping between fields.

SOURCE FIELD:
Name: {{sourceField.name}}
Type: {{sourceField.type}}
{{#if sourceField.samples}}Sample Values: {{sourceField.samples}}{{/if}}

TARGET FIELD:
Name: {{targetField.name}}
Type: {{targetField.type}}
{{#if targetField.constraints}}Constraints: {{json targetField.constraints}}{{/if}}

TRANSFORMATION TYPE: {{transformationType}}

{{#if samples}}
SAMPLE DATA:
Source: {{json samples.source}}
Expected Target: {{json samples.target}}
{{/if}}

Generate transformation logic in JSON:

{
  "transformationSteps": [
    {
      "step": 1,
      "operation": "<operation name>",
      "description": "<what this step does>",
      "code": "<code example>"
    }
  ],
  "implementation": {
    "language": "typescript",
    "function": "<complete function code>",
    "dependencies": ["<dependency 1>"],
    "errorHandling": "<error handling approach>"
  },
  "validation": [
    {
      "rule": "<validation rule>",
      "expression": "<validation expression>",
      "errorMessage": "<error if validation fails>"
    }
  ],
  "testCases": [
    {
      "input": "<test input>",
      "expectedOutput": "<expected output>",
      "description": "<test case description>"
    }
  ],
  "edgeCases": [
    {
      "case": "<edge case description>",
      "handling": "<how to handle it>"
    }
  ],
  "performance": {
    "complexity": "<O(n) notation>",
    "considerations": ["<consideration 1>"]
  }
}

Provide production-ready, tested transformation logic.`
};

/**
 * Confidence scoring explanation prompt
 */
export const CONFIDENCE_EXPLANATION_PROMPT: PromptTemplate = {
  name: 'confidence_explanation',
  systemMessage: FIELD_MAPPING_SYSTEM_MESSAGE,
  temperature: 0.1,
  maxTokens: 800,
  variables: ['mapping', 'factors'],
  template: `Explain the confidence score for a field mapping recommendation.

MAPPING:
Source: {{mapping.source}} → Target: {{mapping.target}}
Confidence Score: {{mapping.confidence}}

CONTRIBUTING FACTORS:
Semantic Similarity: {{factors.semanticSimilarity}}
Type Compatibility: {{factors.typeCompatibility}}
Context Alignment: {{factors.contextAlignment}}
Historical Match: {{factors.historicalMatch}}
Sample Validation: {{factors.sampleValidation}}

Provide a clear explanation in JSON:

{
  "summary": "<one-sentence confidence summary>",
  "strengthFactors": [
    "<factor that increases confidence>"
  ],
  "weaknessFactors": [
    "<factor that decreases confidence>"
  ],
  "recommendation": "<use|review|reject>",
  "improvementSuggestions": [
    "<how to improve confidence>"
  ],
  "riskLevel": "<low|medium|high>"
}

Explain clearly why the confidence is at this level and what would improve it.`
};

/**
 * Helper function to get nested property value
 */
function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (current, key) => (current as Record<string, unknown> | null | undefined)?.[key],
    obj,
  );
}

/**
 * Helper function to populate template with variables
 * 
 * Supports Handlebars-style syntax:
 * - {{variable}} - Simple variable replacement
 * - {{object.property}} - Nested property access
 * - {{#if condition}}...{{/if}} - Conditionals
 * - {{#each array}}...{{/each}} - Loops with {{@index}}
 * - {{json variable}} - JSON.stringify helper
 * - {{join array ", "}} - Array join helper
 */
export function populateTemplate(
  template: PromptTemplate,
  variables: Record<string, unknown>
): string {
  let prompt = template.template;
  
  // Handle Handlebars helpers first (json, join)
  // {{json variable}} -> JSON.stringify(variable, null, 2)
  prompt = prompt.replace(/{{json\s+([\w.]+)}}/g, (match, path) => {
    const value = getNestedValue(variables, path);
    return value !== undefined ? JSON.stringify(value, null, 2) : '';
  });
  
  // {{join array ", "}} -> array.join(", ")
  prompt = prompt.replace(/{{join\s+([\w.]+)\s+"([^"]+)"}}/g, (match, path, separator) => {
    const value = getNestedValue(variables, path);
    return Array.isArray(value) ? value.join(separator) : '';
  });
  
  // Handle conditionals ({{#if condition}}...{{/if}})
  // Support nested properties like {{#if sourceField.constraints}}
  prompt = prompt.replace(/{{#if\s+([\w.]+)}}([\s\S]*?){{\/if}}/g, (match, condition, content) => {
    const value = getNestedValue(variables, condition);
    return value ? content : '';
  });
  
  // Handle loops ({{#each array}}...{{/each}})
  prompt = prompt.replace(/{{#each\s+(\w+)}}([\s\S]*?){{\/each}}/g, (match, arrayName, content) => {
    const array = variables[arrayName];
    if (!Array.isArray(array)) return '';
    
    return array.map((item, index) => {
      let itemContent = content;
      itemContent = itemContent.replace(/{{@index}}/g, String(index));
      
      // Replace item properties (simple and nested)
      const replaceItemProps = (str: string, obj: unknown, prefix = ''): string => {
        for (const [key, value] of Object.entries(obj)) {
          const propPath = prefix ? `${prefix}.${key}` : key;
          const placeholder = new RegExp(`{{${propPath}}}`, 'g');
          const stringValue = typeof value === 'string' ? value : 
                             value === null || value === undefined ? '' :
                             typeof value === 'object' ? JSON.stringify(value, null, 2) : 
                             String(value);
          str = str.replace(placeholder, stringValue);
          
          // Recursively handle nested objects
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            str = replaceItemProps(str, value, propPath);
          }
        }
        return str;
      };
      
      itemContent = replaceItemProps(itemContent, item);
      return itemContent;
    }).join('');
  });
  
  // Handle simple and nested variable replacement ({{variable}} or {{object.property}})
  const processedKeys = new Set<string>();
  
  // Find all {{...}} patterns and replace them
  prompt = prompt.replace(/{{\s*([\w.]+)\s*}}/g, (match, path) => {
    if (processedKeys.has(path)) return match;
    processedKeys.add(path);
    
    const value = getNestedValue(variables, path);
    if (value === undefined || value === null) return match; // Leave unresolved
    
    return typeof value === 'string' ? value : 
           typeof value === 'number' || typeof value === 'boolean' ? String(value) :
           JSON.stringify(value, null, 2);
  });
  
  return prompt;
}

/**
 * Validate that all required variables are provided
 */
export function validateTemplateVariables(
  template: PromptTemplate,
  variables: Record<string, unknown>
): { valid: boolean; missing: string[] } {
  const missing = template.variables.filter(v => !(v in variables));
  return {
    valid: missing.length === 0,
    missing
  };
}
