import type { IntegrationConfig, DataRecord } from '../types';

export const sampleCustomerData: DataRecord[] = [
  {
    id: 'sf_001',
    externalId: 'SF-CUSTOMER-001',
    fields: {
      Name: 'Acme Corporation',
      Email: 'contact@acme.com',
      Phone: '+1-555-0123',
      BillingStreet: '123 Business Ave',
      BillingCity: 'New York',
      BillingState: 'NY',
      BillingPostalCode: '10001',
      IsActive: true,
      LastActivityDate: '2024-01-15T10:30:00Z',
      Industry: 'Technology',
      AnnualRevenue: 5000000,
      NumberOfEmployees: 150,
    },
    metadata: {
      source: 'Salesforce',
      lastModified: new Date('2024-01-15T10:30:00Z'),
      version: '1.0',
    },
  },
  {
    id: 'sf_002',
    externalId: 'SF-CUSTOMER-002',
    fields: {
      Name: 'Global Manufacturing Inc',
      Email: 'info@globalmanufacturing.com',
      Phone: '+1-555-0456',
      BillingStreet: '456 Industrial Blvd',
      BillingCity: 'Chicago',
      BillingState: 'IL',
      BillingPostalCode: '60601',
      IsActive: true,
      LastActivityDate: '2024-01-10T14:15:00Z',
      Industry: 'Manufacturing',
      AnnualRevenue: 25000000,
      NumberOfEmployees: 500,
    },
    metadata: {
      source: 'Salesforce',
      lastModified: new Date('2024-01-10T14:15:00Z'),
      version: '1.0',
    },
  },
  {
    id: 'sf_003',
    externalId: 'SF-CUSTOMER-003',
    fields: {
      Name: 'Retail Solutions LLC',
      Email: 'contact@retailsolutions.com',
      Phone: '+1-555-0789',
      BillingStreet: '789 Commerce St',
      BillingCity: 'Los Angeles',
      BillingState: 'CA',
      BillingPostalCode: '90210',
      IsActive: false,
      LastActivityDate: '2023-12-20T09:00:00Z',
      Industry: 'Retail',
      AnnualRevenue: 3000000,
      NumberOfEmployees: 75,
    },
    metadata: {
      source: 'Salesforce',
      lastModified: new Date('2023-12-20T09:00:00Z'),
      version: '1.0',
    },
  },
];

export const sampleNetSuiteCustomerData: DataRecord[] = [
  {
    id: 'ns_001',
    externalId: 'NS-CUSTOMER-001',
    fields: {
      companyname: 'Tech Innovators Corp',
      email: 'hello@techinnovators.com',
      phone: '+1-555-1111',
      defaultaddress: '321 Innovation Drive, San Francisco, CA, 94105',
      terms: 'Net 30',
      taxable: true,
      creditlimit: 100000,
      category: 'Enterprise',
    },
    metadata: {
      source: 'NetSuite',
      lastModified: new Date('2024-01-12T16:20:00Z'),
      version: '2.1',
    },
  },
  {
    id: 'ns_002',
    externalId: 'NS-CUSTOMER-002',
    fields: {
      companyname: 'Healthcare Systems Inc',
      email: 'accounts@healthcaresystems.com',
      phone: '+1-555-2222',
      defaultaddress: '654 Medical Center Dr, Boston, MA, 02115',
      terms: 'Net 15',
      taxable: true,
      creditlimit: 250000,
      category: 'Healthcare',
    },
    metadata: {
      source: 'NetSuite',
      lastModified: new Date('2024-01-08T11:45:00Z'),
      version: '1.8',
    },
  },
];

export const sampleDynamicsAccountData: DataRecord[] = [
  {
    id: 'dyn_001',
    externalId: 'DYN-ACCOUNT-001',
    fields: {
      name: 'Financial Services Group',
      emailaddress1: 'contact@financialservicesgroup.com',
      telephone1: '+1-555-3333',
      address1_line1: '987 Financial Plaza',
      address1_city: 'New York',
      address1_stateorprovince: 'NY',
      address1_postalcode: '10004',
      industrycode: 'Financial Services',
      revenue: 15000000,
      numberofemployees: 300,
      customertypecode: 'Enterprise',
    },
    metadata: {
      source: 'Dynamics365',
      lastModified: new Date('2024-01-14T13:30:00Z'),
      version: '3.2',
    },
  },
];

export const salesforceToNetSuiteConfig: IntegrationConfig = {
  id: 'sf_to_ns_customers',
  name: 'Salesforce to NetSuite Customer Sync',
  sourceSystem: 'Salesforce',
  targetSystem: 'NetSuite',
  sourceEntity: 'Account',
  targetEntity: 'Customer',
  syncDirection: 'source_to_target',
  syncMode: 'realtime',
  isActive: true,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-15T10:30:00Z'),
  fieldMappings: [
    {
      sourceField: 'Name',
      targetField: 'companyname',
      isRequired: true,
      transformationType: 'direct',
    },
    {
      sourceField: 'Email',
      targetField: 'email',
      isRequired: true,
      transformationType: 'direct',
    },
    {
      sourceField: 'Phone',
      targetField: 'phone',
      isRequired: false,
      transformationType: 'direct',
    },
    {
      sourceField: 'BillingAddress',
      targetField: 'defaultaddress',
      isRequired: false,
      transformationType: 'concatenation',
      transformationConfig: {
        type: 'concatenation',
        fields: ['BillingStreet', 'BillingCity', 'BillingState', 'BillingPostalCode'],
        separator: ', ',
      },
    },
    {
      sourceField: 'Industry',
      targetField: 'category',
      isRequired: false,
      transformationType: 'lookup',
      transformationConfig: {
        type: 'lookup',
        lookupTable: 'industry_mapping',
        keyField: 'source_industry',
        valueField: 'target_category',
      },
    },
    {
      sourceField: 'AnnualRevenue',
      targetField: 'creditlimit',
      isRequired: false,
      transformationType: 'calculation',
      transformationConfig: {
        type: 'calculation',
        expression: 'VALUE * 0.1', // Set credit limit to 10% of annual revenue
      },
    },
  ],
  transformationRules: [
    {
      id: 'validate_email',
      name: 'Validate Email Format',
      type: 'data_validation',
      action: 'validate_field',
      parameters: {
        type: 'data_validation',
        rules: [{
          field: 'email',
          type: 'format',
          value: { pattern: '^[\\w-\\.]+@([\\w-]+\\.)+[\\w-]{2,4}$' },
          message: 'Invalid email format',
        }],
      },
    },
    {
      id: 'set_payment_terms',
      name: 'Set Payment Terms Based on Revenue',
      type: 'business_logic',
      action: 'conditional_mapping',
      parameters: {
        type: 'business_logic',
        expression: 'if (${AnnualRevenue} > 10000000) { terms = "Net 15" } else if (${AnnualRevenue} > 1000000) { terms = "Net 30" } else { terms = "Net 45" }',
        context: { defaultTerms: 'Net 45' },
      },
    },
    {
      id: 'set_taxable_status',
      name: 'Set Taxable Status',
      type: 'business_logic',
      action: 'set_default_value',
      parameters: {
        type: 'business_logic',
        expression: 'taxable = true',
        context: {},
      },
    },
  ],
  sourceAuthentication: {
    type: 'oauth2',
    credentials: {
      clientId: process.env.SALESFORCE_CLIENT_ID || '',
      clientSecret: process.env.SALESFORCE_CLIENT_SECRET || '',
      tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
    },
  },
  targetAuthentication: {
    type: 'oauth1',
    credentials: {
      consumerKey: process.env.NETSUITE_CONSUMER_KEY || '',
      consumerSecret: process.env.NETSUITE_CONSUMER_SECRET || '',
      tokenId: process.env.NETSUITE_TOKEN_ID || '',
      tokenSecret: process.env.NETSUITE_TOKEN_SECRET || '',
      accountId: process.env.NETSUITE_ACCOUNT_ID || '',
    },
  },
};

export const dynamicsToSalesforceConfig: IntegrationConfig = {
  id: 'dyn_to_sf_accounts',
  name: 'Dynamics 365 to Salesforce Account Sync',
  sourceSystem: 'Dynamics365',
  targetSystem: 'Salesforce',
  sourceEntity: 'Account',
  targetEntity: 'Account',
  syncDirection: 'bidirectional',
  syncMode: 'batch',
  isActive: true,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-15T10:30:00Z'),
  fieldMappings: [
    {
      sourceField: 'name',
      targetField: 'Name',
      isRequired: true,
      transformationType: 'direct',
    },
    {
      sourceField: 'emailaddress1',
      targetField: 'Email',
      isRequired: true,
      transformationType: 'direct',
    },
    {
      sourceField: 'telephone1',
      targetField: 'Phone',
      isRequired: false,
      transformationType: 'direct',
    },
    {
      sourceField: 'address',
      targetField: 'BillingAddress',
      isRequired: false,
      transformationType: 'concatenation',
      transformationConfig: {
        type: 'concatenation',
        fields: ['address1_line1', 'address1_city', 'address1_stateorprovince', 'address1_postalcode'],
        separator: ', ',
      },
    },
    {
      sourceField: 'industrycode',
      targetField: 'Industry',
      isRequired: false,
      transformationType: 'direct',
    },
    {
      sourceField: 'revenue',
      targetField: 'AnnualRevenue',
      isRequired: false,
      transformationType: 'direct',
    },
    {
      sourceField: 'numberofemployees',
      targetField: 'NumberOfEmployees',
      isRequired: false,
      transformationType: 'direct',
    },
  ],
  transformationRules: [
    {
      id: 'validate_required_fields',
      name: 'Validate Required Fields',
      type: 'data_validation',
      action: 'validate_required',
      parameters: {
        type: 'data_validation',
        rules: [
          { field: 'name', type: 'required', message: 'Name is required' },
          { field: 'emailaddress1', type: 'required', message: 'Email is required' },
        ],
      },
    },
    {
      id: 'set_account_type',
      name: 'Set Account Type Based on Revenue',
      type: 'business_logic',
      action: 'derive_account_type',
      parameters: {
        type: 'business_logic',
        expression: 'if (${revenue} > 50000000) { Type = "Customer - Enterprise" } else if (${revenue} > 5000000) { Type = "Customer - Mid-Market" } else { Type = "Customer - Small Business" }',
        context: { defaultType: 'Customer - Small Business' },
      },
    },
  ],
  sourceAuthentication: {
    type: 'oauth2',
    credentials: {
      clientId: process.env.DYNAMICS_CLIENT_ID || '',
      clientSecret: process.env.DYNAMICS_CLIENT_SECRET || '',
      tokenUrl: process.env.DYNAMICS_TOKEN_URL || 'https://login.microsoftonline.com/common/oauth2/token',
      scope: 'https://graph.microsoft.com/.default',
    },
  },
  targetAuthentication: {
    type: 'oauth2',
    credentials: {
      clientId: process.env.SALESFORCE_CLIENT_ID || '',
      clientSecret: process.env.SALESFORCE_CLIENT_SECRET || '',
      tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
    },
  },
};

export const businessCentralToNetSuiteConfig: IntegrationConfig = {
  id: 'bc_to_ns_items',
  name: 'Business Central to NetSuite Item Sync',
  sourceSystem: 'BusinessCentral',
  targetSystem: 'NetSuite',
  sourceEntity: 'Item',
  targetEntity: 'Item',
  syncDirection: 'source_to_target',
  syncMode: 'batch',
  isActive: true,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-15T10:30:00Z'),
  fieldMappings: [
    {
      sourceField: 'No.',
      targetField: 'itemid',
      isRequired: true,
      transformationType: 'direct',
    },
    {
      sourceField: 'Name',
      targetField: 'displayname',
      isRequired: true,
      transformationType: 'direct',
    },
    {
      sourceField: 'Description',
      targetField: 'description',
      isRequired: false,
      transformationType: 'direct',
    },
    {
      sourceField: 'Status',
      targetField: 'isinactive',
      isRequired: false,
      transformationType: 'lookup',
      transformationConfig: {
        type: 'lookup',
        lookupTable: 'status_mapping',
        keyField: 'status',
        valueField: 'is_inactive',
      },
    },
  ],
  transformationRules: [
    {
      id: 'validate_item_number',
      name: 'Validate Item Number Format',
      type: 'data_validation',
      action: 'validate_field',
      parameters: {
        type: 'data_validation',
        rules: [{
          field: 'itemid',
          type: 'format',
          value: { pattern: '^[A-Z0-9]{3,20}$' },
          message: 'Item ID must be 3-20 alphanumeric characters',
        }],
      },
    },
    {
      id: 'set_item_type',
      name: 'Set Default Item Type',
      type: 'business_logic',
      action: 'set_default_value',
      parameters: {
        type: 'business_logic',
        expression: 'itemtype = "InvtPart"',
        context: {},
      },
    },
  ],
  sourceAuthentication: {
    type: 'oauth2',
    credentials: {
      clientId: process.env.BC_CLIENT_ID || '',
      clientSecret: process.env.BC_CLIENT_SECRET || '',
      tokenUrl: process.env.BC_TOKEN_URL || 'https://login.microsoftonline.com/common/oauth2/token',
      scope: 'https://api.businesscentral.dynamics.com/.default',
    },
  },
  targetAuthentication: {
    type: 'oauth1',
    credentials: {
      consumerKey: process.env.NETSUITE_CONSUMER_KEY || '',
      consumerSecret: process.env.NETSUITE_CONSUMER_SECRET || '',
      tokenId: process.env.NETSUITE_TOKEN_ID || '',
      tokenSecret: process.env.NETSUITE_TOKEN_SECRET || '',
      accountId: process.env.NETSUITE_ACCOUNT_ID || '',
    },
  },
};

export const sampleConfigurations = [
  salesforceToNetSuiteConfig,
  dynamicsToSalesforceConfig,
  businessCentralToNetSuiteConfig,
];

export const sampleTestData = {
  customers: sampleCustomerData,
  netsuiteCustomers: sampleNetSuiteCustomerData,
  dynamicsAccounts: sampleDynamicsAccountData,
};

export const sampleSquireCredentials = {
  type: 'api_key',
  credentials: {
    apiKey: process.env.SQUIRE_API_KEY || 'demo-api-key',
    baseUrl: process.env.SQUIRE_BASE_URL || 'https://api.squire.com',
  },
};
