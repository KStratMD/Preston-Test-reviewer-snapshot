import {
  assertSafeFieldPath,
  fieldPathsFromPayload,
  pickPayloadFields,
} from '../../../../src/governance/sourceOfTruth/fieldLevelPayload';

describe('fieldLevelPayload helpers', () => {
  describe('fieldPathsFromPayload', () => {
    it('extracts dotted paths from nested payload leaves', () => {
      expect(fieldPathsFromPayload({
        name: 'Acme',
        marketingConsent: {
          email: true,
          sms: false,
        },
      })).toEqual(['marketingConsent.email', 'marketingConsent.sms', 'name']);
    });

    it('preserves null as an explicit leaf update', () => {
      expect(fieldPathsFromPayload({
        middleName: null,
        profile: { nickname: null },
      })).toEqual(['middleName', 'profile.nickname']);
    });

    it('treats arrays as atomic leaves', () => {
      expect(fieldPathsFromPayload({
        tags: ['vip', 'newsletter'],
        profile: { aliases: ['A', 'B'] },
      })).toEqual(['profile.aliases', 'tags']);
    });

    it('treats empty objects as atomic leaves', () => {
      expect(fieldPathsFromPayload({ settings: {} })).toEqual(['settings']);
    });

    it('returns an empty field set for non-object payloads', () => {
      expect(fieldPathsFromPayload(null)).toEqual([]);
      expect(fieldPathsFromPayload(['not', 'a', 'record'])).toEqual([]);
      expect(fieldPathsFromPayload('name')).toEqual([]);
    });

    it('rejects prototype-pollution path segments', () => {
      expect(() => fieldPathsFromPayload(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(/unsafe field path segment/);
      expect(() => fieldPathsFromPayload({ constructor: { prototype: true } })).toThrow(/unsafe field path segment/);
      expect(() => fieldPathsFromPayload({ profile: { prototype: true } })).toThrow(/unsafe field path segment/);
    });
  });

  describe('pickPayloadFields', () => {
    it('reconstructs only explicitly allowed dotted leaves', () => {
      const picked = pickPayloadFields(
        {
          name: 'Acme',
          salesPipelineStage: 'negotiation',
          marketingConsent: {
            email: true,
            sms: false,
          },
        },
        ['salesPipelineStage', 'marketingConsent.email'],
      );

      expect(picked).toEqual({
        salesPipelineStage: 'negotiation',
        marketingConsent: { email: true },
      });
    });

    it('does not copy descendants for a parent path unless the parent is an exact leaf', () => {
      expect(pickPayloadFields(
        { marketingConsent: { email: true } },
        ['marketingConsent'],
      )).toEqual({});
      expect(pickPayloadFields(
        { marketingConsent: {} },
        ['marketingConsent'],
      )).toEqual({ marketingConsent: {} });
    });

    it('preserves null and arrays in picked fields', () => {
      expect(pickPayloadFields(
        { middleName: null, tags: ['vip'], ignored: 'x' },
        ['middleName', 'tags'],
      )).toEqual({ middleName: null, tags: ['vip'] });
    });

    it('returns an empty object when no allowed paths exist in the payload', () => {
      expect(pickPayloadFields({ name: 'Acme' }, ['salesPipelineStage'])).toEqual({});
    });

    it('rejects unsafe allowed paths', () => {
      expect(() => pickPayloadFields({ safe: 'x' }, ['safe.__proto__'])).toThrow(/unsafe field path segment/);
    });
  });

  describe('assertSafeFieldPath', () => {
    it('rejects empty paths and empty segments', () => {
      expect(() => assertSafeFieldPath('')).toThrow(/empty/);
      expect(() => assertSafeFieldPath('a..b')).toThrow(/empty/);
      expect(() => assertSafeFieldPath('.a')).toThrow(/empty/);
      expect(() => assertSafeFieldPath('a.')).toThrow(/empty/);
    });
  });
});