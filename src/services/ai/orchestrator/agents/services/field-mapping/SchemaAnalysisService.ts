import type {
  CustomField,
  SchemaConstraint,
  SchemaRelationship,
  SystemSchema
} from '../../fieldMappingTypes';
import type { FieldDefinition } from '../../../interfaces';

/**
 * Encapsulates schema introspection logic for the FieldMappingAgent.
 * Responsible for deriving relationships, constraints, and custom-field metadata.
 */
export class SchemaAnalysisService {
  async analyzeSchema(fields: FieldDefinition[], systemName: string): Promise<SystemSchema> {
    const schema: SystemSchema = {
      systemName,
      systemType: systemName,
      fields,
      relationships: [],
      constraints: [],
      customFields: []
    };

    schema.relationships = this.identifyRelationships(fields);
    schema.constraints = this.identifyConstraints(fields);
    schema.customFields = this.identifyCustomFields(fields, systemName);

    return schema;
  }

  private identifyRelationships(fields: FieldDefinition[]): SchemaRelationship[] {
    const relationships: SchemaRelationship[] = [];
    const idFields = fields.filter(field =>
      field.name.toLowerCase().includes('_id') ||
      field.name.toLowerCase().endsWith('id') ||
      field.type.toLowerCase().includes('reference')
    );

    idFields.forEach(idField => {
      const referencedField = fields.find(field =>
        field.name.toLowerCase() === idField.name.toLowerCase().replace(/_id|id$/i, '') ||
        field.name.toLowerCase().includes(idField.name.toLowerCase().replace(/_id|id$/i, ''))
      );

      if (referencedField) {
        relationships.push({
          fromField: idField.name,
          toField: referencedField.name,
          relationship: 'many_to_one',
          required: idField.required || false
        });
      }
    });

    return relationships;
  }

  private identifyConstraints(fields: FieldDefinition[]): SchemaConstraint[] {
    const constraints: SchemaConstraint[] = [];

    fields.forEach(field => {
      if (field.required) {
        constraints.push({
          field: field.name,
          type: 'required',
          rule: 'NOT NULL',
          description: 'Field is required'
        });
      }

      if (field.type === 'email' || field.name.toLowerCase().includes('email')) {
        constraints.push({
          field: field.name,
          type: 'format',
          rule: 'email_format',
          description: 'Must be valid email format'
        });
      }

      if (field.type === 'phone' || field.name.toLowerCase().includes('phone')) {
        constraints.push({
          field: field.name,
          type: 'format',
          rule: 'phone_format',
          description: 'Must be valid phone format'
        });
      }

      if (field.name.toLowerCase().includes('id') && !field.name.toLowerCase().includes('_id')) {
        constraints.push({
          field: field.name,
          type: 'unique',
          rule: 'UNIQUE',
          description: 'Must be unique identifier'
        });
      }
    });

    return constraints;
  }

  private identifyCustomFields(fields: FieldDefinition[], systemName: string): CustomField[] {
    const customFields: CustomField[] = [];

    fields.forEach(field => {
      const isCustom =
        field.name.startsWith('custom_') ||
        field.name.startsWith('cf_') ||
        field.name.includes('__c') ||
        field.name.toLowerCase().includes('custom');

      if (isCustom) {
        customFields.push({
          id: `${systemName}_${field.name}`,
          name: field.name,
          type: field.type,
          system: systemName,
          description: field.description
        });
      }
    });

    return customFields;
  }
}
