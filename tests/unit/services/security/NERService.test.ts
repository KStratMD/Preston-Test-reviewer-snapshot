/**
 * NERService Unit Tests
 * Tests for Named Entity Recognition patterns
 */

import 'reflect-metadata';
import { NERService } from '../../../../src/services/security/NERService';
import type { Logger } from '../../../../src/utils/Logger';

describe('NERService', () => {
  let nerService: NERService;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    nerService = new NERService(mockLogger);
  });

  describe('constructor', () => {
    it('should initialize and log capabilities', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('NER Service initialized', expect.any(Object));
    });
  });

  describe('detectEntities()', () => {
    describe('person detection', () => {
      it('should detect person with title prefix', async () => {
        const data = { name: 'Dr. John Smith is a professor' };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        expect(result.entityTypes).toContain('PERSON');
        const personEntity = result.entities.find(e => e.type === 'PERSON');
        expect(personEntity?.value).toBe('Dr. John Smith');
        expect(personEntity?.confidence).toBeGreaterThan(0.8);
      });

      it('should detect person with Mr prefix', async () => {
        const data = { contact: 'Contact Mr. Robert Johnson for details' };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        const personEntity = result.entities.find(e => e.type === 'PERSON');
        expect(personEntity?.value).toBe('Mr. Robert Johnson');
      });

      it('should detect person with Mrs prefix', async () => {
        const data = { manager: 'Mrs. Elizabeth Wilson approved it' };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        const personEntity = result.entities.find(e => e.type === 'PERSON');
        expect(personEntity?.value).toBe('Mrs. Elizabeth Wilson');
      });

      it('should detect common first names as potential persons', async () => {
        const data = { employee: 'James Anderson from accounting' };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        const personEntity = result.entities.find(e => e.type === 'PERSON' && e.value.includes('James'));
        expect(personEntity).toBeDefined();
        expect(personEntity?.confidence).toBeGreaterThan(0.5);
      });
    });

    describe('address detection', () => {
      it('should detect street address', async () => {
        const data = { address: 'Ship to 123 Main Street for delivery' };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        expect(result.entityTypes).toContain('ADDRESS');
        const addressEntity = result.entities.find(e => e.type === 'ADDRESS');
        expect(addressEntity?.value).toContain('123 Main Street');
      });

      it('should detect various address formats', async () => {
        const data = { location: '456 Oak Avenue, 789 Elm Blvd, 101 Pine Rd' };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        const addressEntities = result.entities.filter(e => e.type === 'ADDRESS');
        expect(addressEntities.length).toBeGreaterThan(0);
      });
    });

    describe('location detection', () => {
      it('should detect city, state, ZIP format', async () => {
        const data = { location: 'Our office is in New York, NY 10001' };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        expect(result.entityTypes).toContain('LOCATION');
        const locationEntity = result.entities.find(e => e.type === 'LOCATION');
        expect(locationEntity?.value).toContain('NY');
        expect(locationEntity?.confidence).toBeGreaterThanOrEqual(0.9);
      });

      it('should detect multiple locations', async () => {
        const data = { offices: 'Offices in Chicago, IL 60601 and Boston, MA 02101' };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        const locationEntities = result.entities.filter(e => e.type === 'LOCATION');
        expect(locationEntities.length).toBe(2);
      });

      it('should not detect invalid state abbreviations', async () => {
        const data = { location: 'City, XX 12345' };

        const result = await nerService.detectEntities(data);

        const locationEntity = result.entities.find(
          e => e.type === 'LOCATION' && e.context?.includes('State: XX')
        );
        expect(locationEntity).toBeUndefined();
      });
    });

    describe('organization detection', () => {
      it('should detect organization with Inc suffix', async () => {
        const data = { vendor: 'Invoice from Acme Inc. for services' };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        expect(result.entityTypes).toContain('ORGANIZATION');
        const orgEntity = result.entities.find(e => e.type === 'ORGANIZATION' && e.value.includes('Acme'));
        expect(orgEntity).toBeDefined();
      });

      it('should detect organization with LLC suffix', async () => {
        const data = { company: 'Contract with Tech Solutions LLC' };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        const orgEntity = result.entities.find(e => e.type === 'ORGANIZATION' && e.value.includes('LLC'));
        expect(orgEntity).toBeDefined();
      });

      it('should detect organization with Corp suffix', async () => {
        const data = { supplier: 'Parts supplied by Global Corp.' };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        const orgEntity = result.entities.find(e => e.type === 'ORGANIZATION' && e.value.includes('Corp'));
        expect(orgEntity).toBeDefined();
      });
    });

    describe('data structure handling', () => {
      it('should scan nested objects', async () => {
        const data = {
          customer: {
            contact: {
              name: 'Dr. Jane Doe',
              address: '123 Oak Street'
            }
          }
        };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        expect(result.entities.length).toBeGreaterThan(0);
      });

      it('should scan arrays', async () => {
        const data = {
          contacts: [
            { name: 'Mr. John Smith' },
            { name: 'Mrs. Jane Doe' }
          ]
        };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(true);
        const personEntities = result.entities.filter(e => e.type === 'PERSON');
        // May detect more than 2 due to capitalized phrase patterns
        expect(personEntities.length).toBeGreaterThanOrEqual(2);
      });

      it('should handle null values', async () => {
        const data = { name: null, address: 'Valid Address' };

        const result = await nerService.detectEntities(data);

        // Should not throw, and should still find address if valid
        expect(result).toBeDefined();
      });

      it('should handle undefined values', async () => {
        const data = { name: undefined };

        const result = await nerService.detectEntities(data);

        expect(result.detected).toBe(false);
        expect(result.entities).toEqual([]);
      });

      it('should handle empty object', async () => {
        const result = await nerService.detectEntities({});

        expect(result.detected).toBe(false);
        expect(result.entities).toEqual([]);
        expect(result.confidence).toBe(0);
      });

      it('should track field paths in entities', async () => {
        const data = {
          billing: {
            contact: 'Dr. John Smith'
          }
        };

        const result = await nerService.detectEntities(data);

        const entity = result.entities.find(e => e.type === 'PERSON');
        expect(entity?.field).toBe('billing.contact');
      });
    });

    describe('confidence calculation', () => {
      it('should return 0 confidence when no entities found', async () => {
        const data = { code: 'ABC123' };

        const result = await nerService.detectEntities(data);

        expect(result.confidence).toBe(0);
      });

      it('should calculate average confidence', async () => {
        const data = { name: 'Dr. John Smith' }; // High confidence detection

        const result = await nerService.detectEntities(data);

        expect(result.confidence).toBeGreaterThan(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('detectPII()', () => {
    it('should detect high-confidence person names as PII', async () => {
      const data = { contact: 'Dr. John Smith is the contact person' };

      const result = await nerService.detectPII(data);

      expect(result.hasPII).toBe(true);
      expect(result.piiCategories).toContain('person_name');
    });

    it('should detect addresses as PII', async () => {
      const data = { shipping: 'Ship to 123 Main Street, New York, NY 10001' };

      const result = await nerService.detectPII(data);

      expect(result.hasPII).toBe(true);
      // Should have address-related category
      expect(result.piiCategories.length).toBeGreaterThan(0);
    });

    it('should not flag low-confidence detections as PII', async () => {
      const data = { notes: 'General comment' };

      const result = await nerService.detectPII(data);

      expect(result.hasPII).toBe(false);
      expect(result.piiCategories).toEqual([]);
    });

    it('should provide recommendation when PII detected', async () => {
      const data = { name: 'Dr. Jane Doe' };

      const result = await nerService.detectPII(data);

      expect(result.recommendation).toContain('DLP');
    });

    it('should provide default recommendation when no PII', async () => {
      const data = { id: '12345' };

      const result = await nerService.detectPII(data);

      expect(result.recommendation).toContain('No high-confidence PII');
    });
  });

  describe('redactEntities()', () => {
    it('should redact person names', () => {
      const text = 'Contact Dr. John Smith for assistance';
      const entities = [
        { type: 'PERSON' as const, value: 'Dr. John Smith', confidence: 0.9, field: 'test' }
      ];

      const redacted = nerService.redactEntities(text, entities);

      expect(redacted).toBe('Contact [REDACTED NAME] for assistance');
    });

    it('should redact addresses', () => {
      const text = 'Ship to 123 Main Street';
      const entities = [
        { type: 'ADDRESS' as const, value: '123 Main Street', confidence: 0.85, field: 'test' }
      ];

      const redacted = nerService.redactEntities(text, entities);

      expect(redacted).toBe('Ship to [REDACTED ADDRESS]');
    });

    it('should redact organizations', () => {
      const text = 'Invoice from Acme Inc.';
      const entities = [
        { type: 'ORGANIZATION' as const, value: 'Acme Inc.', confidence: 0.85, field: 'test' }
      ];

      const redacted = nerService.redactEntities(text, entities);

      expect(redacted).toBe('Invoice from [REDACTED ORG]');
    });

    it('should redact locations', () => {
      const text = 'Office in New York, NY 10001';
      const entities = [
        { type: 'LOCATION' as const, value: 'New York, NY 10001', confidence: 0.95, field: 'test' }
      ];

      const redacted = nerService.redactEntities(text, entities);

      expect(redacted).toBe('Office in [REDACTED LOCATION]');
    });

    it('should redact multiple entities', () => {
      const text = 'Dr. John Smith at 123 Main Street';
      const entities = [
        { type: 'PERSON' as const, value: 'Dr. John Smith', confidence: 0.9, field: 'test' },
        { type: 'ADDRESS' as const, value: '123 Main Street', confidence: 0.85, field: 'test' }
      ];

      const redacted = nerService.redactEntities(text, entities);

      expect(redacted).toBe('[REDACTED NAME] at [REDACTED ADDRESS]');
    });

    it('should handle empty entities array', () => {
      const text = 'No entities here';

      const redacted = nerService.redactEntities(text, []);

      expect(redacted).toBe(text);
    });
  });

  describe('error handling', () => {
    it('should return empty result on error', async () => {
      // Pass invalid data that might cause issues
      const invalidData = Symbol('invalid');

      const result = await nerService.detectEntities(invalidData);

      expect(result.detected).toBe(false);
      expect(result.entities).toEqual([]);
    });
  });
});
