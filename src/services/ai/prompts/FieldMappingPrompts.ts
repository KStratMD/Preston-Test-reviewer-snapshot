/**
 * Optimized Field Mapping Prompts - Phase 1 Accuracy Improvements
 * Target: 90-95% accuracy (up from 75-82%)
 *
 * Improvements:
 * - Advanced prompt engineering
 * - Few-shot learning with examples
 * - Enhanced field metadata
 * - Structured reasoning requirements
 */
import { getRecordValues } from '../utils/dataRecord';

export interface FieldMetadata {
  name: string;
  type?: string;
  description?: string;
  sampleValues?: unknown[];
  nullable?: boolean;
  unique?: boolean;
  format?: string;
}

export interface FewShotExample {
  sourceField: string;
  sourceFields?: string[]; // For multi-field mappings (e.g., firstName + lastName → fullName)
  sourceType?: string;
  targetField: string;
  targetType?: string;
  transformationType: string;
  confidence: number;
  reasoning: string;
}

/**
 * Few-shot examples for common mapping patterns
 * These teach the AI model correct mapping behavior
 */
export const COMMON_MAPPING_EXAMPLES: FewShotExample[] = [
  {
    sourceField: 'customer_email',
    sourceType: 'string',
    targetField: 'email',
    targetType: 'string',
    transformationType: 'direct',
    confidence: 100,
    reasoning: 'Exact semantic match. Both fields represent primary email address. Direct string-to-string mapping.'
  },
  {
    sourceField: 'full_name',
    sourceType: 'string',
    targetField: 'firstName',
    targetType: 'string',
    transformationType: 'concatenation',
    confidence: 95,
    reasoning: 'Source contains combined name, target requires split. Need transformation to extract first part before space.'
  },
  {
    sourceField: 'firstName',
    sourceFields: ['firstName', 'lastName'], // Multi-field mapping: combine two fields
    sourceType: 'string',
    targetField: 'fullName',
    targetType: 'string',
    transformationType: 'concatenation',
    confidence: 98,
    reasoning: 'Multiple source fields combine into single target. firstName + lastName → fullName with space separator. Common name consolidation pattern.'
  },
  {
    sourceField: 'account_id',
    sourceType: 'string',
    targetField: 'entityId',
    targetType: 'integer',
    transformationType: 'lookup',
    confidence: 90,
    reasoning: 'Source is string ID, target is integer reference. Requires lookup transformation to map external ID to internal entity reference.'
  },
  {
    sourceField: 'phone_number',
    sourceType: 'string',
    targetField: 'phone',
    targetType: 'string',
    transformationType: 'direct',
    confidence: 98,
    reasoning: 'Strong semantic match with minor name variation. Both represent phone contact. May need format normalization but direct mapping.'
  },
  {
    sourceField: 'created_date',
    sourceType: 'string',
    targetField: 'createdAt',
    targetType: 'datetime',
    transformationType: 'calculation',
    confidence: 92,
    reasoning: 'Semantic match for creation timestamp. Source is string, target is datetime. Requires date parsing transformation.'
  },
  {
    sourceField: 'F1rst Name',
    sourceType: 'string',
    targetField: 'firstName',
    targetType: 'string',
    transformationType: 'direct',
    confidence: 78,
    reasoning: 'Messy field name with typo (F1rst→First). Sample values ["John", "Jane", "Bob"] confirm this is first name data. Direct mapping despite typo.'
  },
  {
    sourceField: 'cmpny_name',
    sourceType: 'string',
    targetField: 'companyName',
    targetType: 'string',
    transformationType: 'direct',
    confidence: 82,
    reasoning: 'Abbreviated field name (cmpny→company). Sample values ["Acme Corp", "Globex Inc"] confirm company name. Direct mapping.'
  },
  {
    sourceField: 'ph#',
    sourceType: 'string',
    targetField: 'phone',
    targetType: 'string',
    transformationType: 'direct',
    confidence: 75,
    reasoning: 'Messy abbreviation with special char (ph#→phone). Sample values ["555-1234", "(212) 555-9876"] confirm phone numbers. Direct mapping.'
  },
  {
    sourceField: 'billing_address',
    sourceType: 'string',
    targetField: 'billingAddress',
    targetType: 'string',
    transformationType: 'direct',
    confidence: 95,
    reasoning: 'Direct address field match. Both represent complete billing address. Source uses snake_case, target uses camelCase. Sample values ["123 Main St, City, ST 12345"] confirm full addresses.'
  },
  {
    sourceField: 'shipping_address',
    sourceType: 'string',
    targetField: 'shippingAddress',
    targetType: 'string',
    transformationType: 'direct',
    confidence: 95,
    reasoning: 'Direct address field match. Both represent complete shipping/delivery address. Source uses snake_case, target uses camelCase. Sample values ["456 Oak Ave, Town, ST 67890"] confirm full addresses.'
  },
  {
    sourceField: 'street',
    sourceFields: ['street', 'city'],
    sourceType: 'string',
    targetField: 'fullAddress',
    targetType: 'string',
    transformationType: 'concatenation',
    confidence: 75,
    reasoning: 'Multi-field partial address concatenation. Combine street + city → fullAddress with comma separator. Partial address (2/4 components) - medium confidence. Common for international addresses without state/zip.'
  },
  {
    sourceField: 'street',
    sourceFields: ['street', 'city', 'state', 'zip'],
    sourceType: 'string',
    targetField: 'fullAddress',
    targetType: 'string',
    transformationType: 'concatenation',
    confidence: 90,
    reasoning: 'Multi-field complete address concatenation. Combine all 4 address components (street, city, state, zip) → fullAddress. Standard US address pattern with high confidence.'
  }
];

/**
 * System-specific mapping knowledge
 */
export const SYSTEM_MAPPING_RULES: Record<string, { targetSystem: string; rules: string[] }> = {
  'salesforce-netsuite': {
    targetSystem: 'NetSuite',
    rules: [
      'Salesforce "Account" maps to NetSuite "Customer" entity',
      'Salesforce "Contact" can map to NetSuite "Contact" or "Employee"',
      'ID fields in Salesforce (18-char) need lookup to NetSuite internalId (integer)',
      'Email fields map directly but must validate format',
      'Phone fields should normalize to E.164 format for NetSuite',
      'Date fields in Salesforce are ISO 8601, NetSuite expects MM/DD/YYYY',
      'Currency fields need proper decimal handling (Salesforce uses Decimal, NetSuite uses Float)'
    ]
  },
  'businesscentral-netsuite': {
    targetSystem: 'NetSuite',
    rules: [
      'Business Central "Customer" maps to NetSuite "Customer"',
      'BC "No." field is primary key, maps to NetSuite "entityId" with lookup',
      'BC uses Windows-style dates, NetSuite needs MM/DD/YYYY conversion',
      'BC currency fields are Decimal(18,2), NetSuite Float',
      'BC "Contact No." requires relationship lookup to NetSuite Contact',
      'BC "E-Mail" field maps directly to NetSuite "email"'
    ]
  }
};

/**
 * Build optimized field mapping prompt with few-shot learning
 */
export function buildOptimizedFieldMappingPrompt(
  sourceSystem: string,
  targetSystem: string,
  sourceFields: FieldMetadata[],
  sampleData: unknown[]
): string {
  // Get system-specific rules if available
  const systemKey = `${sourceSystem.toLowerCase()}-${targetSystem.toLowerCase()}`;
  const systemRules = SYSTEM_MAPPING_RULES[systemKey];

  // Format few-shot examples
  const examplesText = COMMON_MAPPING_EXAMPLES.map((ex, idx) =>
    `EXAMPLE ${idx + 1}:
Source Field: "${ex.sourceField}" (${ex.sourceType || 'unknown'})
Target Field: "${ex.targetField}" (${ex.targetType || 'unknown'})
Transformation: ${ex.transformationType}
Confidence: ${ex.confidence}%
Reasoning: ${ex.reasoning}`
  ).join('\n\n');

  // Format source fields with metadata
  const fieldsWithMetadata = sourceFields.map(f => {
    const samples = getRecordValues(sampleData, f.name).slice(0, 3);
    const samplesText = samples.filter(v => v !== undefined && v !== null)
      .slice(0, 3)
      .map(v => JSON.stringify(v))
      .join(', ');

    return `  • "${f.name}"${f.type ? ` (${f.type})` : ''}${f.description ? `: ${f.description}` : ''}
    Samples: [${samplesText || 'no data'}]`;
  }).join('\n');

  // Build the optimized prompt
  return `You are an expert data integration engineer with deep expertise in ${sourceSystem} and ${targetSystem} systems.

TASK: Analyze source fields and suggest accurate field mappings to the target system.

CONTEXT:
- Source System: ${sourceSystem}
- Target System: ${targetSystem}
- Record Type: Business records (customers, orders, products, etc.)
- Integration Pattern: ${sourceSystem} → ${targetSystem} data synchronization

${systemRules ? `SYSTEM-SPECIFIC RULES FOR ${sourceSystem} → ${targetSystem}:
${systemRules.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}
` : ''}
LEARNING EXAMPLES (How to map fields correctly):

${examplesText}

SOURCE FIELDS TO MAP:
${fieldsWithMetadata}

REQUIREMENTS:
1. Analyze field names, data types, AND sample values together
2. Consider semantic meaning, not just name similarity
3. Provide confidence score (0-100%) based on certainty
4. Explain your reasoning for each mapping
5. Flag any ambiguous or risky mappings
6. Suggest appropriate transformation types

TRANSFORMATION TYPES:
- direct: Field maps 1:1 with no changes (e.g., email → email)
- lookup: Requires ID translation (e.g., accountId → entityId)
- calculation: Needs computation (e.g., date format conversion)
- concatenation: Combine/split fields (e.g., fullName → firstName + lastName)
- conditional: Logic-based mapping (e.g., if status='active' then active=true)
- custom: Complex transformation requiring business logic

RESPONSE FORMAT (JSON):
{
  "suggestions": [
    {
      "sourceField": "field_name",
      "sourceFields": ["field1", "field2"], // OPTIONAL: Use for multi-field mappings (e.g., firstName + lastName → fullName)
      "targetField": "suggested_target",
      "transformationType": "direct|lookup|calculation|concatenation|conditional|custom",
      "confidence": 95,
      "reasoning": "Clear explanation: Why this mapping makes sense based on semantic meaning, data types, and sample values"
    }
  ]
}

MULTI-FIELD MAPPING INSTRUCTIONS:
- When multiple source fields should combine into ONE target field, use "sourceFields" array
- Example: firstName + lastName → fullName: { "sourceField": "firstName", "sourceFields": ["firstName", "lastName"], "targetField": "fullName", "transformationType": "concatenation" }
- Common patterns: name combination, address concatenation, date+time merging
- IMPORTANT: Always check if separate fields (firstName, lastName) can combine into a full field (fullName)

MESSY DATA HANDLING:
⚠️ IMPORTANT: Real-world data often contains messy field names. You MUST handle:
- Typos: "F1rst Name" (1→i), "emaail" (double a), "ph#" (special chars)
- Abbreviations: "cmpny" (company), "ph" (phone), "cty" (city), "cntry" (country)
- Variations: "bill_addr" (billing address), "ship_cty" (shipping city), "ST" (state)
- Mixed case: "EMPLOYEE_CNT", "Last_Name", "ZIP"
- Special chars: "rev$" (revenue), "dept." (department), "ACTVE?" (active)

FOR MESSY FIELDS: Use contextual understanding and sample data to infer correct meaning.
Suggest mappings even if field name is messy - confidence should reflect your certainty about the MEANING, not the cleanliness of the name.

CONFIDENCE SCORING GUIDELINES:
- 95-100%: Exact semantic match, compatible types, verified by sample values
- 85-94%: Strong semantic match, types compatible with minor transformation
- 75-84%: Good semantic similarity, some uncertainty in transformation
- 65-74%: Messy field name but clear intent from context/samples, requires validation
- 60-64%: Unclear field name but reasonable match based on samples/patterns
- Below 60%: DO NOT suggest - too uncertain even with context

REASONING REQUIREMENTS:
- Must reference field names, types, and sample values
- Must explain transformation logic if not direct
- Must flag any concerns or validation needs

QUALITY STANDARDS:
✓ Suggest mappings with confidence ≥ 60% (lower for messy but interpretable fields)
✓ Prioritize semantic meaning over name cleanliness - messy names are common in real data
✓ Use sample data values to infer meaning when field names are unclear
✓ Consider data type compatibility
✓ Flag potential data loss scenarios
✓ Suggest transformations to preserve data integrity

Analyze the source fields above and provide your mapping suggestions now.`;
}

/**
 * Build optimized quality assessment prompt
 */
export function buildOptimizedQualityPrompt(
  suggestions: { sourceField: string; targetField: string; transformationType: string }[],
  sourceSystem: string,
  targetSystem: string
): string {
  const mappingSummary = suggestions.map((s, idx) =>
    `${idx + 1}. ${s.sourceField} → ${s.targetField} (transformation: ${s.transformationType})`
  ).join('\n');

  return `You are a data quality expert evaluating integration mappings between ${sourceSystem} and ${targetSystem}.

TASK: Assess the quality and completeness of these field mapping suggestions.

MAPPINGS TO EVALUATE:
${mappingSummary}

EVALUATION CRITERIA:
1. **Completeness** (25 points)
   - Are all critical business fields mapped?
   - Are there obvious missing mappings?
   - Is coverage sufficient for the use case?

2. **Accuracy** (25 points)
   - Do field semantics match correctly?
   - Are data types compatible?
   - Are transformations appropriate?

3. **Risk Assessment** (25 points)
   - Potential data loss scenarios?
   - Complex transformations that may fail?
   - Missing validation or error handling?

4. **Best Practices** (25 points)
   - Following integration patterns?
   - Proper transformation types selected?
   - Maintainability and clarity?

RESPONSE FORMAT (JSON):
{
  "overallScore": 0.85,
  "scores": {
    "completeness": 0.90,
    "accuracy": 0.85,
    "risk": 0.80,
    "bestPractices": 0.85
  },
  "analysis": {
    "strengths": [
      "List specific strong points"
    ],
    "weaknesses": [
      "List specific issues or gaps"
    ],
    "risks": [
      "List potential integration risks"
    ]
  },
  "recommendations": [
    "Specific actionable improvements"
  ]
}

Provide a thorough, objective assessment. Be critical where needed to ensure integration success.`;
}

/**
 * Build prompt for confidence scoring
 */
export function buildConfidencePrompt(
  sourceField: string,
  targetField: string,
  sourceType: string,
  targetType: string,
  sampleValues: unknown[]
): string {
  const samplesText = sampleValues.slice(0, 5)
    .filter(v => v !== undefined && v !== null)
    .map(v => JSON.stringify(v))
    .join(', ');

  return `Evaluate the confidence level for this field mapping:

SOURCE: "${sourceField}" (type: ${sourceType})
Sample values: [${samplesText}]

TARGET: "${targetField}" (type: ${targetType})

FACTORS TO CONSIDER:
1. Semantic similarity of field names
2. Data type compatibility
3. Sample value patterns
4. Common integration patterns
5. Potential data loss or transformation complexity

RESPONSE FORMAT (JSON):
{
  "confidence": 0.95,
  "reasoning": "Detailed explanation of confidence level",
  "concerns": ["List any concerns or caveats"],
  "transformation_needed": "none|simple|complex"
}

Provide honest confidence score (0-100%). Be conservative - better to flag uncertainty than overstate confidence.`;
}

/**
 * Extract field metadata from sample data
 */
export function extractFieldMetadata(sampleData: unknown[]): FieldMetadata[] {
  if (!sampleData || sampleData.length === 0) return [];

  const firstRecord = sampleData[0];
  const fields: FieldMetadata[] = [];

  for (const [name, value] of Object.entries(firstRecord)) {
    const allValues = sampleData.map(r => (r as Record<string, unknown>)[name]).filter(v => v !== undefined && v !== null);

    fields.push({
      name,
      type: inferType(value),
      sampleValues: allValues.slice(0, 3),
      nullable: allValues.length < sampleData.length,
      unique: new Set(allValues).size === allValues.length
    });
  }

  return fields;
}

/**
 * Infer data type from value
 */
function inferType(value: unknown): string {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'string') {
    // Check for special formats
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
    if (/^[\w-\.]+@[\w-\.]+\.\w+$/.test(value)) return 'email';
    if (/^\+?[\d\s\-\(\)]+$/.test(value)) return 'phone';
    return 'string';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'decimal';
  }
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'unknown';
}

/**
 * Build prompt for LLM-powered classification of unmappable fields
 * Categorizes fields as business_field, system_metadata, technical_field, or garbage
 */
export function buildUnmappableClassificationPrompt(
  fieldName: string,
  fieldType: string,
  description: string | undefined,
  sampleValues: unknown[],
  sourceSystem: string,
  targetSystem: string,
  unmappableConfidence: number,
  redFlagTypes: string[]
): string {
  const samplesStr = sampleValues.slice(0, 5).map(v =>
    typeof v === 'string' ? `"${v}"` : JSON.stringify(v)
  ).join(', ');

  return `You are an expert data integration analyst. Classify this unmappable field into one of four categories.

**Context:**
- Source System: ${sourceSystem}
- Target System: ${targetSystem}
- Field Name: ${fieldName}
- Field Type: ${fieldType}
- Description: ${description || 'Not provided'}
- Sample Values: [${samplesStr}]
- Unmappable Confidence: ${unmappableConfidence}%
- Red Flags: ${redFlagTypes.join(', ') || 'None'}

**Categories:**

1. **business_field**: Contains meaningful business data that should be preserved
   - Examples: customer_loyalty_tier, custom_discount_code, special_handling_instructions
   - Indicators: Business domain vocabulary, human-readable values, customer/product/order related

2. **system_metadata**: Internal system tracking and audit data
   - Examples: created_by, modified_date, version, last_sync_time, record_owner_id
   - Indicators: Audit trail fields, timestamps, user IDs, version numbers, modification tracking

3. **technical_field**: Integration/technical configuration data
   - Examples: api_key, webhook_url, sync_status, external_reference_id, callback_endpoint
   - Indicators: URLs, API-related, sync/integration state, technical identifiers

4. **garbage**: No business value, should be ignored
   - Examples: _internal_debug_id, temp_calculation_field, _guid, _checksum, legacy_unused_column
   - Indicators: Debug prefixes (temp_, debug_, internal_), GUIDs/UUIDs, hash values, deprecated fields

**Classification Examples:**

Example 1:
Field: "customer_loyalty_tier"
Type: "string"
Samples: ["Gold", "Silver", "Bronze", "Platinum", "Gold"]
→ Category: business_field (customer segmentation data, business-meaningful values)

Example 2:
Field: "_internal_record_id"
Type: "string"
Samples: ["a1b2c3d4", "e5f6g7h8", "i9j0k1l2", "m3n4o5p6", "q7r8s9t0"]
→ Category: garbage (internal system identifier, random strings, no business meaning)

Example 3:
Field: "created_by_user_id"
Type: "integer"
Samples: [123, 456, 789, 234, 567]
→ Category: system_metadata (audit trail, tracks who created the record)

Example 4:
Field: "webhook_callback_url"
Type: "string"
Samples: ["https://api.example.com/callback", "https://hooks.example.com/notify", ...]
→ Category: technical_field (integration configuration, API endpoint)

**Instructions:**
1. Analyze the field name for semantic meaning and patterns (prefixes like "temp_", suffixes like "_guid")
2. Examine sample values to determine if they contain business information or technical/system data
3. Consider whether preserving this data would add business value to the target system
4. Assign a confidence score (0-100) based on how clearly the field fits the category

**Response Format:**
Respond ONLY with valid JSON (no markdown, no code blocks):
{
  "category": "business_field" | "system_metadata" | "technical_field" | "garbage",
  "confidence": 85,
  "reasoning": [
    "Field name suggests customer-related business data",
    "Sample values contain business-meaningful terms",
    "No system metadata or technical patterns detected"
  ]
}`;
}
