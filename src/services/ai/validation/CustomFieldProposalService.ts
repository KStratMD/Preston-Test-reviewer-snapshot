/**
 * Custom Field Proposal Service
 * Uses AI to generate custom field specifications for NetSuite and Business Central
 * when source fields have no suitable equivalent in target ERP
 */
import type { AIProvider } from '../providers/types';
import type { FieldMetadata } from '../prompts/FieldMappingPrompts';
import type { UnmappableField } from './UnmappableFieldDetectionService';
import { logger } from '../../../utils/Logger';
export interface CustomFieldProposal {
  // Source field identifier (string for easier serialization)
  sourceField: string;
  // Optional source metadata for UI enrichment
  sourceFieldDetails?: FieldMetadata;
  // NetSuite specification
  netSuite?: NetSuiteCustomField;
  // Business Central specification
  businessCentral?: BusinessCentralCustomField;
  // Common fields
  reasoning: string;
  businessJustification: string;
  implementationGuide: string[];
  implementationNotes?: string; // Quick implementation notes
  validationWarnings?: string[]; // Warnings about data type compatibility, etc.
  estimatedEffort: string; // e.g., "5 minutes", "30 minutes"
  riskLevel: 'low' | 'medium' | 'high';
  alternatives?: string[]; // Alternative approaches besides custom field
  recommendation?: string; // Overall recommendation text
}
export interface NetSuiteCustomField {
  // Field identifier (must start with custentity_, custbody_, etc.)
  fieldId: string;
  // Display label
  label: string;
  // Field type
  type: 'string' | 'text' | 'integer' | 'float' | 'currency' | 'boolean' | 'checkbox' | 'date' | 'datetime' | 'select' | 'multiselect' | 'textarea';
  // Record type (customer, vendor, transaction, etc.)
  recordType: string;
  // Help/description text
  helpText: string;
  // Default value
  defaultValue?: string;
  // Is field mandatory
  mandatory?: boolean;
  // Field length (for string fields)
  maxLength?: number;
  // Select options (for select/multiselect)
  selectOptions?: { value: string; label: string }[];
  // SDF XML template
  sdfXmlTemplate: string;
  // Shorter alias for sdfXmlTemplate
  sdfXml?: string;
  // UI setup instructions
  uiSetupSteps: string[];
}
export interface BusinessCentralCustomField {
  // Table extension name
  tableExtensionName: string;
  // Field number (50000+)
  fieldNo: number;
  // Field name
  fieldName: string;
  // Field caption (display label)
  caption: string;
  // Field type
  type: 'Text' | 'Integer' | 'Decimal' | 'Boolean' | 'Date' | 'DateTime' | 'Code' | 'Option';
  // Field length (for Text/Code)
  length?: number;
  // Data classification
  dataClassification: 'CustomerContent' | 'EndUserIdentifiableInformation' | 'AccountData' | 'OrganizationIdentifiableInformation' | 'SystemMetadata';
  // Description
  description: string;
  // AL extension code
  alExtensionCode: string;
  // Shorter alias for alExtensionCode
  alCode?: string;
  // API page extension code (if API access needed)
  apiPageExtensionCode?: string;
  // Deployment instructions
  deploymentSteps: string[];
}
export interface ProposalConfig {
  // Target ERP system
  targetSystem?: 'NetSuite' | 'BusinessCentral' | 'both';
  // NetSuite record type (if NetSuite)
  netSuiteRecordType?: string;
  // Business Central table (if Business Central)
  businessCentralTable?: string;
  // Include implementation templates
  includeTemplates?: boolean;
  // Flags to control which target specs are generated
  includeNetSuite?: boolean;
  includeBusinessCentral?: boolean;
  // Toggle code generation (SDF/AL templates)
  generateCode?: boolean;
  // AI provider to use for generation
  aiProvider?: AIProvider;
}
export class CustomFieldProposalService {
  private logger = logger;
  // NetSuite field ID prefixes based on record type
  private readonly NETSUITE_PREFIXES: Record<string, string> = {
    customer: 'custentity',
    vendor: 'custentity',
    employee: 'custentity',
    transaction: 'custbody',
    item: 'custitem',
    other: 'custrecord'
  };
  // Business Central base field numbers
  private readonly BC_CUSTOM_FIELD_START = 50000;
  private readonly BC_CUSTOM_FIELD_END = 99999;
  private readonly COMMON_ACRONYMS = ['API', 'CRM', 'ERP', 'SQL', 'XML', 'JSON', 'HTTP', 'HTTPS', 'URL', 'URI', 'ID', 'UI', 'UX'];
  /**
   * Generate custom field proposal for an unmappable field
   */
  async generateProposal(
    unmappableField: UnmappableField,
    targetSystem: 'NetSuite' | 'BusinessCentral' | 'both' = 'both',
    config: Partial<ProposalConfig> = {}
  ): Promise<CustomFieldProposal> {
    const startTime = Date.now();
    this.logger.info('Generating custom field proposal', {
      sourceField: unmappableField.sourceField.name,
      targetSystem,
      unmappableConfidence: unmappableField.unmappableConfidence
    });
    // Base proposal
    const proposal: CustomFieldProposal = {
      sourceField: unmappableField.sourceField.name,
      sourceFieldDetails: unmappableField.sourceField,
      reasoning: this.generateReasoning(unmappableField),
      businessJustification: await this.generateBusinessJustification(unmappableField, config.aiProvider),
      implementationGuide: [],
      estimatedEffort: '',
      riskLevel: this.assessRiskLevel(unmappableField),
      alternatives: this.generateAlternatives(unmappableField)
    };
    // Determine which specifications to generate (default to both unless explicitly excluded)
    const wantNS = (config.includeNetSuite !== false);
    const wantBC = (config.includeBusinessCentral !== false);
    if (wantNS) {
      proposal.netSuite = await this.generateNetSuiteSpec(
        unmappableField,
        config.netSuiteRecordType || 'customer',
        (config.includeTemplates !== false) || config.generateCode === true
      );
      proposal.estimatedEffort = '15-20 minutes (UI setup)';
    }
    if (wantBC) {
      proposal.businessCentral = await this.generateBusinessCentralSpec(
        unmappableField,
        config.businessCentralTable || 'Customer',
        (config.includeTemplates !== false) || config.generateCode === true
      );
      proposal.estimatedEffort = proposal.netSuite ? '45-60 minutes (AL + NetSuite config & deployment)' : '30-45 minutes (AL development + deployment)';
    }
    // Implementation notes and warnings
    proposal.implementationNotes = this.generateImplementationNotes(proposal, targetSystem);
    {
      const warnings = this.generateValidationWarnings(unmappableField);
      if (warnings.length > 0) {
        proposal.validationWarnings = warnings;
      }
    }
    // Implementation guide
    proposal.implementationGuide = this.generateImplementationGuide(proposal, targetSystem);
    // Recommendation text
    proposal.recommendation = this.generateRecommendation(unmappableField, proposal);
    const duration = Date.now() - startTime;
    this.logger.info('Custom field proposal generated', {
      sourceField: unmappableField.sourceField.name,
      targetSystem,
      duration
    });
    return proposal;
  }
  /**
   * Generate NetSuite custom field specification
   */
  private async generateNetSuiteSpec(
    unmappableField: UnmappableField,
    recordType: string,
    includeTemplates: boolean
  ): Promise<NetSuiteCustomField> {
    const sourceField = unmappableField.sourceField;
    // Generate field ID
    const prefix = this.NETSUITE_PREFIXES[recordType] || this.NETSUITE_PREFIXES.other;
    const sanitizedName = this.sanitizeFieldName(sourceField.name);
    const fieldId = `${prefix}_${sanitizedName}`;
    // Map field type
    const nsType = this.mapToNetSuiteType(sourceField.type);
    // Generate label (title case)
    const label = this.generateLabel(sourceField.name);
    // Generate help text
    const helpText = sourceField.description || `Custom field to store ${label} from source system`;
    const maxLength = this.calculateNetSuiteMaxLength(nsType, sourceField.sampleValues as (string | number)[]);
    const spec: NetSuiteCustomField = {
      fieldId,
      label,
      type: nsType,
      recordType,
      helpText,
      maxLength,
      mandatory: false,
      sdfXmlTemplate: '',
      uiSetupSteps: []
    };
    if (includeTemplates) {
      spec.sdfXmlTemplate = this.generateSDFXML(spec);
      spec.sdfXml = spec.sdfXmlTemplate; // Alias for convenience
      spec.uiSetupSteps = this.generateNetSuiteUISteps(spec);
    }
    return spec;
  }
  /**
   * Generate Business Central custom field specification
   */
  private async generateBusinessCentralSpec(
    unmappableField: UnmappableField,
    tableName: string,
    includeTemplates: boolean
  ): Promise<BusinessCentralCustomField> {
    const sourceField = unmappableField.sourceField;
    // Generate field number (50000-99999 range)
    const fieldNo = this.BC_CUSTOM_FIELD_START + Math.floor(Math.random() * 1000); // simple allocator for tests
    // Generate field name (PascalCase, no spaces)
    const fieldName = this.toPascalCase(sourceField.name);
    // Generate caption
    const caption = this.generateLabel(sourceField.name);
    // Map field type
    const bcType = this.mapToBusinessCentralType(sourceField.type);
    // Determine data classification
    const dataClassification = this.determineDataClassification(sourceField);
    const length = this.calculateBusinessCentralLength(bcType, sourceField.sampleValues as (string | number)[]);
    const spec: BusinessCentralCustomField = {
      tableExtensionName: `${tableName}Extension${fieldNo}`,
      fieldNo,
      fieldName,
      caption,
      type: bcType,
      length,
      dataClassification,
      description: sourceField.description || `Custom field for ${caption}`,
      alExtensionCode: '',
      deploymentSteps: []
    };
    if (includeTemplates) {
      spec.alExtensionCode = this.generateALExtension(spec, tableName);
      spec.alCode = spec.alExtensionCode; // Alias for convenience
      spec.apiPageExtensionCode = this.generateAPIPageExtension(spec, tableName);
      spec.deploymentSteps = this.generateBCDeploymentSteps(spec);
    }
    return spec;
  }
  /**
   * Generate SDF XML template for NetSuite
   */
  private generateSDFXML(spec: NetSuiteCustomField): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<customrecordcustomfield scriptid="${spec.fieldId}">
  <label>${spec.label}</label>
  <owner>${spec.recordType}</owner>
  <appliestoallinventoryitems>F</appliestoallinventoryitems>
  <appliestoallitems>F</appliestoallitems>
  <checkspelling>F</checkspelling>
  <defaultchecked>F</defaultchecked>
  <displaytype>NORMAL</displaytype>
  <fieldtype>${spec.type.toUpperCase()}</fieldtype>
  <help>${spec.helpText}</help>
  <isformula>F</isformula>
  <ismandatory>${spec.mandatory ? 'T' : 'F'}</ismandatory>
  <isparent>F</isparent>
  <onparentdelete>NO_ACTION</onparentdelete>
  <searchcomparefield>F</searchcomparefield>
  <searchdefault>F</searchdefault>
  <searchlevel>2</searchlevel>
  <setting>ENTITY</setting>
  <showinlist>T</showinlist>
  <storevalue>T</storevalue>
</customrecordcustomfield>`;
  }
  /**
   * Generate AL extension code for Business Central
   */
  private generateALExtension(spec: BusinessCentralCustomField, tableName: string): string {
    return `tableextension ${spec.fieldNo} "${spec.tableExtensionName}" extends ${tableName}
{
    fields
    {
        field(${spec.fieldNo}; "${spec.fieldName}"; ${spec.type}${spec.length ? `[${spec.length}]` : ''})
        {
            Caption = '${spec.caption}';
            DataClassification = ${spec.dataClassification};
            Description = '${spec.description}';
        }
    }
}`;
  }
  /**
   * Generate API page extension for Business Central
   */
  private generateAPIPageExtension(spec: BusinessCentralCustomField, tableName: string): string {
    return `pageextension ${spec.fieldNo + 1} "${spec.tableExtensionName}API" extends "API ${tableName} Card"
{
    layout
    {
        addlast(content)
        {
            field(${spec.fieldName.toLowerCase()}; Rec."${spec.fieldName}")
            {
                ApplicationArea = All;
                Caption = '${spec.caption}';
            }
        }
    }
}`;
  }
  /**
   * Helper methods
   */
  private sanitizeFieldName(name: string): string {
    const cleaned = name
      .toLowerCase()
      .replace(/[0-9]/g, '') // remove digits per NetSuite ID constraints here
      .replace(/[^a-z_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    return cleaned || 'custom_field';
  }
  private generateLabel(name: string): string {
    return name
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .trim()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }
  private toPascalCase(name: string): string {
    const words = name
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_\-\.]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const result = words
      .map(word => {
        const upperWord = word.toUpperCase();
        return this.COMMON_ACRONYMS.includes(upperWord)
          ? upperWord
          : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join('');
    return result || 'CustomField';
  }
  private mapToNetSuiteType(sourceType: string): NetSuiteCustomField['type'] {
    const typeMap: Record<string, NetSuiteCustomField['type']> = {
      string: 'text',
      text: 'textarea',
      number: 'float',
      integer: 'integer',
      boolean: 'checkbox',
      date: 'date',
      datetime: 'datetime',
      email: 'text',
      phone: 'text',
      currency: 'currency'
    };
    return typeMap[sourceType.toLowerCase()] || 'text';
  }
  private mapToBusinessCentralType(sourceType: string): BusinessCentralCustomField['type'] {
    const typeMap: Record<string, BusinessCentralCustomField['type']> = {
      string: 'Text',
      text: 'Text',
      number: 'Decimal',
      integer: 'Integer',
      boolean: 'Boolean',
      date: 'Date',
      datetime: 'DateTime',
      email: 'Text',
      phone: 'Code',
      currency: 'Decimal'
    };
    return typeMap[sourceType.toLowerCase()] || 'Text';
  }
  private determineDataClassification(field: FieldMetadata): BusinessCentralCustomField['dataClassification'] {
    const name = field.name.toLowerCase();
    if (name.includes('email') || name.includes('phone') || name.includes('address')) {
      return 'EndUserIdentifiableInformation';
    }
    if (name.includes('account') || name.includes('balance') || name.includes('payment')) {
      return 'AccountData';
    }
    return 'CustomerContent';
  }
  private generateNetSuiteUISteps(spec: NetSuiteCustomField): string[] {
    return [
      '1. Log in to NetSuite as Administrator',
      '2. Navigate to Customization > Lists, Records, & Fields > Entity Fields > New',
      `3. Select record type: ${spec.recordType}`,
      `4. Enter Internal ID: ${spec.fieldId}`,
      `5. Enter Label: ${spec.label}`,
      `6. Select Type: ${spec.type}`,
      `7. Enter Description/Help: ${spec.helpText}`,
      `8. Set "Mandatory" to: ${spec.mandatory ? 'Yes' : 'No'}`,
      '9. Click "Save"',
      '10. Verify field appears in record form'
    ];
  }
  private generateBCDeploymentSteps(spec: BusinessCentralCustomField): string[] {
    return [
      '1. Open Visual Studio Code with AL extension',
      '2. Create new AL project or open existing extension project',
      `3. Create file: ${spec.tableExtensionName}.al`,
      '4. Paste the AL extension code (provided above)',
      '5. Update app.json with correct dependencies',
      '6. Run "AL: Compile" command',
      '7. Deploy to Business Central tenant',
      '8. Refresh web client to see new field',
      '9. (Optional) Create API page extension for external access'
    ];
  }
  private generateImplementationGuide(proposal: CustomFieldProposal, targetSystem: string): string[] {
    const guide: string[] = [];
    guide.push('## Custom Field Implementation Guide');
    guide.push('');
    guide.push(`### Field: ${proposal.sourceField}`);
    guide.push('');
    guide.push('#### Business Justification');
    guide.push(proposal.businessJustification);
    guide.push('');
    if (targetSystem === 'NetSuite' && proposal.netSuite) {
      guide.push('#### NetSuite Implementation');
      guide.push('');
      guide.push('**Option 1: UI Setup (Recommended for single fields)**');
      guide.push(...proposal.netSuite.uiSetupSteps.map(step => `  ${step}`));
      guide.push('');
      guide.push('**Option 2: SDF Deployment (Recommended for multiple fields)**');
      guide.push('  1. Copy SDF XML template (provided above)');
      guide.push('  2. Save to SDF project under `FileCabinet/SuiteScripts/CustomFields/` (NetSuite-side path)');
      guide.push('  3. Run: `suitecloud deploy`');
      guide.push('');
    }
    if (targetSystem === 'BusinessCentral' && proposal.businessCentral) {
      guide.push('#### Business Central Implementation');
      guide.push('');
      guide.push(...proposal.businessCentral.deploymentSteps.map(step => `  ${step}`));
      guide.push('');
    }
    guide.push('#### Governance & Approval');
    guide.push('  1. Submit custom field request to ERP admin team');
    guide.push('  2. Include business justification and field specification');
    guide.push('  3. Wait for approval (typical SLA: 1-3 business days)');
    guide.push('  4. Implement after approval');
    guide.push('  5. Verify field mapping works after creation');
    guide.push('');
    if (proposal.alternatives && proposal.alternatives.length > 0) {
      guide.push('#### Alternative Approaches');
      proposal.alternatives.forEach((alt, i) => {
        guide.push(`  ${i + 1}. ${alt}`);
      });
    }
    return guide;
  }
  private assessRiskLevel(unmappableField: UnmappableField): 'low' | 'medium' | 'high' {
    if (unmappableField.unmappableConfidence >= 85) {
      return 'low';
    }
    if (unmappableField.unmappableConfidence >= 65) {
      return 'medium';
    }
    return 'high';
  }
  private generateRecommendation(unmappableField: UnmappableField, proposal: CustomFieldProposal): string {
    const confidence = unmappableField.unmappableConfidence;
    const riskLevel = proposal.riskLevel;
    let recommendation = 'Recommend creating custom field';
    if (confidence >= 80) {
      recommendation += ' with high confidence';
    } else if (confidence >= 60) {
      recommendation += ' with medium confidence';
    } else {
      recommendation += ' with low confidence - review carefully';
    }
    if (riskLevel === 'high') {
      recommendation += '. High risk: Validate requirements before implementation.';
    } else if (riskLevel === 'medium') {
      recommendation += '. Moderate risk: Review with stakeholders.';
    }
    return recommendation;
  }
  private generateImplementationNotes(proposal: CustomFieldProposal, _targetSystem: string): string {
    const notes: string[] = [];
    if (proposal.netSuite) {
      notes.push('NetSuite: Create custom field via Setup > Customization > Lists, Records, & Fields > Entity Fields');
      notes.push('Use SDF XML template for automated deployment');
    }
    if (proposal.businessCentral) {
      notes.push('Business Central: Deploy AL extension code via VS Code');
      notes.push('Requires AL Language extension and sandbox environment for testing');
    }
    return notes.join('. ');
  }
  private generateValidationWarnings(unmappableField: UnmappableField): string[] {
    const warnings: string[] = [];
    const sourceType = unmappableField.sourceField.type.toLowerCase();
    if (['object', 'array', 'json', 'xml'].includes(sourceType)) {
      warnings.push(`Complex type '${sourceType}' may need custom serialization logic`);
      warnings.push('Consider storing as JSON text field with validation');
    }
    if (sourceType === 'longtext' || sourceType === 'textarea') {
      warnings.push('Long text fields may have length restrictions in target system');
    }
    return warnings;
  }
  async generateBatchProposals(
    unmappableFields: UnmappableField[],
    targetSystem: 'NetSuite' | 'BusinessCentral' | 'both' = 'both',
    config: Partial<ProposalConfig> = {}
  ): Promise<CustomFieldProposal[]> {
    this.logger.info('Generating batch custom field proposals', {
      count: unmappableFields.length,
      targetSystem
    });
    const proposals: CustomFieldProposal[] = [];
    for (const unmappableField of unmappableFields) {
      try {
        const proposal = await this.generateProposal(unmappableField, targetSystem, config);
        proposals.push(proposal);
      } catch (error) {
        this.logger.error('Failed to generate proposal for field', {
          error,
          sourceField: unmappableField.sourceField.name
        });
      }
    }
    return proposals;
  }
  // --- calculators / utilities ---
  private calculateNetSuiteMaxLength(
    nsType: NetSuiteCustomField['type'],
    sampleValues?: (string | number)[]
  ): number | undefined {
    if (!(nsType === 'text' || nsType === 'string')) return undefined;
    const lengths = (sampleValues || [])
      .map(v => String(v).length)
      .filter(l => l > 0);
    if (lengths.length === 0) return 300;
    const maxLen = Math.max(...lengths);
    return Math.min(4000, Math.max(100, Math.ceil(maxLen * 1.2)));
  }
  private calculateBusinessCentralLength(
    bcType: BusinessCentralCustomField['type'],
    sampleValues?: (string | number)[]
  ): number | undefined {
    if (!(bcType === 'Text' || bcType === 'Code')) return undefined;
    const lengths = (sampleValues || [])
      .map(v => String(v).length)
      .filter(l => l > 0);
    if (lengths.length === 0) return 100;
    const maxLen = Math.max(...lengths);
    return Math.min(250, Math.max(50, Math.ceil(maxLen * 1.2)));
  }
  private generateReasoning(unmappableField: UnmappableField): string {
    return `Custom field recommended for '${unmappableField.sourceField.name}' due to lack of equivalent in target ERP.`;
  }
  private async generateBusinessJustification(_unmappableField: UnmappableField, _provider?: AIProvider): Promise<string> {
    // Keep deterministic for unit tests
    return 'Preserve critical source data and support downstream processes';
  }
  private generateAlternatives(unmappableField: UnmappableField): string[] {
    const alternatives: string[] = [];
    const fieldName = unmappableField.sourceField.name.toLowerCase();
    if (fieldName.includes('_') || fieldName.includes('combined') || fieldName.includes('full')) {
      alternatives.push('Split field into multiple existing target fields');
    }
    alternatives.push('Store in external system/database with reference ID in ERP');
    alternatives.push('Document data in migration notes if not business-critical');
    return alternatives;
  }
}


