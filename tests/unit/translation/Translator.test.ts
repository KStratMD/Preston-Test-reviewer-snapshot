/**
 * UniversalTranslator Unit Tests
 * Tests for format translation via canonical schemas
 */

import * as fs from 'fs';
import { UniversalTranslator } from '../../../src/translation/Translator';
import type { Logger } from '../../../src/utils/Logger';
import type { CanonicalDocument, Parser } from '../../../src/translation/types';

// Mock fs module
jest.mock('fs');

describe('UniversalTranslator', () => {
  let translator: UniversalTranslator;
  let mockLogger: Logger;
  const mockFs = fs as jest.Mocked<typeof fs>;

  // Valid order schema
  const orderSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['orderId', 'orderDate', 'customer', 'lineItems'],
    properties: {
      orderId: { type: 'string' },
      orderDate: { type: 'string', format: 'date-time' },
      customer: {
        type: 'object',
        required: ['customerId', 'name'],
        properties: {
          customerId: { type: 'string' },
          name: { type: 'string' },
        },
      },
      lineItems: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['itemId', 'quantity', 'unitPrice'],
          properties: {
            itemId: { type: 'string' },
            quantity: { type: 'number' },
            unitPrice: { type: 'number' },
          },
        },
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    // Setup default fs mocks
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(orderSchema));

    translator = new UniversalTranslator(mockLogger);
  });

  describe('constructor', () => {
    it('should initialize and register X12 parser', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('Universal Translator initialized');
    });
  });

  describe('registerParser()', () => {
    it('should register a custom parser', () => {
      const mockParser: Parser = {
        name: 'Custom Parser',
        format: 'json',
        parse: jest.fn().mockResolvedValue({}),
        validate: jest.fn().mockResolvedValue(true),
      };

      translator.registerParser('custom', mockParser);

      expect(mockLogger.debug).toHaveBeenCalledWith('Registered parser: custom');
    });
  });

  describe('translateToCanonical()', () => {
    it('should translate valid X12 input to canonical format', async () => {
      const x12Input = 'ISA*00~BEG*00*NE*ORD-001**20240115~N1*BY*Test Customer~PO1*1*10*EA*9.99*PE**ITEM-A~IEA*1~';

      // Mock the schema to accept the parsed order structure
      const flexibleSchema = {
        type: 'object',
        required: ['orderId'],
        properties: {
          orderId: { type: 'string' },
          orderDate: { type: 'string' },
          customer: { type: 'object' },
          lineItems: { type: 'array' },
        },
      };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(flexibleSchema));

      const result = await translator.translateToCanonical(x12Input, 'x12', 'order');

      expect(result.type).toBe('order');
      expect(result.metadata.sourceFormat).toBe('x12');
      expect(result.metadata.version).toBe('1.0');
      expect(result.data).toBeDefined();
    });

    it('should throw error for unregistered format', async () => {
      await expect(
        translator.translateToCanonical('data', 'csv', 'order')
      ).rejects.toThrow('No parser registered for format: csv');
    });

    it('should throw error for invalid input format', async () => {
      // Input without ISA* and ~ is invalid X12
      const invalidInput = 'This is not X12 format';

      await expect(
        translator.translateToCanonical(invalidInput, 'x12', 'order')
      ).rejects.toThrow('Invalid x12 format');
    });

    it('should throw error when canonical schema not found', async () => {
      const validX12 = 'ISA*00~BEG*00*NE*ORD-001**20240115~IEA*1~';
      mockFs.existsSync.mockReturnValue(false);

      await expect(
        translator.translateToCanonical(validX12, 'x12', 'invoice')
      ).rejects.toThrow('Canonical schema not found: invoice');
    });

    it('should throw error when canonical validation fails', async () => {
      const validX12 = 'ISA*00~BEG*00*NE*ORD-001**20240115~IEA*1~';

      // Strict schema that requires fields the X12 parser doesn't provide
      const strictSchema = {
        type: 'object',
        required: ['requiredField'],
        properties: {
          requiredField: { type: 'string' },
        },
      };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(strictSchema));

      await expect(
        translator.translateToCanonical(validX12, 'x12', 'order')
      ).rejects.toThrow(/Canonical validation failed/);
    });

    it('should include timestamp in metadata', async () => {
      const x12Input = 'ISA*00~BEG*00*NE*ORD-001**20240115~IEA*1~';

      const flexibleSchema = {
        type: 'object',
        properties: {
          orderId: { type: 'string' },
        },
      };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(flexibleSchema));

      const before = new Date().toISOString();
      const result = await translator.translateToCanonical(x12Input, 'x12', 'order');
      const after = new Date().toISOString();

      expect(result.metadata.translatedAt).toBeDefined();
      expect(result.metadata.translatedAt >= before).toBe(true);
      expect(result.metadata.translatedAt <= after).toBe(true);
    });
  });

  describe('translateFromCanonical()', () => {
    it('should translate canonical order to NetSuite format', async () => {
      const canonicalDoc: CanonicalDocument = {
        type: 'order',
        data: {
          orderId: 'ORD-001',
          orderDate: '2024-01-15T00:00:00.000Z',
          customer: {
            customerId: 'CUST-123',
            name: 'Test Customer',
          },
          lineItems: [
            { itemId: 'ITEM-A', quantity: 10, unitPrice: 9.99 },
            { itemId: 'ITEM-B', quantity: 5, unitPrice: 19.99 },
          ],
        },
        metadata: {
          sourceFormat: 'x12',
          translatedAt: '2024-01-15T12:00:00.000Z',
          version: '1.0',
        },
      };

      const result = await translator.translateFromCanonical(canonicalDoc, 'netsuite');

      expect(result.canonical).toBe(canonicalDoc);
      const payload = result.targetPayload as any;
      expect(payload.entity).toBe('CUST-123');
      expect(payload.tranDate).toBe('2024-01-15T00:00:00.000Z');
      expect(payload.otherRefNum).toBe('ORD-001');
      expect(payload.item).toHaveLength(2);
      expect(payload.item[0].item).toBe('ITEM-A');
      expect(payload.item[0].quantity).toBe(10);
      expect(payload.item[0].rate).toBe(9.99);
      expect(payload.item[0].amount).toBeCloseTo(99.9, 2);
      expect(payload.item[1].item).toBe('ITEM-B');
      expect(payload.item[1].quantity).toBe(5);
      expect(payload.item[1].rate).toBe(19.99);
      expect(payload.item[1].amount).toBeCloseTo(99.95, 2);
      expect(result.mappings).toHaveLength(4);
      expect(result.warnings).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('should include correct field mappings in result', async () => {
      const canonicalDoc: CanonicalDocument = {
        type: 'order',
        data: {
          orderId: 'ORD-002',
          orderDate: '2024-01-20T00:00:00.000Z',
          customer: { customerId: 'CUST-456', name: 'Another Customer' },
          lineItems: [{ itemId: 'ITEM-X', quantity: 1, unitPrice: 100 }],
        },
        metadata: {
          sourceFormat: 'x12',
          translatedAt: '2024-01-20T12:00:00.000Z',
          version: '1.0',
        },
      };

      const result = await translator.translateFromCanonical(canonicalDoc, 'netsuite');

      expect(result.mappings).toContainEqual({
        canonicalField: 'customer.customerId',
        targetField: 'entity',
      });
      expect(result.mappings).toContainEqual({
        canonicalField: 'orderDate',
        targetField: 'tranDate',
      });
      expect(result.mappings).toContainEqual({
        canonicalField: 'orderId',
        targetField: 'otherRefNum',
      });
      expect(result.mappings).toContainEqual({
        canonicalField: 'lineItems[].itemId',
        targetField: 'item[].item',
      });
    });

    it('should throw error for unsupported target system', async () => {
      const canonicalDoc: CanonicalDocument = {
        type: 'order',
        data: {},
        metadata: {
          sourceFormat: 'x12',
          translatedAt: '2024-01-15T12:00:00.000Z',
          version: '1.0',
        },
      };

      await expect(
        translator.translateFromCanonical(canonicalDoc, 'salesforce')
      ).rejects.toThrow('Translation to salesforce not yet implemented for order');
    });

    it('should throw error for unsupported document type', async () => {
      const canonicalDoc: CanonicalDocument = {
        type: 'invoice',
        data: {},
        metadata: {
          sourceFormat: 'x12',
          translatedAt: '2024-01-15T12:00:00.000Z',
          version: '1.0',
        },
      };

      await expect(
        translator.translateFromCanonical(canonicalDoc, 'netsuite')
      ).rejects.toThrow('Translation to netsuite not yet implemented for invoice');
    });

    it('should calculate line item amounts correctly', async () => {
      const canonicalDoc: CanonicalDocument = {
        type: 'order',
        data: {
          orderId: 'ORD-CALC',
          orderDate: '2024-01-15T00:00:00.000Z',
          customer: { customerId: 'CUST-789', name: 'Math Customer' },
          lineItems: [
            { itemId: 'ITEM-1', quantity: 3, unitPrice: 33.33 },
            { itemId: 'ITEM-2', quantity: 7, unitPrice: 14.29 },
          ],
        },
        metadata: {
          sourceFormat: 'x12',
          translatedAt: '2024-01-15T12:00:00.000Z',
          version: '1.0',
        },
      };

      const result = await translator.translateFromCanonical(canonicalDoc, 'netsuite');

      expect((result.targetPayload as any).item[0].amount).toBeCloseTo(99.99, 2);
      expect((result.targetPayload as any).item[1].amount).toBeCloseTo(100.03, 2);
    });
  });
});
