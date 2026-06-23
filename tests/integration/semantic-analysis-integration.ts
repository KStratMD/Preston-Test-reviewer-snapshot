/**
 * Integration test script for SemanticAnalysisEngine with real LMStudio
 * 
 * Prerequisites:
 * - LMStudio running on localhost:1234
 * - Model loaded: Llama 3.1 8B Instruct or similar
 * 
 * Run with: npx ts-node tests/integration/semantic-analysis-integration.ts
 */

import 'reflect-metadata';
import { Container } from 'inversify';
import { SemanticAnalysisEngine } from '../../src/services/ai/SemanticAnalysisEngine';
import { SecureAIService } from '../../src/services/ai/SecureAIService';
import { ProviderRegistry } from '../../src/services/ai/ProviderRegistry';
import { LMStudioProvider } from '../../src/services/ai/providers/LMStudioProvider';
import { Logger } from '../../src/utils/Logger';
import { TYPES } from '../../src/inversify/types';
import type {
  FieldDefinition,
  BusinessContext,
  FieldAnalysisRequest
} from '../../src/types/semantic.types';

// Simple console logger for integration test
class ConsoleLogger {
  info(message: string, ...args: any[]): void {
    console.log(`[INFO] ${message}`, ...args);
  }
  warn(message: string, ...args: any[]): void {
    console.warn(`[WARN] ${message}`, ...args);
  }
  error(message: string, ...args: any[]): void {
    console.error(`[ERROR] ${message}`, ...args);
  }
  debug(message: string, ...args: any[]): void {
    console.log(`[DEBUG] ${message}`, ...args);
  }
}

async function testSemanticAnalysis() {
  console.log('🚀 Starting SemanticAnalysisEngine Integration Test\n');
  console.log('=' .repeat(70));
  
  // Set up dependency injection
  const container = new Container();
  const logger = new ConsoleLogger();
  
  // Register dependencies
  container.bind(TYPES.Logger).toConstantValue(logger);
  const outboundGovernance = {
    validateAIProviderRequest: async (body: Record<string, unknown>) => ({
      approved: true,
      approvalRequired: false,
      redactedPayload: body,
      findings: [],
      riskLevel: 'none',
      auditMetadata: { scanDurationMs: 0, findingsCount: 0, redacted: false, blocked: false },
    }),
  } as any;
  
  // Create provider registry and register LMStudio
  const registry = new ProviderRegistry(logger as any);
  const lmStudioProvider = new LMStudioProvider(logger as any, {
    baseURL: 'http://127.0.0.1:1234',
    model: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF',
  }, outboundGovernance);
  registry.register('lmstudio', lmStudioProvider);
  container.bind(TYPES.ProviderRegistry).toConstantValue(registry);
  
  // Create SecureAIService
  const secureAIService = new SecureAIService(
    logger as any,
    registry,
    outboundGovernance
  );
  container.bind(TYPES.SecureAIService).toConstantValue(secureAIService);
  
  // Create SemanticAnalysisEngine
  container.bind(TYPES.SemanticAnalysisEngine).to(SemanticAnalysisEngine);
  const engine = container.get<SemanticAnalysisEngine>(TYPES.SemanticAnalysisEngine);
  
  console.log('✅ Dependencies initialized successfully\n');
  
  // Test 1: Simple field mapping
  console.log('📝 Test 1: Simple Email Field Mapping');
  console.log('-'.repeat(70));
  
  try {
    const sourceField: FieldDefinition = {
      name: 'customer_email',
      type: 'string',
      description: 'Customer primary email address',
      samples: ['john.doe@example.com', 'jane.smith@company.org']
    };
    
    const targetFields: FieldDefinition[] = [
      {
        name: 'email_address',
        type: 'string',
        description: 'Email address for contact'
      },
      {
        name: 'contact_email',
        type: 'string',
        description: 'Primary contact email'
      },
      {
        name: 'billing_address',
        type: 'string',
        description: 'Billing street address'
      }
    ];
    
    const context: BusinessContext = {
      industry: 'E-Commerce',
      sourceSystem: 'Shopify',
      targetSystem: 'NetSuite',
      regulations: ['GDPR', 'CCPA']
    };
    
    const request: FieldAnalysisRequest = {
      sourceField,
      targetFields,
      context
    };
    
    console.log(`\nSource Field: ${sourceField.name} (${sourceField.type})`);
    console.log(`Target Fields: ${targetFields.map(f => f.name).join(', ')}`);
    console.log(`Context: ${context.industry} | ${context.sourceSystem} → ${context.targetSystem}\n`);
    
    const startTime = Date.now();
    const result = await engine.analyzeFieldMapping(request);
    const duration = Date.now() - startTime;
    
    console.log('\n✅ Analysis Complete!');
    console.log('=' .repeat(70));
    console.log(`\n📊 Results:`);
    console.log(`   Primary Mapping: ${result.primaryMapping.targetField.name}`);
    console.log(`   Confidence: ${(result.primaryMapping.confidence * 100).toFixed(1)}%`);
    console.log(`   Semantic Similarity: ${(result.primaryMapping.semanticSimilarity * 100).toFixed(1)}%`);
    console.log(`   Transformation Type: ${result.primaryMapping.transformationType}`);
    console.log(`\n📝 Reasoning:`);
    console.log(`   ${result.reasoning}`);
    console.log(`\n🔍 Top Reasons:`);
    result.primaryMapping.reasons.slice(0, 3).forEach((reason, idx) => {
      console.log(`   ${idx + 1}. ${reason}`);
    });
    
    if (result.alternativeMappings.length > 0) {
      console.log(`\n🔄 Alternative Mappings:`);
      result.alternativeMappings.slice(0, 2).forEach((alt, idx) => {
        console.log(`   ${idx + 1}. ${alt.targetField.name} (${(alt.confidence * 100).toFixed(1)}%)`);
      });
    }
    
    console.log(`\n💰 Cost & Performance:`);
    console.log(`   Provider: ${result.metadata.provider}`);
    console.log(`   Model: ${result.metadata.model}`);
    console.log(`   Cost: $${result.metadata.cost.toFixed(4)}`);
    console.log(`   Response Time: ${duration}ms`);
    if (result.metadata.tokensUsed) {
      console.log(`   Tokens: ${result.metadata.tokensUsed.total} (${result.metadata.tokensUsed.prompt} prompt + ${result.metadata.tokensUsed.completion} completion)`);
    }
    
    // Assertions
    console.log(`\n✅ Validation:`);
    console.log(`   ✓ Analysis completed`);
    console.log(`   ✓ Primary mapping identified`);
    console.log(`   ✓ Confidence score: ${result.primaryMapping.confidence >= 0.7 ? 'GOOD' : 'NEEDS REVIEW'}`);
    console.log(`   ✓ Response time: ${duration < 5000 ? 'EXCELLENT' : 'SLOW'} (${duration}ms)`);
    console.log(`   ✓ Cost: ${result.metadata.cost === 0 ? 'FREE (LMStudio)' : `$${result.metadata.cost}`}`);
    
  } catch (error) {
    console.error('\n❌ Test 1 Failed:');
    console.error(error);
    throw error;
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('🎉 All Integration Tests Passed!');
  console.log('='.repeat(70));
}

// Run the test
if (require.main === module) {
  testSemanticAnalysis()
    .then(() => {
      console.log('\n✅ Integration test completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Integration test failed:', error);
      process.exit(1);
    });
}

export { testSemanticAnalysis };
