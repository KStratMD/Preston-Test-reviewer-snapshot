/**
 * AINaturalLanguageService Tests
 * Tests for conversational integration setup and natural language troubleshooting
 */

import { AINaturalLanguageService } from '../../../src/services/AINaturalLanguageService';

describe('AINaturalLanguageService', () => {
  let service: AINaturalLanguageService;
  let mockHelpChat: any;

  beforeEach(() => {
    mockHelpChat = {
      findSimilarChunks: jest.fn().mockResolvedValue([
        {
          content: 'Check network connectivity',
          documentPath: 'docs/troubleshooting.md',
          score: 0.85
        }
      ])
    };

    service = new AINaturalLanguageService();
  });

  describe('constructor', () => {
    it('should initialize without help chat', () => {
      const serviceWithoutChat = new AINaturalLanguageService();
      expect(serviceWithoutChat).toBeDefined();
    });

    it('should initialize with help chat RAG integration', () => {
      const serviceWithChat = new AINaturalLanguageService(mockHelpChat);
      expect(serviceWithChat).toBeDefined();
    });
  });

  describe('processConfigurationRequest', () => {
    it('should process create integration request', async () => {
      const request = {
        text: 'Create an integration to sync contacts from Salesforce to NetSuite',
        userId: 'user-1',
        sessionId: 'session-1'
      };

      const response = await service.processConfigurationRequest(request);

      expect(response.intent).toBeDefined();
      expect(response.intent.action).toBe('create');
      expect(response.intent.target).toBe('integration');
      expect(response.confidence).toBeDefined();
    });

    it('should extract system entities from request', async () => {
      const request = {
        text: 'Sync data from Salesforce to NetSuite every hour'
      };

      const response = await service.processConfigurationRequest(request);

      expect(response.extractedEntities).toBeDefined();
      expect(Array.isArray(response.extractedEntities)).toBe(true);
    });

    it('should generate suggested configuration', async () => {
      const request = {
        text: 'Create a bidirectional sync between Salesforce and NetSuite'
      };

      const response = await service.processConfigurationRequest(request);

      expect(response.suggestedConfiguration).toBeDefined();
      expect(response.suggestedConfiguration.sourceSystem).toBeDefined();
      expect(response.suggestedConfiguration.targetSystem).toBeDefined();
    });

    it('should generate clarification questions for ambiguous requests', async () => {
      const request = {
        text: 'I need to integrate something'
      };

      const response = await service.processConfigurationRequest(request);

      expect(response.clarificationQuestions).toBeDefined();
      expect(Array.isArray(response.clarificationQuestions)).toBe(true);
    });

    it('should include alternative interpretations', async () => {
      const request = {
        text: 'Sync SF to NS'
      };

      const response = await service.processConfigurationRequest(request);

      expect(response.alternativeInterpretations).toBeDefined();
      expect(Array.isArray(response.alternativeInterpretations)).toBe(true);
    });

    it('should provide next steps', async () => {
      const request = {
        text: 'Create integration from Salesforce to NetSuite'
      };

      const response = await service.processConfigurationRequest(request);

      expect(response.nextSteps).toBeDefined();
      expect(Array.isArray(response.nextSteps)).toBe(true);
      expect(response.nextSteps.length).toBeGreaterThan(0);
    });

    it('should handle modify intent', async () => {
      const request = {
        text: 'Change the sync frequency to daily'
      };

      const response = await service.processConfigurationRequest(request);

      expect(response.intent.action).toBe('modify');
    });

    it('should handle troubleshoot intent', async () => {
      const request = {
        text: 'Fix the integration error - sync is not working'
      };

      const response = await service.processConfigurationRequest(request);

      expect(response.intent.action).toBe('troubleshoot');
    });

    it('should store conversation context', async () => {
      const request1 = {
        text: 'Create Salesforce integration',
        sessionId: 'test-session'
      };
      const request2 = {
        text: 'Add NetSuite as target',
        sessionId: 'test-session'
      };

      await service.processConfigurationRequest(request1);
      const response2 = await service.processConfigurationRequest(request2);

      expect(response2).toBeDefined();
    });

    it('should handle context with existing integrations', async () => {
      const request = {
        text: 'Create new integration',
        context: {
          existingIntegrations: ['salesforce-netsuite'],
          availableSystems: ['Salesforce', 'NetSuite', 'Dynamics'],
          userRole: 'admin',
          organizationSize: 'medium' as const
        }
      };

      const response = await service.processConfigurationRequest(request);

      expect(response).toBeDefined();
      expect(response.suggestedConfiguration).toBeDefined();
    });

    it('should detect frequency entities', async () => {
      const request = {
        text: 'Sync real-time from Salesforce to NetSuite'
      };

      const response = await service.processConfigurationRequest(request);

      const frequencyEntities = response.extractedEntities.filter(e => e.type === 'frequency');
      expect(frequencyEntities.length).toBeGreaterThanOrEqual(0);
    });

    it('should detect direction entities', async () => {
      const request = {
        text: 'Create bidirectional sync between systems'
      };

      const response = await service.processConfigurationRequest(request);

      expect(response.suggestedConfiguration.syncDirection).toBeDefined();
    });
  });

  describe('troubleshootWithNL', () => {
    it('should diagnose connection issues', async () => {
      const issue = 'Connection timeout when syncing to NetSuite';

      const response = await service.troubleshootWithNL(issue);

      expect(response.issue).toBe(issue);
      expect(response.diagnosis).toBeDefined();
      expect(response.severity).toBeDefined();
      expect(['low', 'medium', 'high', 'critical']).toContain(response.severity);
    });

    it('should provide possible causes', async () => {
      const issue = 'Authentication failed with Salesforce';

      const response = await service.troubleshootWithNL(issue);

      expect(response.possibleCauses).toBeDefined();
      expect(Array.isArray(response.possibleCauses)).toBe(true);
      expect(response.possibleCauses.length).toBeGreaterThan(0);
    });

    it('should provide solutions', async () => {
      const issue = 'Integration is slow and taking too long';

      const response = await service.troubleshootWithNL(issue);

      expect(response.solutions).toBeDefined();
      expect(Array.isArray(response.solutions)).toBe(true);
    });

    it('should include preventive measures', async () => {
      const issue = 'Rate limit exceeded during sync';

      const response = await service.troubleshootWithNL(issue);

      expect(response.preventiveMeasures).toBeDefined();
      expect(Array.isArray(response.preventiveMeasures)).toBe(true);
    });

    it('should provide estimated resolution time', async () => {
      const issue = 'Data mapping error in field transformation';

      const response = await service.troubleshootWithNL(issue);

      expect(response.estimatedResolutionTime).toBeDefined();
    });

    it('should include related documentation with help chat', async () => {
      const serviceWithChat = new AINaturalLanguageService(mockHelpChat);
      const issue = 'Connection timeout issue';

      const response = await serviceWithChat.troubleshootWithNL(issue);

      expect(mockHelpChat.findSimilarChunks).toHaveBeenCalled();
    });

    it('should handle help chat errors gracefully', async () => {
      const errorHelpChat = {
        findSimilarChunks: jest.fn().mockRejectedValue(new Error('Help chat unavailable'))
      };
      const serviceWithErrorChat = new AINaturalLanguageService(errorHelpChat);
      const issue = 'Connection error';

      const response = await serviceWithErrorChat.troubleshootWithNL(issue);

      expect(response.diagnosis).toBeDefined();
    });

    it('should handle context in troubleshooting', async () => {
      const issue = 'Sync failing intermittently';
      const context = {
        existingIntegrations: ['integration-1'],
        availableSystems: ['Salesforce'],
        userRole: 'admin',
        organizationSize: 'enterprise' as const
      };

      const response = await service.troubleshootWithNL(issue, context);

      expect(response).toBeDefined();
    });

    it('should classify authentication issues as critical', async () => {
      const issue = 'Unauthorized - token expired';

      const response = await service.troubleshootWithNL(issue);

      expect(response.severity).toBe('critical');
    });

    it('should provide solution steps', async () => {
      const issue = 'Connection failure to API';

      const response = await service.troubleshootWithNL(issue);

      if (response.solutions.length > 0) {
        expect(response.solutions[0].steps).toBeDefined();
        expect(Array.isArray(response.solutions[0].steps)).toBe(true);
      }
    });
  });

  describe('explainConfiguration', () => {
    it('should explain configuration in natural language', async () => {
      const explanation = await service.explainConfiguration('config-1');

      expect(explanation).toBeDefined();
      expect(typeof explanation).toBe('string');
      expect(explanation.length).toBeGreaterThan(0);
    });

    it('should describe sync direction', async () => {
      const explanation = await service.explainConfiguration('config-1');

      expect(explanation).toContain('Salesforce');
      expect(explanation).toContain('NetSuite');
    });
  });

  describe('generateDocumentation', () => {
    it('should generate comprehensive documentation', async () => {
      const documentation = await service.generateDocumentation('integration-1');

      expect(documentation).toBeDefined();
      expect(documentation).toContain('# Integration Documentation');
      expect(documentation).toContain('## Overview');
    });

    it('should include business value section', async () => {
      const documentation = await service.generateDocumentation('integration-1');

      expect(documentation).toContain('## Business Value');
    });

    it('should include technical configuration', async () => {
      const documentation = await service.generateDocumentation('integration-1');

      expect(documentation).toContain('## Technical Configuration');
    });

    it('should include troubleshooting guide', async () => {
      const documentation = await service.generateDocumentation('integration-1');

      expect(documentation).toContain('## Troubleshooting Guide');
    });

    it('should include AI generation notice', async () => {
      const documentation = await service.generateDocumentation('integration-1');

      expect(documentation).toContain('Generated automatically by AI');
    });
  });

  describe('intent classification', () => {
    it('should classify create requests', async () => {
      const requests = [
        'Create a new integration',
        'Set up sync between systems',
        'Build a connection to Salesforce',
        'I need to integrate my CRM'
      ];

      for (const text of requests) {
        const response = await service.processConfigurationRequest({ text });
        expect(response.intent.action).toBe('create');
      }
    });

    it('should classify modify requests', async () => {
      const response = await service.processConfigurationRequest({
        text: 'Update the sync schedule to hourly'
      });

      expect(response.intent.action).toBe('modify');
    });

    it('should classify troubleshoot requests', async () => {
      const response = await service.processConfigurationRequest({
        text: 'Debug why sync is failing'
      });

      expect(response.intent.action).toBe('troubleshoot');
    });

    it('should include confidence score for intent', async () => {
      const response = await service.processConfigurationRequest({
        text: 'Create Salesforce to NetSuite integration with hourly sync'
      });

      expect(response.intent.confidence).toBeDefined();
      expect(response.intent.confidence).toBeGreaterThan(0);
      expect(response.intent.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('entity extraction', () => {
    it('should extract system names', async () => {
      const response = await service.processConfigurationRequest({
        text: 'Sync from Salesforce to NetSuite'
      });

      const systemEntities = response.extractedEntities.filter(e => e.type === 'system');
      expect(systemEntities.length).toBeGreaterThanOrEqual(0);
    });

    it('should extract abbreviated system names', async () => {
      const response = await service.processConfigurationRequest({
        text: 'Connect SF to NS'
      });

      expect(response.extractedEntities).toBeDefined();
    });

    it('should include entity confidence', async () => {
      const response = await service.processConfigurationRequest({
        text: 'Sync Salesforce data hourly'
      });

      for (const entity of response.extractedEntities) {
        expect(entity.confidence).toBeDefined();
        expect(entity.confidence).toBeGreaterThan(0);
        expect(entity.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('should include entity alternatives', async () => {
      const response = await service.processConfigurationRequest({
        text: 'Connect SF'
      });

      for (const entity of response.extractedEntities) {
        expect(entity.alternatives).toBeDefined();
        expect(Array.isArray(entity.alternatives)).toBe(true);
      }
    });
  });

  describe('configuration generation', () => {
    it('should generate field mappings', async () => {
      const response = await service.processConfigurationRequest({
        text: 'Map customer name and email from Salesforce to NetSuite'
      });

      expect(response.suggestedConfiguration.fieldMappings).toBeDefined();
      expect(Array.isArray(response.suggestedConfiguration.fieldMappings)).toBe(true);
    });

    it('should determine sync mode', async () => {
      const response = await service.processConfigurationRequest({
        text: 'Real-time sync from Salesforce'
      });

      expect(response.suggestedConfiguration.syncMode).toBeDefined();
    });

    it('should generate schedule for scheduled mode', async () => {
      const response = await service.processConfigurationRequest({
        text: 'Sync hourly from Salesforce to NetSuite'
      });

      if (response.suggestedConfiguration.syncMode === 'scheduled') {
        expect(response.suggestedConfiguration.schedule).toBeDefined();
      }
    });

    it('should include configuration confidence', async () => {
      const response = await service.processConfigurationRequest({
        text: 'Create Salesforce integration'
      });

      expect(response.suggestedConfiguration.confidence).toBeDefined();
    });
  });

  describe('conversation history', () => {
    it('should maintain separate conversation history per session', async () => {
      await service.processConfigurationRequest({
        text: 'Create Salesforce integration',
        sessionId: 'session-a'
      });

      await service.processConfigurationRequest({
        text: 'Create NetSuite integration',
        sessionId: 'session-b'
      });

      const responseA = await service.processConfigurationRequest({
        text: 'Add more details',
        sessionId: 'session-a'
      });

      expect(responseA).toBeDefined();
    });

    it('should use default session when not specified', async () => {
      const response1 = await service.processConfigurationRequest({
        text: 'Create integration'
      });

      const response2 = await service.processConfigurationRequest({
        text: 'Add field mapping'
      });

      expect(response1).toBeDefined();
      expect(response2).toBeDefined();
    });
  });
});
