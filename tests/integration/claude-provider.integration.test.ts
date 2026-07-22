/**
 * Integration Tests for Claude (Anthropic) Provider
 *
 * These tests use the server's AI proxy to test Claude provider functionality.
 *
 * Setup Instructions:
 * 1. Start server: npm start (default: http://localhost:3003)
 * 2. Configure Claude provider via UI at http://localhost:3003
 *    - Get API key from https://console.anthropic.com/settings/keys
 *    - Add provider configuration with API key and model
 * 3. Run tests: npm run test:integration
 *
 * Configuration:
 * - Tests query /api/ai/proxy/providers to check provider availability
 * - Tests use /api/ai/proxy/mapping/suggestions endpoint with preferredProvider='claude'
 * - Server handles API key authentication from database
 * - Uses configured model from database (claude-sonnet-4-5-20250929)
 * - Gracefully skips if provider not available
 *
 * Environment Variables:
 * - SERVER_BASE_URL: Server URL (default: http://localhost:3003)
 * - SKIP_INTEGRATION_TESTS: Set to 'true' to skip these tests
 *
 * @module claude-provider.integration.test
 */

import axios from 'axios';

// Skip these tests if SKIP_INTEGRATION_TESTS is set or Claude is not available
const skipIntegrationTests = process.env.SKIP_INTEGRATION_TESTS === 'true';
const describeIntegration = skipIntegrationTests ? describe.skip : describe;

interface DBProvider {
  id: number;
  providerType: string;
  isActive: boolean;
  hasApiKey: boolean;
  apiKey?: string;
  configuration: {
    model?: string;
  };
}

describeIntegration('Claude (Anthropic) Provider Integration Tests', () => {
  let claudeAvailable = false;
  let ANTHROPIC_API_KEY: string | undefined;
  let ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';
  const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
  const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'http://localhost:3003';
  const timeout = 30000; // 30 second timeout for Claude (based on Oct 13, 2025 tests)

  beforeAll(async () => {
    // Test Claude provider through server proxy (uses database API key)
    try {
      const response = await axios.get(`${SERVER_BASE_URL}/api/ai/proxy/providers`, {
        timeout: 5000
      });

      if (response.data?.success && response.data?.providers) {
        const claudeProvider = response.data.providers.find((p: any) => p.id === 'claude');

        if (!claudeProvider || !claudeProvider.available) {
          console.warn('⚠️ Claude provider not available via server', {
            status: claudeProvider?.status || 'Provider not found'
          });
          claudeAvailable = false;
          return;
        }

        claudeAvailable = true;
        console.log('✅ Claude is available via server proxy', {
          status: claudeProvider.status
        });
      } else {
        console.warn('⚠️ Failed to fetch providers from server - skipping Claude tests');
        claudeAvailable = false;
      }
    } catch (error) {
      console.warn('⚠️ Server not available', {
        serverURL: SERVER_BASE_URL,
        error: error instanceof Error ? error.message : String(error)
      });
      claudeAvailable = false;
    }
  }, timeout);

  describe('Claude Availability', () => {
    test('should detect if Claude is configured', () => {
      if (!claudeAvailable) {
        console.warn(`
⚠️  Claude Integration Tests Skipped

   Claude is not available or not configured in database

   To run these tests:
   1. Start server: npm start (http://localhost:3003)
   2. Get an API key from https://console.anthropic.com/settings/keys
   3. Configure Claude provider via UI at http://localhost:3003
   4. Re-run the tests
        `);
      }
      expect(typeof claudeAvailable).toBe('boolean');
    });
  });

  describe('Raw Claude API Testing', () => {
    test('should call Claude via server proxy successfully', async () => {
      if (!claudeAvailable) {
        console.log('⏭️  Skipping: Claude not available');
        return;
      }

      // Simple connectivity test via server proxy
      const response = await axios.post(
        `${SERVER_BASE_URL}/api/ai/proxy/mapping/suggestions`,
        {
          sourceSystem: 'Test',
          targetSystem: 'Test',
          sourceFields: [{ name: 'test_field', type: 'string' }],
          targetFields: [{ name: 'test_target', type: 'string' }],
          preferredProvider: 'claude'
        },
        {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect(response.data.success).toBe(true);

      console.log('✅ Claude Connection Test via Server Proxy:', {
        success: response.data.success,
        suggestions: response.data.suggestions?.length || 0
      });
    }, timeout);

    test('should generate field mapping analysis with Claude', async () => {
      if (!claudeAvailable) {
        console.log('⏭️  Skipping: Claude not available');
        return;
      }

      const response = await axios.post(
        `${SERVER_BASE_URL}/api/ai/proxy/mapping/suggestions`,
        {
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          sourceFields: [
            {
              name: 'customer_email',
              type: 'string',
              description: 'Customer email address',
              samples: ['john.doe@example.com', 'jane.smith@company.com']
            }
          ],
          targetFields: [
            {
              name: 'email_address',
              type: 'string',
              description: 'Primary email address'
            },
            {
              name: 'contact_email',
              type: 'string',
              description: 'Contact email'
            },
            {
              name: 'billing_email',
              type: 'string',
              description: 'Email for billing notifications'
            }
          ],
          preferredProvider: 'claude'
        },
        {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.suggestions).toBeDefined();
      expect(response.data.suggestions.length).toBeGreaterThan(0);

      const firstSuggestion = response.data.suggestions[0];
      console.log('✅ Field Mapping Analysis via Server Proxy:', {
        sourceField: firstSuggestion.sourceFieldName,
        targetField: firstSuggestion.targetFieldName,
        confidence: firstSuggestion.confidence,
        mappingType: firstSuggestion.mappingType
      });
    }, timeout);

    test('should calculate semantic similarity with Claude', async () => {
      if (!claudeAvailable) {
        console.log('⏭️  Skipping: Claude not available');
        return;
      }

      // Test semantic similarity via field mapping suggestions
      const response = await axios.post(
        `${SERVER_BASE_URL}/api/ai/proxy/mapping/suggestions`,
        {
          sourceSystem: 'CRM',
          targetSystem: 'Database',
          sourceFields: [
            { name: 'customer_email', type: 'string' }
          ],
          targetFields: [
            { name: 'email_address', type: 'string' }
          ],
          preferredProvider: 'claude'
        },
        {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.suggestions).toBeDefined();
      expect(response.data.suggestions.length).toBeGreaterThan(0);
      expect(response.data.suggestions[0].confidence).toBeGreaterThan(0.5); // Should be high for email fields

      console.log('✅ Similarity Calculation via Server Proxy:', {
        confidence: response.data.suggestions[0].confidence,
        sourceField: response.data.suggestions[0].sourceFieldName,
        targetField: response.data.suggestions[0].targetFieldName
      });
    }, timeout);
  });

  describe('Performance Benchmarks', () => {
    test('should complete simple analysis within 30 seconds', async () => {
      if (!claudeAvailable) {
        console.log('⏭️  Skipping: Claude not available');
        return;
      }

      const startTime = Date.now();

      const response = await axios.post(
        `${SERVER_BASE_URL}/api/ai/proxy/mapping/suggestions`,
        {
          sourceSystem: 'Test',
          targetSystem: 'Test',
          sourceFields: [{ name: 'test', type: 'string' }],
          targetFields: [{ name: 'test', type: 'string' }],
          preferredProvider: 'claude'
        },
        {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      const totalTime = Date.now() - startTime;

      expect(totalTime).toBeLessThan(timeout);
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);

      console.log('✅ Performance via Server Proxy:', {
        totalTime: `${totalTime}ms`,
        success: response.data.success
      });
    }, timeout);
  });
});
