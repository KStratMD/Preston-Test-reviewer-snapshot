import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { AIFieldMappingService, type NetSuiteCustomField, type NetSuiteRelationship } from '../services/ai/AIFieldMappingService';
import { AIProviderConfigService } from '../utils/ai/AIProviderConfigService';
import { squireCustomerSchema } from '../services/ai/SquireSchema';
import { suiteCentralCustomerSchema } from '../services/ai/SuiteCentralSchema';
import { Logger } from '../utils/Logger';
import type { DataRecord, FieldMapping } from '../types';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';

export function createAIDemoRouter(): Router {
  const router = Router();
  const logger = new Logger('AIDemoRoute');
  const { container } = require('../inversify/inversify.config');
  const { TYPES } = require('../inversify/types');
  const trainingDataRepo = container.get(TYPES.TrainingDataRepository);
  const service = new AIFieldMappingService(logger, trainingDataRepo);
  const cfgService = new AIProviderConfigService(
    logger,
    container.get(TYPES.ConfigDirectory),
  );

  router.get(
    '/mappings',
    asyncHandler(async (_req, res) => {
      const sampleData: DataRecord[] = [
        { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com', phone: '555-1234', amount: 50 },
        { firstName: 'Bob', lastName: 'Jones', email: 'bob@example.com', phone: '555-5678', amount: 75 },
      ];

      const suggestions = await service.suggestFieldMappings(
        squireCustomerSchema,
        suiteCentralCustomerSchema,
        sampleData,
      );
      logger.info('AI field mapping suggestions generated', { suggestions });

      const fieldMappings: FieldMapping[] = suggestions.map(s => ({
        sourceField: s.sourceField,
        targetField: s.targetField,
        transformationType: s.transformationType,
        isRequired: false,
      }));

      const quality = await service.validateMappingQuality(
        fieldMappings,
        squireCustomerSchema,
        suiteCentralCustomerSchema,
      );
      logger.info('AI field mapping quality report generated', { report: quality });

      res.json({ suggestions, quality });
    }),
  );

  // Field mapping suggestions endpoint for the dashboard
  router.post(
    '/field-mapping',
    asyncHandler(async (req, res): Promise<void> => {
      const { sampleData, sourceSystem, targetSystem, integrationId, provider, model } = req.body;
      
      // Validate request
      if (!sampleData || !sourceSystem || !targetSystem) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: sampleData, sourceSystem, targetSystem'
        });
        return;
      }

      logger.info('AI field mapping request received', { 
        sourceSystem, 
        targetSystem, 
        integrationId,
        dataLength: sampleData.length 
      });

      // Simulate AI processing delay
      await new Promise(resolve => setTimeout(resolve, 1200 + Math.random() * 800));

      try {
        // Choose provider based on request or stored config (demo behavior)
        const effectiveMode = provider || cfgService.getConfig().mode || 'rule-based';
        if (effectiveMode === 'cloud-api' || effectiveMode === 'local-llm') {
          // For demo parity, we continue using AIFieldMappingService for suggestions
          // while recording the requested mode in logs.
          logger.info('Using AI provider (demo)', { mode: effectiveMode, model });
        }
        let parsedSampleData: DataRecord[] = [];
        let headers: string[] = [];

        // Detect data format (JSON vs CSV)
        const trimmedData = sampleData.trim();
        if (trimmedData.startsWith('[') || trimmedData.startsWith('{')) {
          // Handle JSON format
          try {
            const jsonData = JSON.parse(trimmedData);
            const dataArray = Array.isArray(jsonData) ? jsonData : [jsonData];
            
            // Extract headers from first object
            if (dataArray.length > 0 && typeof dataArray[0] === 'object') {
              headers = Object.keys(dataArray[0]);
              parsedSampleData = dataArray.slice(0, 5).map(item => ({ ...item })); // Take up to 5 sample records
            }
            
            logger.info('Parsed JSON data', { 
              totalRecords: dataArray.length,
              headers: headers,
              sampleRecord: dataArray[0]
            });
          } catch (jsonError) {
            logger.error('Failed to parse JSON data', jsonError);
            throw new Error('Invalid JSON format in sample data', { cause: jsonError });
          }
        } else {
          // Handle CSV format
          const lines = sampleData.split('\n').filter((line: string) => line.trim());
          headers = lines[0]?.split(',').map((h: string) => h.trim().replace(/"/g, '')) || [];
          
          logger.info('Parsed CSV data', { 
            totalLines: lines.length,
            headers: headers,
            firstDataLine: lines[1]
          });

          // Convert to DataRecord format
          parsedSampleData = lines.slice(1, 6).map((line: string) => { // Take up to 5 sample records
            const values = line.split(',').map((v: string) => v.trim().replace(/"/g, ''));
            const record: DataRecord = {};
            headers.forEach((header: string, index: number) => {
              record[header] = values[index] || '';
            });
            return record;
          });
        }

        // Create mock schemas for AI processing with proper field types
        const mockSourceSchema: typeof squireCustomerSchema = { 
          systemType: sourceSystem,
          recordType: 'customer',
          fields: headers.map((h: string) => ({
            name: h,
            type: h.toLowerCase().includes('email') ? 'email' as const : 
                  h.toLowerCase().includes('phone') ? 'phone' as const :
                  h.toLowerCase().includes('date') ? 'date' as const :
                  'string' as const,
            description: `${h} field from ${sourceSystem}`,
            required: h.toLowerCase().includes('name') || h.toLowerCase().includes('email')
          }))
        };
        
        // Create a comprehensive target schema with more fields to map to
        const mockTargetSchema = {
          systemType: targetSystem,
          recordType: 'customer' as const,
          fields: [
            { name: 'firstName', type: 'string' as const, required: true },
            { name: 'lastName', type: 'string' as const, required: true },
            { name: 'email', type: 'email' as const, required: true },
            { name: 'phone', type: 'phone' as const },
            { name: 'companyName', type: 'string' as const },
            { name: 'fullName', type: 'string' as const },
            { name: 'primaryEmail', type: 'email' as const },
            { name: 'businessPhone', type: 'phone' as const },
            { name: 'address', type: 'string' as const },
            { name: 'city', type: 'string' as const },
            { name: 'state', type: 'string' as const },
            { name: 'postalCode', type: 'string' as const },
            { name: 'country', type: 'string' as const }
          ],
          customFields: [] as NetSuiteCustomField[],
          relationships: [] as NetSuiteRelationship[]
        };
        
        logger.info('Created schemas for mapping', {
          sourceFieldCount: mockSourceSchema.fields.length,
          targetFieldCount: mockTargetSchema.fields.length,
          sourceFields: mockSourceSchema.fields.map(f => f.name),
          targetFields: mockTargetSchema.fields.map(f => f.name)
        });
        
        const suggestions = await service.suggestFieldMappings(
          mockSourceSchema,
          mockTargetSchema,
          parsedSampleData,
        );

        // Convert to the expected response format
        const fieldMappings: FieldMapping[] = suggestions.map(s => ({
          sourceField: s.sourceField,
          targetField: s.targetField,
          transformationType: s.transformationType,
          isRequired: Math.random() > 0.7, // Random required flag
        }));

        // Get quality assessment
        const quality = await service.validateMappingQuality(
          fieldMappings,
          mockSourceSchema,
          mockTargetSchema,
        );

        // Format response with mock enhancements
        const response = {
          success: true,
          suggestions: suggestions.map((s, index) => ({
            sourceField: s.sourceField,
            targetField: s.targetField,
            confidence: Math.min(0.98, 0.75 + Math.random() * 0.2), // 75-95% confidence
            transformationType: s.transformationType,
            transformationValue: s.transformationType === 'concatenation' ? '{first_name} {last_name}' : undefined,
            reasoning: `AI analysis suggests ${s.transformationType} mapping based on semantic similarity and field naming patterns`
          })),
          quality: {
            overallScore: Math.min(0.95, 0.78 + Math.random() * 0.15),
            totalMappings: suggestions.length,
            highConfidence: suggestions.filter(() => Math.random() > 0.3).length,
            mediumConfidence: suggestions.filter(() => Math.random() > 0.6).length,
            lowConfidence: suggestions.filter(() => Math.random() > 0.8).length,
          },
          processingTime: (1.2 + Math.random() * 0.8).toFixed(1) + 's',
          analysisDetails: {
            sourceFieldsDetected: headers.length,
            targetFieldsInferred: suggestions.length,
            dataTypesAnalyzed: ['String', 'Number', 'Email', 'Phone', 'Date'],
            patterns: ['Direct Mapping', 'Field Concatenation', 'Lookup Tables', 'Data Transformation']
          }
        };

        logger.info('AI field mapping completed', { 
          suggestionsCount: suggestions.length,
          overallScore: response.quality.overallScore
        });

        res.json(response);
        return;

      } catch (error) {
        if (await handleApprovalQueueError(error, req, res, {
          operationType: 'ai_call',
          resourceType: 'ai_demo.field_mapping',
          resourceId: 'new',
        })) return;
        logger.error('AI field mapping failed', error);
        res.status(500).json({
          success: false,
          error: 'Internal server error during AI field mapping',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
        return;
      }
    }),
  );

  // Get AI capabilities
  router.get('/capabilities', (_req, res) => {
    res.json({
      success: true,
      supportedSystems: ['Salesforce', 'NetSuite', 'SAP', 'Dynamics 365', 'Oracle', 'Business Central'],
      transformationTypes: ['direct', 'lookup', 'calculation', 'concatenation', 'conditional'],
      features: [
        'Semantic field analysis',
        'Pattern recognition',
        'Data type inference',
        'Confidence scoring',
        'Custom field suggestions',
        'Advanced transformations'
      ],
      version: '1.0.0'
    });
  });

  return router;
}
