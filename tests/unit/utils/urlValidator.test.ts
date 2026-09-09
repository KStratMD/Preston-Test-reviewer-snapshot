import { validateUrlForSsrf, validateUrlForSsrfSync } from '../../../src/utils/urlValidator';

describe('urlValidator', () => {
  describe('validateUrlForSsrfSync', () => {
    it('should allow valid public URLs', () => {
      expect(validateUrlForSsrfSync('https://api.example.com/data').valid).toBe(true);
      expect(validateUrlForSsrfSync('https://www.google.com').valid).toBe(true);
      expect(validateUrlForSsrfSync('http://cdn.example.org/file.json').valid).toBe(true);
    });

    it('should block private IP addresses', () => {
      // 10.x.x.x range
      expect(validateUrlForSsrfSync('http://10.0.0.1/api').valid).toBe(false);
      expect(validateUrlForSsrfSync('http://10.255.255.255/api').valid).toBe(false);

      // 172.16.x.x - 172.31.x.x range
      expect(validateUrlForSsrfSync('http://172.16.0.1/api').valid).toBe(false);
      expect(validateUrlForSsrfSync('http://172.31.255.255/api').valid).toBe(false);

      // 192.168.x.x range
      expect(validateUrlForSsrfSync('http://192.168.1.1/api').valid).toBe(false);
      expect(validateUrlForSsrfSync('http://192.168.0.100/api').valid).toBe(false);

      // Loopback
      expect(validateUrlForSsrfSync('http://127.0.0.1/api').valid).toBe(false);
      expect(validateUrlForSsrfSync('http://127.0.0.1:8080/api').valid).toBe(false);
    });

    it('should handle localhost based on configuration', () => {
      // With allowLocalhost false, localhost should be blocked
      expect(validateUrlForSsrfSync('http://localhost/api', { allowLocalhost: false }).valid).toBe(false);
      expect(validateUrlForSsrfSync('http://localhost:3000/api', { allowLocalhost: false }).valid).toBe(false);

      // With allowLocalhost true, localhost should be allowed
      expect(validateUrlForSsrfSync('http://localhost/api', { allowLocalhost: true }).valid).toBe(true);
      expect(validateUrlForSsrfSync('http://localhost:3000/api', { allowLocalhost: true }).valid).toBe(true);
    });

    it('should block cloud metadata endpoints', () => {
      // AWS/Azure metadata IP
      expect(validateUrlForSsrfSync('http://169.254.169.254/latest/meta-data/').valid).toBe(false);

      // GCP metadata hostname
      expect(validateUrlForSsrfSync('http://metadata.google.internal/computeMetadata/v1/').valid).toBe(false);
    });

    it('should reject invalid URLs', () => {
      expect(validateUrlForSsrfSync('not-a-url').valid).toBe(false);
      expect(validateUrlForSsrfSync('').valid).toBe(false);
    });

    it('should reject non-HTTP protocols', () => {
      expect(validateUrlForSsrfSync('ftp://files.example.com').valid).toBe(false);
      expect(validateUrlForSsrfSync('file:///etc/passwd').valid).toBe(false);
    });

    it('should allow non-private 172.x addresses', () => {
      // 172.15.x.x is NOT private (only 172.16-31 are)
      expect(validateUrlForSsrfSync('http://172.15.0.1/api').valid).toBe(true);
      // 172.32.x.x is NOT private
      expect(validateUrlForSsrfSync('http://172.32.0.1/api').valid).toBe(true);
    });

    it('should include error messages for blocked URLs', () => {
      const result = validateUrlForSsrfSync('http://192.168.1.1/api');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Private IP');
    });

    it('should respect config overrides', () => {
      // Normally private IPs are blocked
      expect(validateUrlForSsrfSync('http://10.0.0.1/api').valid).toBe(false);

      // But can be allowed with config
      expect(validateUrlForSsrfSync('http://10.0.0.1/api', { allowPrivateIps: true }).valid).toBe(true);
    });
  });

  describe('validateUrlForSsrf (async)', () => {
    it('should allow valid public URLs', async () => {
      // Use skipDnsCheck to avoid actual DNS lookups in tests
      const result = await validateUrlForSsrf('https://api.example.com/data', { skipDnsCheck: true });
      expect(result.valid).toBe(true);
    });

    it('should block private IP addresses', async () => {
      const result = await validateUrlForSsrf('http://10.0.0.1/api', { skipDnsCheck: true });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Private IP');
    });

    it('should block cloud metadata endpoints', async () => {
      const result = await validateUrlForSsrf('http://169.254.169.254/latest/meta-data/', { skipDnsCheck: true });
      expect(result.valid).toBe(false);
    });

    it('should reject invalid URLs', async () => {
      const result = await validateUrlForSsrf('not-a-url');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid URL');
    });

    it('should return resolved IP when valid', async () => {
      const result = await validateUrlForSsrf('http://8.8.8.8/api', { skipDnsCheck: true });
      expect(result.valid).toBe(true);
      expect(result.resolvedIp).toBe('8.8.8.8');
    });
  });
});
