import { Router, type Application, type Request, type Response, type NextFunction } from 'express';
import { logger } from '../utils/Logger';

/**
 * Smart API router that uses real endpoints where available,
 * falls back to mocks only when real endpoints don't exist
 */
export function createMockDashboardAPIs(app?: Application): Router {
  const router = Router();

  // Helper function to check if a route exists
  const hasRoute = (method: string, path: string): boolean => {
    if (!app) return false;

    try {
      const routes = app._router?.stack || [];
      for (const layer of routes) {
        if (layer.route) {
          const routePath = layer.route.path;
          const methods = layer.route.methods;
          if (routePath === path && methods[method.toLowerCase()]) {
            return true;
          }
        }
        // Don't assume subpaths exist in mounted routers - be more specific
        // The original logic was too broad and caused false positives
      }
    } catch (error) {
      logger.warn('Route check failed:', error);
    }
    return false;
  };

  // Add route alias middleware to bridge path differences
  const addRouteAlias = (mockPath: string, realPath: string, method = 'GET') => {
    if (hasRoute(method, realPath)) {
      // Real endpoint exists, create alias
      const routerMethod = router[method.toLowerCase() as keyof Router] as unknown as (
        path: string,
        handler: (req: Request, res: Response, next: NextFunction) => void
      ) => Router;
      if (typeof routerMethod === 'function') {
        routerMethod(mockPath, (req: Request, res: Response, next: NextFunction) => {
          // Forward to real endpoint
          req.url = realPath;
          req.originalUrl = realPath;
          next('router'); // Skip to next router (real API)
        });
      }
      return true;
    }
    return false;
  };

  // AI Field Mapping endpoints - use real API where available
  if (!addRouteAlias('/api/ai/field-mapping/feedback', '/api/ai/mapping/feedback', 'POST')) {
    router.post('/api/ai/field-mapping/feedback', (req, res) => {
      res.json({ success: true, message: 'Feedback recorded (mock)' });
    });
  }

  if (!addRouteAlias('/api/ai/field-mapping/suggestions', '/api/ai/mapping/suggestions', 'GET')) {
    router.get('/api/ai/field-mapping/suggestions', (req, res) => {
      res.json({
        suggestions: [
          {
            id: '1',
            sourceField: 'customer_name',
            targetField: 'account_name',
            confidence: 0.95,
            reasoning: 'Semantic similarity between customer and account',
            transformationType: 'direct'
          }
        ]
      });
    });
  }

  // AI Field Mapping Suggestions POST endpoint (for generating new suggestions)
  if (!addRouteAlias('/api/ai/field-mapping/suggestions', '/api/ai/mapping/suggestions', 'POST')) {
    router.post('/api/ai/field-mapping/suggestions', (req, res) => {
      const { sourceSystem, targetSystem, sourceSchema, targetSchema, sampleData } = req.body;
      
      // Generate realistic suggestions based on system types and schemas
      const suggestions = [];
      const sourceFields = sourceSchema || ['name', 'email', 'phone', 'address', 'company'];
      const targetFields = targetSchema || ['account_name', 'primary_email', 'main_phone', 'billing_address', 'company_name'];
      
      // Generate intelligent mappings
      const mappingRules = [
        { patterns: ['name', 'customer_name', 'account_name', 'companyname'], targets: ['account_name', 'name', 'company_name'], confidence: 0.95 },
        { patterns: ['email', 'emailaddress', 'email_address'], targets: ['primary_email', 'email', 'contact_email'], confidence: 0.98 },
        { patterns: ['phone', 'telephone', 'mobile'], targets: ['main_phone', 'phone', 'contact_phone'], confidence: 0.92 },
        { patterns: ['address', 'street', 'location'], targets: ['billing_address', 'address', 'street_address'], confidence: 0.88 },
        { patterns: ['id', 'entityid', 'customer_id'], targets: ['external_id', 'id', 'customer_reference'], confidence: 0.90 },
        { patterns: ['first_name', 'firstname', 'fname'], targets: ['first_name', 'given_name'], confidence: 0.96 },
        { patterns: ['last_name', 'lastname', 'surname'], targets: ['last_name', 'family_name'], confidence: 0.96 },
        { patterns: ['revenue', 'annual_revenue', 'income'], targets: ['annual_revenue', 'total_revenue'], confidence: 0.85 },
        { patterns: ['status', 'account_status', 'state'], targets: ['status', 'record_status'], confidence: 0.83 }
      ];

      // Create suggestions based on field similarity
      sourceFields.forEach((sourceField: string) => {
        const fieldLower = sourceField.toLowerCase();
        const bestMatch = mappingRules.find(rule => 
          rule.patterns.some(pattern => fieldLower.includes(pattern) || pattern.includes(fieldLower))
        );

        if (bestMatch) {
          const targetField = bestMatch.targets.find(target => 
            targetFields.some((tf: string) => tf.toLowerCase().includes(target.toLowerCase()))
          ) || bestMatch.targets[0];

          suggestions.push({
            id: `suggestion_${suggestions.length + 1}`,
            sourceField,
            targetField,
            confidence: bestMatch.confidence + (Math.random() * 0.05 - 0.025), // Add slight variation
            reasoning: `Semantic similarity: "${sourceField}" maps well to "${targetField}" based on field naming patterns`,
            transformationType: sourceField.toLowerCase().includes('id') ? 'lookup' : 'direct'
          });
        }
      });

      // Add some additional contextual suggestions based on system types
      if (sourceSystem && targetSystem) {
        if (sourceSystem.toLowerCase().includes('salesforce')) {
          suggestions.push({
            id: `sf_special_${suggestions.length + 1}`,
            sourceField: 'AccountId',
            targetField: 'parent_account_id',
            confidence: 0.94,
            reasoning: 'Salesforce AccountId typically maps to parent account reference',
            transformationType: 'lookup'
          });
        }
        
        if (targetSystem.toLowerCase().includes('netsuite')) {
          suggestions.push({
            id: `ns_special_${suggestions.length + 1}`,
            sourceField: 'subsidiary',
            targetField: 'business_unit',
            confidence: 0.91,
            reasoning: 'NetSuite subsidiary field maps to business unit classification',
            transformationType: 'lookup'
          });
        }
      }

      res.json({
        success: true,
        suggestions: suggestions.slice(0, 12), // Limit to reasonable number
        metadata: {
          totalSuggestions: suggestions.length,
          averageConfidence: (suggestions.reduce((sum, s) => sum + s.confidence, 0) / suggestions.length).toFixed(3),
          sourceSystem,
          targetSystem,
          processingTime: Math.round(Math.random() * 800 + 200) // Simulate processing time
        }
      });
    });
  }

  // AI Field Mapping Validation endpoint
  if (!addRouteAlias('/api/ai/field-mapping/validate', '/api/ai/mapping/validate', 'POST')) {
    router.post('/api/ai/field-mapping/validate', (req: Request, res: Response) => {
      const { mappings, sourceSchema, targetSchema } = req.body;
      
      if (!mappings || !Array.isArray(mappings)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid mappings data'
        });
      }

      // Validation logic
      const validationResults: {sourceField: string; targetField: string; score: number; issues: string[]}[] = [];
      const potentialIssues: string[] = [];
      let totalScore = 0;

      mappings.forEach((mapping, index) => {
        const { sourceField, targetField, transformationType } = mapping;
        let score = 0.8; // Base score
        const issues: string[] = [];

        // Field name similarity check
        if (sourceField && targetField) {
          const similarity = calculateFieldSimilarity(sourceField, targetField);
          score += similarity * 0.2;
          
          if (similarity < 0.3) {
            issues.push(`Low similarity between "${sourceField}" and "${targetField}"`);
          }
        }

        // Transformation type validation
        if (transformationType) {
          if (['direct', 'format', 'lookup', 'calculation'].includes(transformationType)) {
            score += 0.1;
          } else {
            issues.push(`Unknown transformation type: ${transformationType}`);
            score -= 0.1;
          }
        }

        // Field type consistency (mock validation)
        if (sourceField?.toLowerCase().includes('id') && !targetField?.toLowerCase().includes('id')) {
          if (transformationType !== 'lookup') {
            issues.push(`ID field "${sourceField}" should use lookup transformation`);
            score -= 0.15;
          }
        }

        // Required field check
        const requiredFields = ['name', 'id', 'email'];
        if (requiredFields.some(field => targetField?.toLowerCase().includes(field))) {
          score += 0.05;
        }

        totalScore += Math.max(0, Math.min(1, score));
        validationResults.push({
          sourceField,
          targetField,
          score: Math.max(0, Math.min(1, score)),
          issues
        });

        potentialIssues.push(...issues);
      });

      const overallScore = mappings.length > 0 ? totalScore / mappings.length : 0;

      return res.json({
        success: true,
        overallScore,
        validationResults,
        potentialIssues: potentialIssues.slice(0, 10), // Limit issues
        recommendations: [
          'Consider using lookup transformation for ID fields',
          'Verify field data types match between systems',
          'Test with sample data before production deployment'
        ],
        metadata: {
          totalMappings: mappings.length,
          passedMappings: validationResults.filter(r => r.score > 0.7).length,
          averageScore: overallScore.toFixed(3)
        }
      });
    });
  }

  // Helper function for field similarity
  function calculateFieldSimilarity(field1: string, field2: string): number {
    const f1 = field1.toLowerCase().replace(/[_-]/g, '');
    const f2 = field2.toLowerCase().replace(/[_-]/g, '');
    
    if (f1 === f2) return 1.0;
    if (f1.includes(f2) || f2.includes(f1)) return 0.8;
    
    // Simple similarity based on common words
    const commonWords = ['name', 'email', 'phone', 'address', 'id', 'date', 'status'];
    for (const word of commonWords) {
      if (f1.includes(word) && f2.includes(word)) return 0.6;
    }
    
    return 0.2; // Low baseline similarity
  }

  // AI Field Mapping Stats endpoint
  if (!addRouteAlias('/api/ai/field-mapping/stats', '/api/ai/mapping/stats', 'GET')) {
    router.get('/api/ai/field-mapping/stats', (req, res) => {
      res.json({
        suggestionsGenerated: 1247,
        acceptanceRate: 85.2,
        accuracyRate: 94.7,
        timeSavedHours: 156.5,
        totalMappings: 892,
        activeTemplates: 23
      });
    });
  }

  // AI Field Mapping Templates endpoint
  if (!addRouteAlias('/api/ai/field-mapping/templates', '/api/ai/mapping/templates', 'GET')) {
    router.get('/api/ai/field-mapping/templates', (req, res) => {
      const sourceSystem = req.query.sourceSystem as string;
      const targetSystem = req.query.targetSystem as string;
      
      // Sample templates based on source and target systems
      const templates = [];
      
      if (sourceSystem && targetSystem) {
        // Generate relevant templates based on system combination
        if (sourceSystem.toLowerCase().includes('salesforce') || targetSystem.toLowerCase().includes('salesforce')) {
          templates.push({
            id: 'sf_contact_template',
            name: 'Salesforce Contact Template',
            description: 'Complete contact field mappings for Salesforce integration',
            sourceSystem,
            targetSystem,
            mappings: [
              { sourceField: 'FirstName', targetField: 'first_name', transformationType: 'direct' },
              { sourceField: 'LastName', targetField: 'last_name', transformationType: 'direct' },
              { sourceField: 'Email', targetField: 'email_address', transformationType: 'direct' },
              { sourceField: 'Phone', targetField: 'phone_number', transformationType: 'direct' },
              { sourceField: 'MobilePhone', targetField: 'mobile_phone', transformationType: 'direct' },
              { sourceField: 'AccountId', targetField: 'account_id', transformationType: 'lookup' },
              { sourceField: 'Title', targetField: 'job_title', transformationType: 'direct' },
              { sourceField: 'Department', targetField: 'department', transformationType: 'direct' },
              { sourceField: 'MailingAddress', targetField: 'mailing_address', transformationType: 'direct' },
              { sourceField: 'Birthdate', targetField: 'birth_date', transformationType: 'format' }
            ]
          });

          templates.push({
            id: 'sf_account_template',
            name: 'Salesforce Account Template',
            description: 'Enterprise account mappings with financial data',
            sourceSystem,
            targetSystem,
            mappings: [
              { sourceField: 'Name', targetField: 'account_name', transformationType: 'direct' },
              { sourceField: 'AccountNumber', targetField: 'account_number', transformationType: 'direct' },
              { sourceField: 'Type', targetField: 'account_type', transformationType: 'lookup' },
              { sourceField: 'Industry', targetField: 'industry_code', transformationType: 'lookup' },
              { sourceField: 'AnnualRevenue', targetField: 'annual_revenue', transformationType: 'format' },
              { sourceField: 'NumberOfEmployees', targetField: 'employee_count', transformationType: 'direct' },
              { sourceField: 'BillingAddress', targetField: 'billing_address', transformationType: 'direct' },
              { sourceField: 'ShippingAddress', targetField: 'shipping_address', transformationType: 'direct' },
              { sourceField: 'Website', targetField: 'company_website', transformationType: 'direct' }
            ]
          });

          templates.push({
            id: 'sf_opportunity_template',
            name: 'Salesforce Opportunity Template',
            description: 'Sales opportunity and pipeline mappings',
            sourceSystem,
            targetSystem,
            mappings: [
              { sourceField: 'Name', targetField: 'opportunity_name', transformationType: 'direct' },
              { sourceField: 'AccountId', targetField: 'account_id', transformationType: 'lookup' },
              { sourceField: 'Amount', targetField: 'deal_value', transformationType: 'format' },
              { sourceField: 'CloseDate', targetField: 'expected_close_date', transformationType: 'format' },
              { sourceField: 'StageName', targetField: 'sales_stage', transformationType: 'lookup' },
              { sourceField: 'Probability', targetField: 'win_probability', transformationType: 'direct' },
              { sourceField: 'OwnerId', targetField: 'sales_rep_id', transformationType: 'lookup' },
              { sourceField: 'LeadSource', targetField: 'lead_source', transformationType: 'direct' }
            ]
          });
        }
        
        if (sourceSystem.toLowerCase().includes('netsuite') || targetSystem.toLowerCase().includes('netsuite')) {
          templates.push({
            id: 'ns_customer_template',
            name: 'NetSuite Customer Template',
            description: 'Enterprise customer mappings with subsidiary structure',
            sourceSystem,
            targetSystem,
            mappings: [
              { sourceField: 'companyname', targetField: 'account_name', transformationType: 'direct' },
              { sourceField: 'email', targetField: 'primary_email', transformationType: 'direct' },
              { sourceField: 'phone', targetField: 'phone_number', transformationType: 'direct' },
              { sourceField: 'entityid', targetField: 'customer_id', transformationType: 'direct' },
              { sourceField: 'subsidiary', targetField: 'business_unit', transformationType: 'lookup' },
              { sourceField: 'terms', targetField: 'payment_terms', transformationType: 'lookup' },
              { sourceField: 'creditlimit', targetField: 'credit_limit', transformationType: 'format' },
              { sourceField: 'category', targetField: 'customer_category', transformationType: 'lookup' },
              { sourceField: 'salesrep', targetField: 'sales_rep_id', transformationType: 'lookup' }
            ]
          });

          templates.push({
            id: 'ns_item_template',
            name: 'NetSuite Item Template',
            description: 'Product catalog and inventory mappings',
            sourceSystem,
            targetSystem,
            mappings: [
              { sourceField: 'itemid', targetField: 'product_code', transformationType: 'direct' },
              { sourceField: 'displayname', targetField: 'product_name', transformationType: 'direct' },
              { sourceField: 'salesdescription', targetField: 'description', transformationType: 'direct' },
              { sourceField: 'baseprice', targetField: 'unit_price', transformationType: 'format' },
              { sourceField: 'category', targetField: 'product_category', transformationType: 'lookup' },
              { sourceField: 'unitstype', targetField: 'unit_of_measure', transformationType: 'lookup' },
              { sourceField: 'weight', targetField: 'shipping_weight', transformationType: 'format' },
              { sourceField: 'isinactive', targetField: 'is_active', transformationType: 'calculation' }
            ]
          });

          templates.push({
            id: 'ns_transaction_template',
            name: 'NetSuite Transaction Template',
            description: 'Sales order and invoice mappings',
            sourceSystem,
            targetSystem,
            mappings: [
              { sourceField: 'tranid', targetField: 'transaction_id', transformationType: 'direct' },
              { sourceField: 'entity', targetField: 'customer_id', transformationType: 'lookup' },
              { sourceField: 'trandate', targetField: 'transaction_date', transformationType: 'format' },
              { sourceField: 'total', targetField: 'total_amount', transformationType: 'format' },
              { sourceField: 'status', targetField: 'transaction_status', transformationType: 'lookup' },
              { sourceField: 'memo', targetField: 'notes', transformationType: 'direct' },
              { sourceField: 'location', targetField: 'fulfillment_location', transformationType: 'lookup' }
            ]
          });
        }
        
        if (sourceSystem.toLowerCase().includes('dynamics') || targetSystem.toLowerCase().includes('dynamics')) {
          templates.push({
            id: 'd365_account_template',
            name: 'Dynamics 365 Account Template',
            description: 'Enterprise account mappings with relationship data',
            sourceSystem,
            targetSystem,
            mappings: [
              { sourceField: 'name', targetField: 'account_name', transformationType: 'direct' },
              { sourceField: 'emailaddress1', targetField: 'primary_email', transformationType: 'direct' },
              { sourceField: 'telephone1', targetField: 'main_phone', transformationType: 'direct' },
              { sourceField: 'accountnumber', targetField: 'account_number', transformationType: 'direct' },
              { sourceField: 'revenue', targetField: 'annual_revenue', transformationType: 'format' },
              { sourceField: 'industrycode', targetField: 'industry_classification', transformationType: 'lookup' },
              { sourceField: 'address1_composite', targetField: 'primary_address', transformationType: 'direct' },
              { sourceField: 'websiteurl', targetField: 'company_website', transformationType: 'direct' },
              { sourceField: 'ownerid', targetField: 'account_manager_id', transformationType: 'lookup' }
            ]
          });

          templates.push({
            id: 'd365_contact_template',
            name: 'Dynamics 365 Contact Template',
            description: 'Contact and lead relationship mappings',
            sourceSystem,
            targetSystem,
            mappings: [
              { sourceField: 'firstname', targetField: 'first_name', transformationType: 'direct' },
              { sourceField: 'lastname', targetField: 'last_name', transformationType: 'direct' },
              { sourceField: 'emailaddress1', targetField: 'email_address', transformationType: 'direct' },
              { sourceField: 'mobilephone', targetField: 'mobile_phone', transformationType: 'direct' },
              { sourceField: 'jobtitle', targetField: 'job_title', transformationType: 'direct' },
              { sourceField: 'parentcustomerid', targetField: 'account_id', transformationType: 'lookup' },
              { sourceField: 'department', targetField: 'department', transformationType: 'direct' },
              { sourceField: 'birthdate', targetField: 'birth_date', transformationType: 'format' }
            ]
          });

          templates.push({
            id: 'd365_opportunity_template',
            name: 'Dynamics 365 Opportunity Template',
            description: 'Sales pipeline and opportunity tracking',
            sourceSystem,
            targetSystem,
            mappings: [
              { sourceField: 'name', targetField: 'opportunity_name', transformationType: 'direct' },
              { sourceField: 'customerid', targetField: 'account_id', transformationType: 'lookup' },
              { sourceField: 'estimatedvalue', targetField: 'estimated_revenue', transformationType: 'format' },
              { sourceField: 'estimatedclosedate', targetField: 'close_date', transformationType: 'format' },
              { sourceField: 'salesstage', targetField: 'sales_stage', transformationType: 'lookup' },
              { sourceField: 'closeprobability', targetField: 'win_probability', transformationType: 'direct' },
              { sourceField: 'ownerid', targetField: 'sales_owner_id', transformationType: 'lookup' }
            ]
          });
        }

        // Add SAP templates
        if (sourceSystem.toLowerCase().includes('sap') || targetSystem.toLowerCase().includes('sap')) {
          templates.push({
            id: 'sap_business_partner_template',
            name: 'SAP Business Partner Template',
            description: 'SAP customer and vendor master data mappings',
            sourceSystem,
            targetSystem,
            mappings: [
              { sourceField: 'BusinessPartner', targetField: 'partner_id', transformationType: 'direct' },
              { sourceField: 'BusinessPartnerName', targetField: 'partner_name', transformationType: 'direct' },
              { sourceField: 'BusinessPartnerCategory', targetField: 'partner_type', transformationType: 'lookup' },
              { sourceField: 'EmailAddress', targetField: 'email_address', transformationType: 'direct' },
              { sourceField: 'PhoneNumber', targetField: 'phone_number', transformationType: 'direct' },
              { sourceField: 'Country', targetField: 'country_code', transformationType: 'lookup' },
              { sourceField: 'CompanyCode', targetField: 'company_code', transformationType: 'direct' }
            ]
          });

          templates.push({
            id: 'sap_material_template',
            name: 'SAP Material Master Template',
            description: 'Product and material master data mappings',
            sourceSystem,
            targetSystem,
            mappings: [
              { sourceField: 'Material', targetField: 'material_code', transformationType: 'direct' },
              { sourceField: 'MaterialDescription', targetField: 'material_description', transformationType: 'direct' },
              { sourceField: 'MaterialType', targetField: 'material_type', transformationType: 'lookup' },
              { sourceField: 'BaseUnitOfMeasure', targetField: 'base_unit', transformationType: 'lookup' },
              { sourceField: 'MaterialGroup', targetField: 'product_group', transformationType: 'lookup' },
              { sourceField: 'Plant', targetField: 'manufacturing_plant', transformationType: 'lookup' }
            ]
          });
        }

        // Add Oracle templates  
        if (sourceSystem.toLowerCase().includes('oracle') || targetSystem.toLowerCase().includes('oracle')) {
          templates.push({
            id: 'oracle_customer_template',
            name: 'Oracle ERP Customer Template',
            description: 'Oracle customer and account mappings',
            sourceSystem,
            targetSystem,
            mappings: [
              { sourceField: 'CUSTOMER_NUMBER', targetField: 'customer_id', transformationType: 'direct' },
              { sourceField: 'CUSTOMER_NAME', targetField: 'customer_name', transformationType: 'direct' },
              { sourceField: 'EMAIL_ADDRESS', targetField: 'email_address', transformationType: 'direct' },
              { sourceField: 'PHONE_NUMBER', targetField: 'phone_number', transformationType: 'direct' },
              { sourceField: 'CREDIT_LIMIT', targetField: 'credit_limit', transformationType: 'format' },
              { sourceField: 'PAYMENT_TERMS', targetField: 'payment_terms_code', transformationType: 'lookup' }
            ]
          });
        }
      }
      
      // Add generic template if no specific ones match
      if (templates.length === 0) {
        templates.push({
          id: 'generic_template',
          name: 'Generic Entity Template',
          description: 'Basic field mappings for generic entity integration',
          sourceSystem: sourceSystem || 'Source System',
          targetSystem: targetSystem || 'Target System',
          mappings: [
            { sourceField: 'name', targetField: 'entity_name', transformationType: 'direct' },
            { sourceField: 'email', targetField: 'contact_email', transformationType: 'direct' },
            { sourceField: 'phone', targetField: 'contact_phone', transformationType: 'direct' },
            { sourceField: 'id', targetField: 'external_id', transformationType: 'direct' }
          ]
        });
      }
      
      res.json({ 
        success: true,
        templates,
        message: templates.length > 0 ? `Found ${templates.length} template(s) for ${sourceSystem} → ${targetSystem}` : 'No templates found for the selected systems'
      });
    });
  }

  // Data Migration endpoints - real API mounted at /api/data-migration
  // Note: Real data migration API exists, these are just fallbacks
  
  router.get('/api/data-migration/plans', (req, res) => {
    res.json({
      plans: [
        {
          id: '1',
          name: 'Sample Migration Plan (mock)',
          status: 'ready',
          sourceSystem: 'NetSuite',
          targetSystem: 'Salesforce',
          recordCount: 10000,
          progress: 0
        }
      ]
    });
  });

  router.get('/api/data-migration/templates', (req, res) => {
    res.json({
      templates: [
        {
          id: 'template_001',
          name: 'Customer Data Migration',
          description: 'Migrates customer data from source to target system',
          fields: ['Name', 'Email', 'Phone', 'Address'],
          lastUpdated: new Date().toISOString()
        }
      ]
    });
  });

  // Advanced Caching demonstration
  router.get('/api/cache/demo', (req, res) => {
    const cacheKey = 'demo:data';
    const cachedData = req.app.locals.cache?.get(cacheKey);
    if (cachedData) {
      return res.json({ source: 'cache', data: cachedData });
    }
    const data = { message: 'This is demo data generated at ' + new Date().toISOString() };
    req.app.locals.cache?.set(cacheKey, data, 60000, ['demo']);
    return res.json({ source: 'generated', data });
  });

  // Request Optimization demonstration
  router.get('/api/optimization/demo', (req, res) => {
    // Simulate some processing delay
    setTimeout(() => {
      res.json({ message: 'Request optimized response at ' + new Date().toISOString() });
    }, 100);
  });

  // Health Check demonstration
  router.get('/api/health/demo', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  router.post('/api/data-migration/plans/:id/start', (req, res) => {
    res.json({ success: true, message: 'Migration started (mock)', planId: req.params.id });
  });

  router.post('/api/data-migration/plans/:id/stop', (req, res) => {
    res.json({ success: true, message: 'Migration stopped (mock)', planId: req.params.id });
  });

  router.post('/api/data-migration/plans/:id/pause', (req, res) => {
    res.json({ success: true, message: 'Migration paused (mock)', planId: req.params.id });
  });

  router.post('/api/data-migration/plans/:id/resume', (req, res) => {
    res.json({ success: true, message: 'Migration resumed (mock)', planId: req.params.id });
  });

  router.get('/api/data-migration/plans/:id/quality-report', (req, res) => {
    res.json({
      planId: req.params.id,
      quality: {
        completeness: 98,
        accuracy: 99,
        consistency: 97,
        issues: []
      }
    });
  });

  // ROI Dashboard endpoints - use real API where available
  if (!addRouteAlias('/api/roi-dashboard/metrics', '/api/roi/metrics', 'GET')) {
    router.get('/api/roi-dashboard/metrics', (req, res) => {
      res.json({
        revenue: 2500000,
        savings: 605000,
        efficiency: 285,
        timeToValue: 45,
        roi: 285
      });
    });
  }

  // ROI Dashboard Performance endpoint - mock data fallback
  if (!addRouteAlias('/api/roi-dashboard/performance', '/api/roi/performance', 'GET')) {
    router.get('/api/roi-dashboard/performance', (req, res) => {
      const performanceData = [
        {
          connector: 'Salesforce',
          totalOperations: 1247,
          successRate: 95.2,
          averageLatency: 1245,
          throughputPerHour: 1247,
          errorRate: 4.8,
          lastActivity: Date.now() - 2 * 60 * 60 * 1000 // 2 hours ago
        },
        {
          connector: 'NetSuite',
          totalOperations: 892,
          successRate: 98.1,
          averageLatency: 856,
          throughputPerHour: 892,
          errorRate: 1.9,
          lastActivity: Date.now() - 30 * 60 * 1000 // 30 minutes ago
        },
        {
          connector: 'SAP',
          totalOperations: 445,
          successRate: 93.7,
          averageLatency: 2145,
          throughputPerHour: 445,
          errorRate: 6.3,
          lastActivity: Date.now() - 4 * 60 * 60 * 1000 // 4 hours ago
        },
        {
          connector: 'SuiteCentral',
          totalOperations: 623,
          successRate: 97.8,
          averageLatency: 1067,
          throughputPerHour: 623,
          errorRate: 2.2,
          lastActivity: Date.now() - 15 * 60 * 1000 // 15 minutes ago
        },
        {
          connector: 'Dynamics365',
          totalOperations: 378,
          successRate: 91.5,
          averageLatency: 1789,
          throughputPerHour: 378,
          errorRate: 8.5,
          lastActivity: Date.now() - 6 * 60 * 60 * 1000 // 6 hours ago
        },
        {
          connector: 'Oracle',
          totalOperations: 234,
          successRate: 89.3,
          averageLatency: 2567,
          throughputPerHour: 234,
          errorRate: 10.7,
          lastActivity: Date.now() - 8 * 60 * 60 * 1000 // 8 hours ago
        }
      ];
      
      logger.info(`[MOCK] ROI Dashboard performance request: returning ${performanceData.length} connectors`);
      res.json(performanceData);
    });
  }

  // ROI Dashboard Executive Summary endpoint - mock data fallback
  if (!addRouteAlias('/api/roi-dashboard/executive-summary', '/api/roi/executive-summary', 'GET')) {
    router.get('/api/roi-dashboard/executive-summary', (req, res) => {
      const executiveSummary = {
        kpis: {
          totalIntegrations: 12,
          activeIntegrations: 8,
          successRate: 95.4,
          avgProcessingTime: 1245,
          dataVolume: 2847293,
          errorRate: 4.6
        },
        financialMetrics: {
          costPerTransaction: 0.02,
          totalCostSavings: 485000,
          roi: 340.7,
          paybackPeriod: 8.2
        },
        operationalMetrics: {
          uptime: 99.2,
          throughput: 4819,
          latency: 1245,
          automationRate: 87.3
        },
        alerts: [
          {
            type: 'warning' as const,
            message: 'Oracle connector showing elevated error rates (10.7%)',
            timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000)
          },
          {
            type: 'info' as const,
            message: 'SuiteCentral integration performing above expectations',
            timestamp: new Date(Date.now() - 30 * 60 * 1000)
          }
        ]
      };
      
      logger.info(`[MOCK] ROI Dashboard executive summary request served`);
      res.json(executiveSummary);
    });
  }

  // ROI Dashboard Cost Analysis endpoint - mock data fallback
  if (!addRouteAlias('/api/roi-dashboard/cost-analysis', '/api/roi/cost-analysis', 'GET')) {
    router.get('/api/roi-dashboard/cost-analysis', (req, res) => {
      const { timeframe = '30d' } = req.query;
      
      const costData = {
        timeframe,
        totalCosts: 55000,
        costSavings: 485000,
        roi: 340.7,
        breakdown: {
          infrastructure: 16500,
          labor: 27500,
          software: 11000
        },
        projectedSavings: {
          monthly: timeframe === '90d' ? 161667 : timeframe === '30d' ? 485000 : 1940000,
          yearly: timeframe === '90d' ? 1940000 : timeframe === '30d' ? 5820000 : 25420000
        }
      };
      
      logger.info(`[MOCK] ROI Dashboard cost analysis request: timeframe=${timeframe}`);
      res.json(costData);
    });
  }

  // Executive Dashboard endpoints
  router.get('/api/executive/metrics', (req, res) => {
    res.json({
      kpis: {
        revenue: 2500000,
        growth: 15.2,
        efficiency: 285,
        satisfaction: 94
      },
      trends: [],
      alerts: []
    });
  });

  // DLQ Management endpoints
  router.get('/api/dlq/messages', (req, res) => {
    res.json({
      messages: [],
      total: 0,
      failed: 0,
      pending: 0
    });
  });

  // SuiteCentral production endpoints are deliberately absent.
  //
  // PR-A6 retired the `/api/suitecentral-prod/*` namespace. This block used to
  // re-register `/health` and `/metrics` under it, unauthenticated, whenever the
  // alias target was missing — and the target was `/api/suitecentral/prod/health`,
  // which the control plane does not define (health is
  // `/monitoring/health/:environmentId`). So the alias never took and the canned
  // fallback always won: in demo mode an anonymous caller could still reach a
  // namespace that no longer exists and be handed invented environment health.
  //
  // The control plane is authenticated and tenant-scoped, and has no demo mirror
  // by design — mocking it would reintroduce exactly the fiction its redesign
  // removed.

  // Mapping Studio endpoints
  router.get('/api/mapping-studio/mappings', (req, res) => {
    res.json({
      mappings: [
        {
          id: '1',
          name: 'Customer to Account Mapping',
          source: 'NetSuite',
          target: 'Salesforce',
          fieldCount: 25,
          status: 'active'
        }
      ]
    });
  });

  router.post('/api/mapping-studio/validate', (req, res) => {
    res.json({
      valid: true,
      errors: [],
      warnings: []
    });
  });

  // System Status endpoints
  router.get('/api/system/status', (req, res) => {
    res.json({
      status: 'operational',
      services: {
        api: 'online',
        database: 'online',
        cache: 'online',
        queue: 'online'
      },
      uptime: 99.99
    });
  });

  // Metrics endpoints
  router.get('/api/metrics/dashboard', (req, res) => {
    res.json({
      metrics: {
        requestsPerMinute: 1000,
        avgResponseTime: 125,
        errorRate: 0.1,
        activeConnections: 25
      }
    });
  });

  // Helper function to generate unique IDs
  const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 2 + 9)}`;

  // Dashboard synchronization endpoints for Integrated Mapping Studio
  // Check for real endpoint first, only use mock if not available
  if (!hasRoute('POST', '/api/dashboard/sync-mappings')) {
    router.post('/api/dashboard/sync-mappings', (req, res) => {
      try {
        const { mappings, sourceSystem, targetSystem, timestamp } = req.body;
        
        logger.info(`[MOCK] Dashboard sync request: ${sourceSystem} → ${targetSystem}, ${mappings?.length || 0} mappings`);
        
        // Simulate syncing mappings to dashboard
        const syncResult = {
          success: true,
          syncId: generateId(),
          mappingsCount: mappings?.length || 0,
          sourceSystem,
          targetSystem,
          timestamp: timestamp || new Date().toISOString(),
          syncStatus: 'completed',
          mock: true // Indicate this is mock data
        };
        
        res.json(syncResult);
      } catch (error) {
        logger.error('Dashboard sync error:', error);
        res.status(500).json({ 
          success: false, 
          error: 'Failed to sync mappings to dashboard',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  }

  // Only register mock endpoint if real one doesn't exist
  if (!hasRoute('GET', '/api/dashboard/load-mappings')) {
    router.get('/api/dashboard/load-mappings', (req, res) => {
      try {
        // Return sample dashboard mappings (mock data)
        const dashboardMappings = {
          mock: true, // Indicate this is mock data
        mappings: [
          {
            id: 'dash-1',
            sourceField: 'Email',
            targetField: 'email',
            transformationType: 'direct',
            confidence: 98,
            isRequired: true,
            source: 'dashboard'
          },
          {
            id: 'dash-2',
            sourceField: 'Website',
            targetField: 'websiteUrl',
            transformationType: 'direct',
            confidence: 95,
            isRequired: false,
            source: 'dashboard'
          },
          {
            id: 'dash-3',
            sourceField: 'CreatedDate',
            targetField: 'dateCreated',
            transformationType: 'format',
            confidence: 92,
            isRequired: false,
            transformationRule: 'ISO date format',
            source: 'dashboard'
          }
        ],
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        lastSync: new Date().toISOString(),
        totalMappings: 3
      };
      
      logger.info(`[MOCK] Dashboard load request: returning ${dashboardMappings.mappings.length} mappings`);
      res.json(dashboardMappings);
    } catch (error) {
      logger.error('Dashboard load error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to load mappings from dashboard',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  }

  // Cross-component data sharing endpoints
  if (!hasRoute('POST', '/api/mapping-studio/share-data')) {
    router.post('/api/mapping-studio/share-data', (req, res) => {
    try {
      const { component, data, action } = req.body;
      
      logger.info(`[MOCK] Cross-component sharing: ${component} → ${action}`);
      
      const shareResult = {
        success: true,
        shareId: generateId(),
        component,
        action,
        timestamp: new Date().toISOString(),
        dataTransferred: Object.keys(data || {}).length,
        mock: true // Indicate this is mock data
      };
      
      res.json(shareResult);
    } catch (error) {
      logger.error('Data sharing error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to share data between components',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  }

  // Comprehensive Template Administration endpoint - using the same pattern as working endpoints
  logger.info('[MOCK] Checking hasRoute for /api/mappings/templates: ' + hasRoute('GET', '/api/mappings/templates'));
  if (!hasRoute('GET', '/api/mappings/templates')) {
    logger.info('[MOCK] Creating template endpoint since no real endpoint detected');
    router.get('/api/mappings/templates', (req, res) => {
      logger.info('[MOCK] Template endpoint called!');
      const comprehensiveTemplates = [
        {
          key: 'sf-ns-customer-comprehensive',
          name: 'Salesforce to NetSuite Customer (Comprehensive)',
          description: 'Complete customer data synchronization with advanced field mappings',
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          source: 'builtin',
          tags: ['customer', 'salesforce', 'netsuite', 'standard'],
          fields: [
            { source: 'Name', target: 'companyName', transformation: 'direct', params: {} },
            { source: 'BillingStreet', target: 'defaultAddress.addressee', transformation: 'direct', params: {} },
            { source: 'BillingCity', target: 'defaultAddress.city', transformation: 'direct', params: {} },
            { source: 'BillingState', target: 'defaultAddress.state', transformation: 'direct', params: {} },
            { source: 'BillingPostalCode', target: 'defaultAddress.zip', transformation: 'direct', params: {} },
            { source: 'BillingCountry', target: 'defaultAddress.country', transformation: 'lookup', params: { table: 'countries' } },
            { source: 'Phone', target: 'phone', transformation: 'format', params: { pattern: '($1) $2-$3', regex: '(\\d{3})(\\d{3})(\\d{4})' } },
            { source: 'Email', target: 'email', transformation: 'lowercase', params: {} },
            { source: 'Website', target: 'url', transformation: 'direct', params: {} },
            { source: 'Industry', target: 'category', transformation: 'lookup', params: { table: 'industries' } },
            { source: 'AnnualRevenue', target: 'annualRevenue', transformation: 'format', params: { type: 'currency' } }
          ]
        },
        {
          key: 'd365-sf-account-bidirectional',
          name: 'Dynamics 365 ↔ Salesforce Account (Bidirectional)',
          description: 'Two-way account synchronization with conflict resolution',
          sourceSystem: 'Dynamics365',
          targetSystem: 'Salesforce',
          source: 'builtin',
          tags: ['account', 'dynamics', 'salesforce', 'bidirectional'],
          fields: [
            { source: 'name', target: 'Name', transformation: 'direct', params: {} },
            { source: 'emailaddress1', target: 'Email__c', transformation: 'direct', params: {} },
            { source: 'telephone1', target: 'Phone', transformation: 'format', params: { pattern: '($1) $2-$3' } },
            { source: 'websiteurl', target: 'Website', transformation: 'direct', params: {} },
            { source: 'revenue', target: 'AnnualRevenue', transformation: 'format', params: { type: 'currency' } },
            { source: 'industrycode', target: 'Industry', transformation: 'lookup', params: { table: 'industry_mapping' } },
            { source: 'accountnumber', target: 'AccountNumber', transformation: 'direct', params: {} },
            { source: 'description', target: 'Description', transformation: 'direct', params: {} }
          ]
        },
        {
          key: 'sap-oracle-material-sync',
          name: 'SAP to Oracle Material Master',
          description: 'Product and material data synchronization between ERP systems',
          sourceSystem: 'SAP',
          targetSystem: 'Oracle',
          source: 'builtin',
          tags: ['material', 'product', 'sap', 'oracle', 'erp'],
          fields: [
            { source: 'MATNR', target: 'ITEM_NUMBER', transformation: 'direct', params: {} },
            { source: 'MAKTX', target: 'ITEM_DESCRIPTION', transformation: 'direct', params: {} },
            { source: 'MEINS', target: 'PRIMARY_UOM_CODE', transformation: 'lookup', params: { table: 'uom_conversion' } },
            { source: 'MTART', target: 'ITEM_TYPE', transformation: 'lookup', params: { table: 'material_types' } },
            { source: 'MATKL', target: 'ITEM_CATEGORY_CODE', transformation: 'lookup', params: { table: 'categories' } },
            { source: 'BRGEW', target: 'UNIT_WEIGHT', transformation: 'format', params: { type: 'decimal', precision: 3 } },
            { source: 'GEWEI', target: 'WEIGHT_UOM_CODE', transformation: 'lookup', params: { table: 'weight_uom' } },
            { source: 'VOLUM', target: 'UNIT_VOLUME', transformation: 'format', params: { type: 'decimal', precision: 3 } }
          ]
        },
        {
          key: 'ns-bc-inventory-sync',
          name: 'NetSuite to Business Central Inventory',
          description: 'Real-time inventory level synchronization',
          sourceSystem: 'NetSuite',
          targetSystem: 'BusinessCentral',
          source: 'builtin',
          tags: ['inventory', 'netsuite', 'business-central', 'realtime'],
          fields: [
            { source: 'itemid', target: 'No_', transformation: 'direct', params: {} },
            { source: 'displayname', target: 'Description', transformation: 'direct', params: {} },
            { source: 'quantityavailable', target: 'Inventory', transformation: 'format', params: { type: 'decimal', precision: 2 } },
            { source: 'quantityonhand', target: 'Qty_on_Hand', transformation: 'format', params: { type: 'decimal', precision: 2 } },
            { source: 'reorderpoint', target: 'Reorder_Point', transformation: 'format', params: { type: 'decimal', precision: 2 } },
            { source: 'preferredstocklevel', target: 'Maximum_Inventory', transformation: 'format', params: { type: 'decimal', precision: 2 } },
            { source: 'location.name', target: 'Location_Code', transformation: 'lookup', params: { table: 'location_mapping' } },
            { source: 'lastmodifieddate', target: 'Last_Date_Modified', transformation: 'format', params: { type: 'datetime' } }
          ]
        },
        {
          key: 'suitecentral-unified-customer',
          name: 'SuiteCentral Unified Customer Profile',
          description: 'Master customer data integration across all systems',
          sourceSystem: 'SuiteCentral',
          targetSystem: 'Multiple',
          source: 'builtin',
          tags: ['suitecentral', 'customer', 'master-data', 'unified'],
          fields: [
            { source: 'customer_id', target: 'id', transformation: 'direct', params: {} },
            { source: 'legal_name', target: 'companyName', transformation: 'direct', params: {} },
            { source: 'dba_name', target: 'altName', transformation: 'direct', params: {} },
            { source: 'primary_contact.email', target: 'email', transformation: 'lowercase', params: {} },
            { source: 'primary_contact.phone', target: 'phone', transformation: 'format', params: { pattern: '+1-$1-$2-$3' } },
            { source: 'headquarters.address', target: 'primaryAddress', transformation: 'concatenation', params: { fields: ['street', 'city', 'state', 'zip'] } },
            { source: 'tax_id', target: 'taxNumber', transformation: 'direct', params: {} },
            { source: 'industry_classification', target: 'industry', transformation: 'lookup', params: { table: 'naics_codes' } },
            { source: 'credit_rating', target: 'creditRating', transformation: 'direct', params: {} },
            { source: 'annual_revenue', target: 'annualRevenue', transformation: 'format', params: { type: 'currency' } }
          ]
        },
        {
          key: 'payment-processor-reconciliation',
          name: 'Payment Processor Reconciliation',
          description: 'Multi-provider payment data reconciliation template',
          sourceSystem: 'Multiple',
          targetSystem: 'ERP',
          source: 'builtin',
          tags: ['payment', 'stripe', 'paypal', 'adyen', 'reconciliation'],
          fields: [
            { source: 'transaction_id', target: 'external_transaction_id', transformation: 'direct', params: {} },
            { source: 'amount', target: 'transaction_amount', transformation: 'format', params: { type: 'currency' } },
            { source: 'currency', target: 'currency_code', transformation: 'uppercase', params: {} },
            { source: 'status', target: 'payment_status', transformation: 'lookup', params: { table: 'payment_status_mapping' } },
            { source: 'created_date', target: 'transaction_date', transformation: 'format', params: { type: 'datetime' } },
            { source: 'customer.email', target: 'customer_email', transformation: 'lowercase', params: {} },
            { source: 'metadata.order_id', target: 'order_reference', transformation: 'direct', params: {} },
            { source: 'fees.total', target: 'processing_fees', transformation: 'format', params: { type: 'currency' } }
          ]
        }
      ];

      res.json({
        templates: comprehensiveTemplates,
        totalCount: comprehensiveTemplates.length,
        mock: true
      });
      logger.info(`[MOCK] Comprehensive template admin request: returning ${comprehensiveTemplates.length} templates`);
    });
  }

  if (!hasRoute('GET', '/api/mapping-studio/shared-templates')) {
    router.get('/api/mapping-studio/shared-templates', (req, res) => {
    try {
      // Enhanced templates with cross-component compatibility
      const sharedTemplates = [
        {
          id: 'shared-sf-ns-customers',
          name: 'Salesforce to NetSuite Customers (Shared)',
          description: 'Cross-component template for customer data synchronization',
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          compatibility: ['mapping-studio', 'ai-center', 'field-editor'],
          mappings: [
            {
              sourceField: 'Name',
              targetField: 'companyName',
              transformationType: 'direct',
              confidence: 0.95,
              isRequired: true,
              aiSuggested: true
            },
            {
              sourceField: 'BillingAddress',
              targetField: 'defaultAddress',
              transformationType: 'complex',
              confidence: 0.88,
              isRequired: false,
              transformationRule: 'parseAddress(value)',
              aiSuggested: true
            },
            {
              sourceField: 'Phone',
              targetField: 'phone',
              transformationType: 'format',
              confidence: 0.92,
              isRequired: false,
              transformationRule: 'formatPhone(value)',
              validation: '^\\+?[1-9]\\d{1,14}$'
            }
          ],
          createdBy: 'integrated-studio',
          createdDate: new Date().toISOString(),
          lastModified: new Date().toISOString(),
          usage: {
            totalApplications: 47,
            successRate: 94.2,
            avgProcessingTime: 1250
          }
        }
      ];
      
      logger.info(`[MOCK] Shared templates request: returning ${sharedTemplates.length} cross-component templates`);
      res.json({ 
        templates: sharedTemplates, 
        totalCount: sharedTemplates.length,
        mock: true // Indicate this is mock data
      });
    } catch (error) {
      logger.error('Shared templates error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to load shared templates',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  }

  // Component status and health check
  if (!hasRoute('GET', '/api/mapping-studio/component-status')) {
    router.get('/api/mapping-studio/component-status', (req, res) => {
    try {
      const componentStatus = {
        'mapping-studio': {
          status: 'online',
          version: '2.1.0',
          lastActivity: new Date().toISOString(),
          features: ['workflow', 'templates', 'validation', 'export'],
          activeUsers: 3,
          performanceScore: 98.5
        },
        'ai-center': {
          status: 'online',
          version: '1.8.2',
          lastActivity: new Date(Date.now() - 30000).toISOString(),
          features: ['suggestions', 'semantic-analysis', 'learning', 'improvement'],
          activeUsers: 2,
          performanceScore: 96.2
        },
        'template-manager': {
          status: 'online',
          version: '1.5.1',
          lastActivity: new Date(Date.now() - 45000).toISOString(),
          features: ['crud', 'sharing', 'versioning', 'compatibility'],
          activeUsers: 1,
          performanceScore: 97.8
        },
        'field-editor': {
          status: 'online',
          version: '1.4.0',
          lastActivity: new Date(Date.now() - 60000).toISOString(),
          features: ['advanced-editing', 'validation', 'transformation-rules'],
          activeUsers: 2,
          performanceScore: 95.1
        },
        'dashboard-sync': {
          status: 'online',
          version: '1.2.0',
          lastActivity: new Date().toISOString(),
          features: ['bidirectional-sync', 'conflict-resolution', 'audit-trail'],
          activeUsers: 0,
          performanceScore: 99.2
        }
      };
      
      const overallHealth = {
        totalComponents: Object.keys(componentStatus).length,
        onlineComponents: Object.values(componentStatus).filter(c => c.status === 'online').length,
        totalActiveUsers: Object.values(componentStatus).reduce((sum, c) => sum + c.activeUsers, 0),
        avgPerformanceScore: Object.values(componentStatus).reduce((sum, c) => sum + c.performanceScore, 0) / Object.keys(componentStatus).length,
        lastHealthCheck: new Date().toISOString()
      };
      
      res.json({
        components: componentStatus,
        overallHealth,
        integrationStatus: 'fully-integrated',
        mock: true // Indicate this is mock data
      });
      logger.info('[MOCK] Component status request served');
    } catch (error) {
      logger.error('Component status error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to get component status',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  }

  // Template search endpoint for integration wizard - this is what the wizard calls
  if (!hasRoute('GET', '/api/mappings/templates/search')) {
    router.get('/api/mappings/templates/search', (req, res) => {
      try {
        const { source, target, type } = req.query;
        
        logger.info(`[MOCK] Template search request: source=${source}, target=${target}, type=${type}`);
        
        // Generate relevant templates based on search parameters
        const searchResults = [];
        
        // Generate templates based on source/target system combination
        if (source && target) {
          const sourceSystem = source.toString();
          const targetSystem = target.toString();
          
          // Create smart template suggestions based on system types
          if (sourceSystem.toLowerCase().includes('salesforce') && targetSystem.toLowerCase().includes('netsuite')) {
            searchResults.push({
              id: 'sf-ns-customer-wizard',
              name: 'Salesforce to NetSuite Customer Template',
              description: 'Complete customer data integration with field mapping',
              sourceSystem,
              targetSystem,
              confidence: 0.98,
              fieldCount: 12,
              estimatedSaveTime: '2-3 hours',
              complexity: 'medium',
              category: 'customer-data',
              tags: ['customers', 'contacts', 'billing'],
              previewMappings: [
                { source: 'Name', target: 'companyName', confidence: 0.98 },
                { source: 'BillingAddress', target: 'defaultAddress', confidence: 0.94 },
                { source: 'Phone', target: 'phone', confidence: 0.96 },
                { source: 'Email', target: 'email', confidence: 0.99 }
              ]
            });
            
            searchResults.push({
              id: 'sf-ns-opportunity-wizard',
              name: 'Salesforce Opportunities to NetSuite Sales Orders',
              description: 'Convert sales opportunities to orders with proper data flow',
              sourceSystem,
              targetSystem,
              confidence: 0.92,
              fieldCount: 8,
              estimatedSaveTime: '1-2 hours',
              complexity: 'high',
              category: 'sales-pipeline',
              tags: ['opportunities', 'sales', 'orders'],
              previewMappings: [
                { source: 'Name', target: 'tranId', confidence: 0.85 },
                { source: 'Amount', target: 'total', confidence: 0.98 },
                { source: 'CloseDate', target: 'shipDate', confidence: 0.88 },
                { source: 'AccountId', target: 'entity', confidence: 0.95 }
              ]
            });
          } else if (sourceSystem.toLowerCase().includes('dynamics') && targetSystem.toLowerCase().includes('salesforce')) {
            searchResults.push({
              id: 'd365-sf-account-wizard',
              name: 'Dynamics 365 to Salesforce Account Sync',
              description: 'Bidirectional account synchronization template',
              sourceSystem,
              targetSystem,
              confidence: 0.95,
              fieldCount: 10,
              estimatedSaveTime: '1.5-2 hours',
              complexity: 'medium',
              category: 'account-management',
              tags: ['accounts', 'crm', 'bidirectional'],
              previewMappings: [
                { source: 'name', target: 'Name', confidence: 0.99 },
                { source: 'emailaddress1', target: 'Email__c', confidence: 0.94 },
                { source: 'telephone1', target: 'Phone', confidence: 0.96 },
                { source: 'websiteurl', target: 'Website', confidence: 0.98 }
              ]
            });
          } else if (sourceSystem.toLowerCase().includes('sap') || targetSystem.toLowerCase().includes('oracle')) {
            searchResults.push({
              id: 'sap-oracle-material-wizard',
              name: 'SAP to Oracle Material Master Integration',
              description: 'Enterprise material and product data synchronization',
              sourceSystem,
              targetSystem,
              confidence: 0.89,
              fieldCount: 15,
              estimatedSaveTime: '3-4 hours',
              complexity: 'high',
              category: 'material-master',
              tags: ['materials', 'products', 'erp', 'master-data'],
              previewMappings: [
                { source: 'MATNR', target: 'ITEM_NUMBER', confidence: 0.98 },
                { source: 'MAKTX', target: 'ITEM_DESCRIPTION', confidence: 0.96 },
                { source: 'MEINS', target: 'PRIMARY_UOM_CODE', confidence: 0.88 },
                { source: 'MTART', target: 'ITEM_TYPE', confidence: 0.85 }
              ]
            });
          }
        }
        
        // Add generic templates if no specific matches or as fallback
        if (searchResults.length === 0 || searchResults.length < 3) {
          searchResults.push({
            id: 'generic-entity-wizard',
            name: 'Generic Entity Integration Template',
            description: 'Basic template for standard entity field mapping',
            sourceSystem: source || 'Any System',
            targetSystem: target || 'Any System',
            confidence: 0.75,
            fieldCount: 6,
            estimatedSaveTime: '30-60 minutes',
            complexity: 'low',
            category: 'generic',
            tags: ['basic', 'starter', 'general'],
            previewMappings: [
              { source: 'name', target: 'entity_name', confidence: 0.85 },
              { source: 'email', target: 'contact_email', confidence: 0.90 },
              { source: 'phone', target: 'contact_phone', confidence: 0.88 },
              { source: 'id', target: 'external_id', confidence: 0.95 }
            ]
          });
          
          searchResults.push({
            id: 'custom-template-wizard',
            name: 'Create Custom Template',
            description: 'Start with a blank template and build your own mappings',
            sourceSystem: source || 'Custom',
            targetSystem: target || 'Custom',
            confidence: 1.0,
            fieldCount: 0,
            estimatedSaveTime: '2-4 hours',
            complexity: 'custom',
            category: 'custom',
            tags: ['custom', 'blank', 'manual'],
            previewMappings: [] as unknown[],
            isCustom: true
          });
        }
        
        const response = {
          templates: searchResults,
          totalFound: searchResults.length,
          searchParams: { source, target, type },
          suggestions: {
            improveAccuracy: 'Provide sample data for better template matching',
            alternatives: 'Consider using AI-generated suggestions for unmapped fields',
            bestPractices: 'Test templates with small data sets before production use'
          },
          mock: true
        };
        
        logger.info(`[MOCK] Template search returning ${searchResults.length} templates for ${source} → ${target}`);
        res.json(response);
        
      } catch (error) {
        logger.error('Template search error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to search templates',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  }

  // Test endpoint to verify mock router is working
  router.get('/api/test-template-endpoint', (req, res) => {
    logger.info('[MOCK] Test endpoint called!');
    res.json({ message: 'Mock router is working!', test: true });
  });

  return router;
}