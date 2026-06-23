/**
 * Connector Helpers Unit Tests
 * Tests for connector field mapping helper functions
 */

import { mapCommonFields, mapFromCommonFields } from '../../../src/utils/connectorHelpers';

describe('connectorHelpers', () => {
  describe('mapCommonFields', () => {
    it('should map fields according to field map', () => {
      const source = { firstName: 'John', lastName: 'Doe', email: 'john@example.com' };
      const fieldMap = { firstName: 'first_name', lastName: 'last_name' };

      const result = mapCommonFields(source, fieldMap);

      expect(result).toEqual({
        first_name: 'John',
        last_name: 'Doe',
        email: 'john@example.com', // unmapped field keeps original name
      });
    });

    it('should preserve unmapped fields with original name', () => {
      const source = { id: 123, name: 'Test', custom: 'value' };
      const fieldMap = { name: 'display_name' };

      const result = mapCommonFields(source, fieldMap);

      expect(result).toEqual({
        id: 123,
        display_name: 'Test',
        custom: 'value',
      });
    });

    it('should handle empty source', () => {
      const source = {};
      const fieldMap = { firstName: 'first_name' };

      const result = mapCommonFields(source, fieldMap);

      expect(result).toEqual({});
    });

    it('should handle empty field map', () => {
      const source = { id: 123, name: 'Test' };
      const fieldMap = {};

      const result = mapCommonFields(source, fieldMap);

      expect(result).toEqual({ id: 123, name: 'Test' });
    });

    it('should handle various value types', () => {
      const source = {
        string: 'text',
        number: 42,
        boolean: true,
        array: [1, 2, 3],
        object: { nested: 'value' },
        nullValue: null,
      };
      const fieldMap = { string: 'str', number: 'num' };

      const result = mapCommonFields(source, fieldMap);

      expect(result).toEqual({
        str: 'text',
        num: 42,
        boolean: true,
        array: [1, 2, 3],
        object: { nested: 'value' },
        nullValue: null,
      });
    });
  });

  describe('mapFromCommonFields', () => {
    it('should map fields using inverse of field map', () => {
      const source = { first_name: 'John', last_name: 'Doe', email: 'john@example.com' };
      const fieldMap = { firstName: 'first_name', lastName: 'last_name' };

      const result = mapFromCommonFields(source, fieldMap);

      expect(result).toEqual({
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
      });
    });

    it('should preserve unmapped fields with original name', () => {
      const source = { display_name: 'Test', id: 123, custom: 'value' };
      const fieldMap = { name: 'display_name' };

      const result = mapFromCommonFields(source, fieldMap);

      expect(result).toEqual({
        name: 'Test',
        id: 123,
        custom: 'value',
      });
    });

    it('should handle empty source', () => {
      const source = {};
      const fieldMap = { firstName: 'first_name' };

      const result = mapFromCommonFields(source, fieldMap);

      expect(result).toEqual({});
    });

    it('should handle empty field map', () => {
      const source = { id: 123, name: 'Test' };
      const fieldMap = {};

      const result = mapFromCommonFields(source, fieldMap);

      expect(result).toEqual({ id: 123, name: 'Test' });
    });

    it('should be inverse of mapCommonFields', () => {
      const original = { firstName: 'John', lastName: 'Doe' };
      const fieldMap = { firstName: 'first_name', lastName: 'last_name' };

      const mapped = mapCommonFields(original, fieldMap);
      const restored = mapFromCommonFields(mapped, fieldMap);

      expect(restored).toEqual(original);
    });

    it('should handle various value types', () => {
      const source = {
        str: 'text',
        num: 42,
        boolean: true,
        array: [1, 2, 3],
        object: { nested: 'value' },
      };
      const fieldMap = { string: 'str', number: 'num' };

      const result = mapFromCommonFields(source, fieldMap);

      expect(result).toEqual({
        string: 'text',
        number: 42,
        boolean: true,
        array: [1, 2, 3],
        object: { nested: 'value' },
      });
    });
  });
});
