/**
 * OAuth1 Helper Unit Tests
 * Tests for OAuth 1.0 signature generation utilities
 */

import { generateOAuth1Signature, getOAuth1AuthorizationHeader, OAuth1Params } from '../../../src/utils/oauth1Helper';

describe('oauth1Helper', () => {
  const baseParams: OAuth1Params = {
    consumerKey: 'test-consumer-key',
    consumerSecret: 'test-consumer-secret',
    tokenId: 'test-token-id',
    tokenSecret: 'test-token-secret',
    nonce: 'abc123xyz',
    timestamp: '1234567890',
  };

  describe('generateOAuth1Signature', () => {
    it('should generate signature with default HMAC-SHA256', () => {
      const signature = generateOAuth1Signature(
        'GET',
        'https://api.example.com/test',
        baseParams
      );

      expect(signature).toBeTruthy();
      expect(typeof signature).toBe('string');
      // Base64 encoded signature
      expect(signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('should generate signature with HMAC-SHA1', () => {
      const params: OAuth1Params = {
        ...baseParams,
        signatureMethod: 'HMAC-SHA1',
      };

      const signature = generateOAuth1Signature(
        'GET',
        'https://api.example.com/test',
        params
      );

      expect(signature).toBeTruthy();
      expect(typeof signature).toBe('string');
    });

    it('should handle POST method', () => {
      const signature = generateOAuth1Signature(
        'POST',
        'https://api.example.com/test',
        baseParams
      );

      expect(signature).toBeTruthy();
    });

    it('should handle URL with query parameters', () => {
      const signature = generateOAuth1Signature(
        'GET',
        'https://api.example.com/test?param1=value1&param2=value2',
        baseParams
      );

      expect(signature).toBeTruthy();
    });

    it('should include extra params in signature', () => {
      const params: OAuth1Params = {
        ...baseParams,
        extraParams: {
          custom_param: 'custom_value',
        },
      };

      const signature = generateOAuth1Signature(
        'GET',
        'https://api.example.com/test',
        params
      );

      expect(signature).toBeTruthy();
    });

    it('should skip undefined extra params', () => {
      const params: OAuth1Params = {
        ...baseParams,
        extraParams: {
          defined_param: 'value',
          undefined_param: undefined,
        },
      };

      const signature = generateOAuth1Signature(
        'GET',
        'https://api.example.com/test',
        params
      );

      expect(signature).toBeTruthy();
    });

    it('should handle body parameter', () => {
      const signature = generateOAuth1Signature(
        'POST',
        'https://api.example.com/test',
        baseParams,
        '{"data":"value"}'
      );

      expect(signature).toBeTruthy();
    });

    it('should produce consistent signatures for same input', () => {
      const sig1 = generateOAuth1Signature('GET', 'https://api.example.com/test', baseParams);
      const sig2 = generateOAuth1Signature('GET', 'https://api.example.com/test', baseParams);

      expect(sig1).toBe(sig2);
    });

    it('should produce different signatures for different nonces', () => {
      const params1 = { ...baseParams, nonce: 'nonce1' };
      const params2 = { ...baseParams, nonce: 'nonce2' };

      const sig1 = generateOAuth1Signature('GET', 'https://api.example.com/test', params1);
      const sig2 = generateOAuth1Signature('GET', 'https://api.example.com/test', params2);

      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different URLs', () => {
      const sig1 = generateOAuth1Signature('GET', 'https://api.example.com/test1', baseParams);
      const sig2 = generateOAuth1Signature('GET', 'https://api.example.com/test2', baseParams);

      expect(sig1).not.toBe(sig2);
    });
  });

  describe('getOAuth1AuthorizationHeader', () => {
    it('should generate valid OAuth header', () => {
      const header = getOAuth1AuthorizationHeader(
        'GET',
        'https://api.example.com/test',
        baseParams
      );

      expect(header).toMatch(/^OAuth /);
      expect(header).toContain('oauth_consumer_key=');
      expect(header).toContain('oauth_token=');
      expect(header).toContain('oauth_signature_method=');
      expect(header).toContain('oauth_timestamp=');
      expect(header).toContain('oauth_nonce=');
      expect(header).toContain('oauth_version=');
      expect(header).toContain('oauth_signature=');
    });

    it('should include realm when provided', () => {
      const params: OAuth1Params = {
        ...baseParams,
        realm: 'test-realm',
      };

      const header = getOAuth1AuthorizationHeader(
        'GET',
        'https://api.example.com/test',
        params
      );

      expect(header).toContain('realm="test-realm"');
    });

    it('should not include realm when not provided', () => {
      const header = getOAuth1AuthorizationHeader(
        'GET',
        'https://api.example.com/test',
        baseParams
      );

      expect(header).not.toContain('realm=');
    });

    it('should use default version 1.0', () => {
      const header = getOAuth1AuthorizationHeader(
        'GET',
        'https://api.example.com/test',
        baseParams
      );

      expect(header).toContain('oauth_version="1.0"');
    });

    it('should use custom version when provided', () => {
      const params: OAuth1Params = {
        ...baseParams,
        version: '2.0',
      };

      const header = getOAuth1AuthorizationHeader(
        'GET',
        'https://api.example.com/test',
        params
      );

      expect(header).toContain('oauth_version="2.0"');
    });

    it('should URL-encode values', () => {
      const params: OAuth1Params = {
        ...baseParams,
        consumerKey: 'key with spaces',
      };

      const header = getOAuth1AuthorizationHeader(
        'GET',
        'https://api.example.com/test',
        params
      );

      expect(header).toContain('oauth_consumer_key="key%20with%20spaces"');
    });

    it('should handle body parameter', () => {
      const header = getOAuth1AuthorizationHeader(
        'POST',
        'https://api.example.com/test',
        baseParams,
        '{"data":"value"}'
      );

      expect(header).toMatch(/^OAuth /);
      expect(header).toContain('oauth_signature=');
    });
  });
});
