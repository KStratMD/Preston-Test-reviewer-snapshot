/**
 * X12Parser Unit Tests
 * Tests for X12 EDI 850 Purchase Order parsing
 */

import { X12Parser } from '../../../../src/translation/parsers/X12Parser';
import type { Logger } from '../../../../src/utils/Logger';

describe('X12Parser', () => {
  let parser: X12Parser;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    parser = new X12Parser(mockLogger);
  });

  describe('constructor and properties', () => {
    it('should have correct name', () => {
      expect(parser.name).toBe('X12 Parser');
    });

    it('should have correct format', () => {
      expect(parser.format).toBe('x12');
    });
  });

  describe('parse()', () => {
    it('should parse BEG segment for order ID and date (CCYYMMDD)', async () => {
      const x12Content = `ISA*00~BEG*00*NE*PO12345**20240115~IEA*1~`;

      const result = await parser.parse(x12Content);

      expect(result.orderId).toBe('PO12345');
      expect(result.orderDate).toBe('2024-01-15T00:00:00.000Z');
    });

    it('should parse BEG segment with YYMMDD date format', async () => {
      const x12Content = `ISA*00~BEG*00*NE*PO99999**240320~IEA*1~`;

      const result = await parser.parse(x12Content);

      expect(result.orderId).toBe('PO99999');
      expect(result.orderDate).toBe('2024-03-20T00:00:00.000Z');
    });

    it('should parse N1 segment for buyer name', async () => {
      const x12Content = `ISA*00~N1*BY*Acme Corporation~IEA*1~`;

      const result = await parser.parse(x12Content);

      expect(result.customer.name).toBe('Acme Corporation');
    });

    it('should ignore N1 segments that are not buyer (BY)', async () => {
      const x12Content = `ISA*00~N1*SE*Seller Inc~N1*BY*Buyer Corp~IEA*1~`;

      const result = await parser.parse(x12Content);

      expect(result.customer.name).toBe('Buyer Corp');
    });

    it('should parse PO1 segments for line items', async () => {
      const x12Content = `ISA*00~PO1*1*10*EA*25.99*PE**SKU001~PO1*2*5*CS*100.00*PE**SKU002~IEA*1~`;

      const result = await parser.parse(x12Content);

      expect(result.lineItems).toHaveLength(2);
      expect(result.lineItems[0]).toEqual({
        lineNumber: 1,
        quantity: 10,
        uom: 'EA',
        unitPrice: 25.99,
        itemId: 'SKU001',
      });
      expect(result.lineItems[1]).toEqual({
        lineNumber: 2,
        quantity: 5,
        uom: 'CS',
        unitPrice: 100.0,
        itemId: 'SKU002',
      });
    });

    it('should parse complete X12 850 document', async () => {
      const x12Content = [
        'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *240115*1200*U*00401*000000001*0*P*>',
        'GS*PO*SENDER*RECEIVER*20240115*1200*1*X*004010',
        'ST*850*0001',
        'BEG*00*NE*PO-2024-001**20240115',
        'N1*BY*Widget Corp',
        'PO1*1*100*EA*9.99*PE**WIDGET-A',
        'PO1*2*50*CS*49.99*PE**WIDGET-B',
        'SE*7*0001',
        'GE*1*1',
        'IEA*1*000000001',
      ].join('~');

      const result = await parser.parse(x12Content);

      expect(result.orderId).toBe('PO-2024-001');
      expect(result.orderDate).toBe('2024-01-15T00:00:00.000Z');
      expect(result.customer.name).toBe('Widget Corp');
      expect(result.lineItems).toHaveLength(2);
      expect(mockLogger.debug).toHaveBeenCalledWith('Parsed X12 850', {
        orderId: 'PO-2024-001',
        lineItemCount: 2,
      });
    });

    it('should handle Buffer input', async () => {
      const x12Content = Buffer.from('ISA*00~BEG*00*NE*BUFFER-ORDER**20240101~IEA*1~');

      const result = await parser.parse(x12Content);

      expect(result.orderId).toBe('BUFFER-ORDER');
    });

    it('should handle empty segments gracefully', async () => {
      const x12Content = `ISA*00~   ~  ~BEG*00*NE*TEST123**20240115~  ~IEA*1~`;

      const result = await parser.parse(x12Content);

      expect(result.orderId).toBe('TEST123');
    });

    it('should handle missing date with current date fallback', async () => {
      const x12Content = `ISA*00~BEG*00*NE*NO-DATE**~IEA*1~`;

      const result = await parser.parse(x12Content);

      expect(result.orderId).toBe('NO-DATE');
      // Date should be ISO format (current date as fallback)
      expect(result.orderDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should handle invalid date format with current date fallback', async () => {
      const x12Content = `ISA*00~BEG*00*NE*BAD-DATE**123~IEA*1~`;

      const result = await parser.parse(x12Content);

      expect(result.orderId).toBe('BAD-DATE');
      // Date should be ISO format (current date as fallback)
      expect(result.orderDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should return empty order structure for content with no recognized segments', async () => {
      const x12Content = `ISA*00~UNKNOWN*DATA~IEA*1~`;

      const result = await parser.parse(x12Content);

      expect(result.orderId).toBe('');
      expect(result.orderDate).toBe('');
      expect(result.customer).toEqual({});
      expect(result.lineItems).toEqual([]);
    });
  });

  describe('validate()', () => {
    it('should return true for valid X12 format', async () => {
      const validX12 = 'ISA*00*          *00*          ~GS*PO~IEA*1~';

      const result = await parser.validate(validX12);

      expect(result).toBe(true);
    });

    it('should return false when missing ISA header', async () => {
      const invalidX12 = 'GS*PO~ST*850~SE*2~GE*1~IEA*1~';

      const result = await parser.validate(invalidX12);

      expect(result).toBe(false);
    });

    it('should return false when missing segment terminators', async () => {
      const invalidX12 = 'ISA*00*          *00*          GS*PO IEA*1';

      const result = await parser.validate(invalidX12);

      expect(result).toBe(false);
    });

    it('should handle Buffer input for validation', async () => {
      const validX12 = Buffer.from('ISA*00~GS*PO~IEA*1~');

      const result = await parser.validate(validX12);

      expect(result).toBe(true);
    });

    it('should return false for empty content', async () => {
      const result = await parser.validate('');

      expect(result).toBe(false);
    });

    it('should return false for content with only ISA but no tilde', async () => {
      const result = await parser.validate('ISA*00*data');

      expect(result).toBe(false);
    });

    it('should return false for content with only tilde but no ISA', async () => {
      const result = await parser.validate('GS*PO~ST*850~');

      expect(result).toBe(false);
    });
  });
});
