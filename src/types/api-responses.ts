// NetSuite API Response Types
export interface NetSuiteRecord {
  internalid: string;
  externalid?: string;
  lastmodifieddate?: string;
  version?: string;
  [key: string]: unknown;
}

export interface NetSuiteListResponse<T = NetSuiteRecord> {
  items: T[];
  count?: number;
  hasMore?: boolean;
  offset?: number;
  totalResults?: number;
}

export interface NetSuiteSearchResponse<T = NetSuiteRecord> {
  items: T[];
  count: number;
  hasMore: boolean;
  offset: number;
}

export interface NetSuiteWebhookResponse {
  id: string;
  name: string;
  url: string;
  events: string[];
  isActive: boolean;
}

// Dynamics 365 API Response Types
export interface DynamicsRecord {
  [key: string]: unknown;
  createdon?: string;
  modifiedon?: string;
  versionnumber?: number;
  externalid?: string;
}

export interface DynamicsListResponse<T = DynamicsRecord> {
  '@odata.context': string;
  '@odata.count'?: number;
  '@odata.nextLink'?: string;
  value: T[];
}

export interface DynamicsAccount extends DynamicsRecord {
  accountid: string;
  name: string;
  emailaddress1?: string;
  telephone1?: string;
  description?: string;
}

export interface DynamicsContact extends DynamicsRecord {
  contactid: string;
  fullname: string;
  emailaddress1?: string;
  telephone1?: string;
}

export interface DynamicsLead extends DynamicsRecord {
  leadid: string;
  fullname: string;
  emailaddress1?: string;
  telephone1?: string;
}

export interface DynamicsOpportunity extends DynamicsRecord {
  opportunityid: string;
  name: string;
  estimatedvalue?: number;
  actualvalue?: number;
}

export interface DynamicsOrganization extends DynamicsRecord {
  organizationid: string;
  friendlyname: string;
  version: string;
}

export interface DynamicsWebhookResponse {
  serviceendpointid: string;
  name: string;
  url: string;
  contract: number;
  authtype: number;
  description?: string;
}

// Generic API Error Response
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown[];
  };
  status?: number;
  timestamp?: string;
}

// OAuth Token Response
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}
