/**
 * Field Mapper Utility Unit Tests
 * Tests for field mapping transformations and validation
 */

import { FieldMapperUtility, FieldMappingMetadata } from '../../../src/utils/fieldMapper';

describe('FieldMapperUtility', () => {
  let mapper: FieldMapperUtility;
  let mockLogger: {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
    debug: jest.Mock;
  };

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    mapper = new FieldMapperUtility(mockLogger as any);
  });

  describe('mapFields', () => {
    it('should map fields with direct transformation', async () => {
      const sourceRecord = { id: '123', name: 'Test Record' };
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          { sourceField: 'id', targetField: 'externalId', transformation: 'direct', required: true },
          { sourceField: 'name', targetField: 'displayName', transformation: 'direct', required: true },
        ],
      };

      const result = await mapper.mapFields(sourceRecord, metadata);

      expect(result.success).toBe(true);
      expect(result.mappedRecord).toEqual({
        externalId: '123',
        displayName: 'Test Record',
      });
      expect(result.errors).toHaveLength(0);
    });

    it('should handle missing required field', async () => {
      const sourceRecord = { id: '123' };
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          { sourceField: 'id', targetField: 'externalId', transformation: 'direct', required: true },
          { sourceField: 'name', targetField: 'displayName', transformation: 'direct', required: true },
        ],
      };

      const result = await mapper.mapFields(sourceRecord, metadata);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('displayName');
    });

    it('should handle missing optional field with warning', async () => {
      const sourceRecord = { id: '123' };
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          { sourceField: 'id', targetField: 'externalId', transformation: 'direct', required: true },
          { sourceField: 'email', targetField: 'primaryEmail', transformation: 'direct', required: false },
        ],
      };

      const result = await mapper.mapFields(sourceRecord, metadata);

      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should track unmapped source fields', async () => {
      const sourceRecord = { id: '123', name: 'Test', extra: 'data' };
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          { sourceField: 'id', targetField: 'externalId', transformation: 'direct', required: true },
        ],
      };

      const result = await mapper.mapFields(sourceRecord, metadata);

      expect(result.unmappedFields).toContain('name');
      expect(result.unmappedFields).toContain('extra');
    });

    it('should perform lookup transformation', async () => {
      const sourceRecord = { status: 'active' };
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          {
            sourceField: 'status',
            targetField: 'isActive',
            transformation: 'lookup',
            transformationValue: '{"active": true, "inactive": false}',
            required: true,
          },
        ],
      };

      const result = await mapper.mapFields(sourceRecord, metadata);

      expect(result.success).toBe(true);
      expect(result.mappedRecord?.isActive).toBe(true);
    });

    it('should use default value in lookup when key not found', async () => {
      const sourceRecord = { status: 'unknown' };
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          {
            sourceField: 'status',
            targetField: 'isActive',
            transformation: 'lookup',
            transformationValue: '{"active": true, "inactive": false, "_default": false}',
            required: true,
          },
        ],
      };

      const result = await mapper.mapFields(sourceRecord, metadata);

      expect(result.success).toBe(true);
      expect(result.mappedRecord?.isActive).toBe(false);
    });

    it('should perform calculation transformation', async () => {
      const sourceRecord = { price: 100, quantity: 5 };
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          {
            sourceField: 'price',
            targetField: 'total',
            transformation: 'calculation',
            transformationValue: '{price} * {quantity}',
            required: true,
          },
        ],
      };

      const result = await mapper.mapFields(sourceRecord, metadata);

      expect(result.success).toBe(true);
      expect(result.mappedRecord?.total).toBe(500);
    });

    it('should perform concatenation transformation', async () => {
      const sourceRecord = { firstName: 'John', lastName: 'Doe' };
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          {
            sourceField: 'firstName',
            targetField: 'fullName',
            transformation: 'concatenation',
            transformationValue: '{firstName} {lastName}',
            required: true,
          },
        ],
      };

      const result = await mapper.mapFields(sourceRecord, metadata);

      expect(result.success).toBe(true);
      expect(result.mappedRecord?.fullName).toBe('John Doe');
    });

    it('should perform conditional transformation with equality', async () => {
      const sourceRecord = { type: 'premium' };
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          {
            sourceField: 'type',
            targetField: 'discount',
            transformation: 'conditional',
            transformationValue: "if {type} == 'premium' then '20%' else '0%'",
            required: true,
          },
        ],
      };

      const result = await mapper.mapFields(sourceRecord, metadata);

      expect(result.success).toBe(true);
      expect(result.mappedRecord?.discount).toBe('20%');
    });

    it('should handle null source values', async () => {
      const sourceRecord = { id: null };
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          { sourceField: 'id', targetField: 'externalId', transformation: 'direct', required: false },
        ],
      };

      const result = await mapper.mapFields(sourceRecord, metadata);

      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should use direct mapping when no transformation specified', async () => {
      const sourceRecord = { id: '123' };
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          { sourceField: 'id', targetField: 'externalId', required: true },
        ],
      };

      const result = await mapper.mapFields(sourceRecord, metadata);

      expect(result.success).toBe(true);
      expect(result.mappedRecord?.externalId).toBe('123');
    });
  });

  describe('validateMappingMetadata', () => {
    it('should return valid for correct metadata', () => {
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          { sourceField: 'id', targetField: 'externalId', required: true },
        ],
      };

      const result = mapper.validateMappingMetadata(metadata);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing sourceSystem', () => {
      const metadata = {
        sourceSystem: '',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [{ sourceField: 'id', targetField: 'externalId', required: true }],
      } as FieldMappingMetadata;

      const result = mapper.validateMappingMetadata(metadata);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('sourceSystem is required');
    });

    it('should detect empty mappings array', () => {
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [],
      };

      const result = mapper.validateMappingMetadata(metadata);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('mappings'))).toBe(true);
    });

    it('should warn about transformation without value', () => {
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          { sourceField: 'id', targetField: 'externalId', transformation: 'lookup', required: true },
        ],
      };

      const result = mapper.validateMappingMetadata(metadata);

      expect(result.isValid).toBe(true);
      expect(result.warnings.some(w => w.includes('lookup'))).toBe(true);
    });

    it('should warn about duplicate target fields', () => {
      const metadata: FieldMappingMetadata = {
        sourceSystem: 'source',
        targetSystem: 'target',
        module: 'test',
        recordType: 'record',
        mappings: [
          { sourceField: 'id', targetField: 'externalId', required: true },
          { sourceField: 'code', targetField: 'externalId', required: true },
        ],
      };

      const result = mapper.validateMappingMetadata(metadata);

      expect(result.isValid).toBe(true);
      expect(result.warnings.some(w => w.includes('Duplicate'))).toBe(true);
    });
  });

  describe('generateSampleMapping', () => {
    it('should generate sample mapping with default fields', () => {
      const result = mapper.generateSampleMapping('Salesforce', 'NetSuite', 'CRM', 'Contact');

      expect(result.sourceSystem).toBe('Salesforce');
      expect(result.targetSystem).toBe('NetSuite');
      expect(result.module).toBe('CRM');
      expect(result.recordType).toBe('Contact');
      expect(result.mappings.length).toBeGreaterThan(0);
    });

    it('should include id and name mappings', () => {
      const result = mapper.generateSampleMapping('A', 'B', 'M', 'R');

      const idMapping = result.mappings.find(m => m.sourceField === 'id');
      const nameMapping = result.mappings.find(m => m.sourceField === 'name');

      expect(idMapping).toBeDefined();
      expect(nameMapping).toBeDefined();
    });
  });
});
