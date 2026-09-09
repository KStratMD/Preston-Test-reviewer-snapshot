// Unified Template System Types

export interface FieldMapping {
  source: string;
  target: string;
  transformation: string;
  params?: Record<string, unknown>;
  required?: boolean;
  validation?: string;
  description?: string;
}

export interface BusinessRule {
  name: string;
  condition: string;
  action: string;
  targetField?: string;
  value?: unknown;
  rate?: number;
  alertType?: string;
  taskType?: string;
  licenseType?: string;
  bonusRate?: number;
}

export interface TemplateMetadata {
  estimatedSetupTime?: number; // in minutes
  popularity?: number; // 0-100 score
  benefits?: string[];
  requirements?: string[];
  supportedSources?: string[];
  supportedTargets?: string[];
  lastModified?: string;
  createdBy?: string;
  version?: string;
}

export interface TemplateConfiguration {
  syncDirection?: 'unidirectional' | 'bidirectional';
  syncMode?: 'realtime' | 'batch' | 'scheduled' | string;
  batchSize?: number;
  retryAttempts?: number;
  errorHandling?: 'dlq' | 'retry' | 'skip' | 'alert';
  conflictResolution?: 'source_wins' | 'target_wins' | 'manual';
  businessRules?: BusinessRule[];
  validation?: {
    duplicateCheck?: boolean;
    approvalRequired?: string | boolean;
    auditLog?: boolean;
    recordCountValidation?: boolean;
    dataIntegrityChecks?: boolean;
    businessRuleValidation?: boolean;
    rollbackCapability?: boolean;
  };
}

export interface UnifiedTemplate {
  // Core fields (from mapping templates)
  key: string;
  name: string;
  description: string;
  sourceSystem: string;
  targetSystem: string;
  
  // Field mappings (enhanced)
  fields: FieldMapping[];
  
  // Metadata
  category?: string;
  tags?: string[];
  source?: 'builtin' | 'custom' | 'community';
  icon?: string;
  
  // Enhanced configuration (from integration templates)
  configuration?: TemplateConfiguration;
  metadata?: TemplateMetadata;
  
  // Workflow support
  workflow?: {
    stages?: {
      name: string;
      actions: string[];
      duration?: number;
    }[];
    triggers?: string[];
    notifications?: string[];
  };
}

export interface TemplateCategory {
  key: string;
  name: string;
  icon: string;
  description: string;
  templateCount?: number;
  order?: number;
}

export interface TemplateLibrary {
  templates: UnifiedTemplate[];
  categories: TemplateCategory[];
  version: string;
  lastUpdated: string;
}