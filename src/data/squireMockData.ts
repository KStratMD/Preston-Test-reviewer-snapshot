import type { DataRecord } from '../types';
import type { FieldMappingMetadata } from '../utils/fieldMapper';

export interface SquireVendor extends DataRecord {
  id: string;
  vendorName: string;
  contactPerson: string;
  vendorEmail: string;
  businessPhone: string;
  businessAddress: string;
  paymentTermsCode: string;
  vendorCategory: string;
  approvalStatus: string;
  federalTaxId: string;
  vendorWebsite: string;
  qualityRating: number;
  onboardingDate: string;
  lastEvaluation: string;
  squireVendorCode: string;
  complianceStatus: string;
  preferredVendor: boolean;
  creditLimit: number;
}

export interface SquireInstaller extends DataRecord {
  id: string;
  installerName: string;
  businessName: string;
  contactEmail: string;
  primaryPhone: string;
  serviceAddress: string;
  licenseNumber: string;
  licenseExpiry: string;
  serviceAreas: string[];
  specializations: string[];
  certificationLevel: string;
  availabilityStatus: string;
  insuranceExpiry: string;
  averageRating: number;
  completedProjects: number;
  onboardingDate: string;
  lastProjectDate: string;
  squireInstallerId: string;
  workingRadius: number;
  hourlyRate: number;
}

export interface SquireProject extends DataRecord {
  id: string;
  projectNumber: string;
  customerName: string;
  projectType: string;
  projectStatus: string;
  assignedInstaller: string;
  installationDate: string;
  projectValue: number;
  commissionRate: number;
  projectAddress: string;
  equipmentList: string[];
  estimatedHours: number;
  actualHours?: number;
  completionDate?: string;
  customerSatisfaction?: number;
  squireProjectId: string;
  salesRepId: string;
  payoutStatus: string;
  invoiceNumber?: string;
}

export interface SquireCustomer extends DataRecord {
  id: string;
  companyName: string;
  contactEmail: string;
  primaryPhone: string;
  mailingAddress: string;
  customerClass: string;
  creditRating: string;
  isActive: boolean;
  businessType: string;
  companyWebsite: string;
  registrationDate: string;
  lastActivity: string;
  squireCustomerId: string;
  accountManager: string;
  annualRevenue?: number;
  paymentTerms: string;
}

export const squireVendors: SquireVendor[] = [
  {
    id: 'SQ_VEND_001',
    vendorName: 'Office Supply Experts',
    contactPerson: 'Sarah Johnson',
    vendorEmail: 'sarah@officesupplyexperts.com',
    businessPhone: '555-111-0001',
    businessAddress: '111 Supply Chain Ave, Denver, CO 80202',
    paymentTermsCode: 'NET30',
    vendorCategory: 'Office Equipment',
    approvalStatus: 'Approved',
    federalTaxId: '12-3456789',
    vendorWebsite: 'officesupplyexperts.com',
    qualityRating: 4.8,
    onboardingDate: '2022-11-05',
    lastEvaluation: new Date().toISOString(),
    squireVendorCode: 'SV_001',
    complianceStatus: 'compliant',
    preferredVendor: true,
    creditLimit: 50000,
  },
  {
    id: 'SQ_VEND_002',
    vendorName: 'Tech Components Direct',
    contactPerson: 'Michael Chen',
    vendorEmail: 'michael@techcomponents.com',
    businessPhone: '555-222-0002',
    businessAddress: '222 Component Way, Phoenix, AZ 85001',
    paymentTermsCode: 'NET15',
    vendorCategory: 'Technology Hardware',
    approvalStatus: 'Approved',
    federalTaxId: '98-7654321',
    vendorWebsite: 'techcomponents.com',
    qualityRating: 4.6,
    onboardingDate: '2023-01-20',
    lastEvaluation: new Date().toISOString(),
    squireVendorCode: 'SV_002',
    complianceStatus: 'compliant',
    preferredVendor: true,
    creditLimit: 75000,
  },
  {
    id: 'SQ_VEND_003',
    vendorName: 'Industrial Solutions Corp',
    contactPerson: 'Lisa Rodriguez',
    vendorEmail: 'lisa@industrialsolutions.com',
    businessPhone: '555-333-0003',
    businessAddress: '333 Industrial Blvd, Houston, TX 77001',
    paymentTermsCode: 'NET45',
    vendorCategory: 'Industrial Equipment',
    approvalStatus: 'Under Review',
    federalTaxId: '45-7891234',
    vendorWebsite: 'industrialsolutions.com',
    qualityRating: 4.2,
    onboardingDate: '2023-08-15',
    lastEvaluation: new Date().toISOString(),
    squireVendorCode: 'SV_003',
    complianceStatus: 'pending-review',
    preferredVendor: false,
    creditLimit: 25000,
  },
];

export const squireInstallers: SquireInstaller[] = [
  {
    id: 'SQ_INST_001',
    installerName: 'Alex Thompson',
    businessName: 'Thompson Professional Installs',
    contactEmail: 'alex@thompsoninstalls.com',
    primaryPhone: '555-444-0001',
    serviceAddress: '444 Service St, Atlanta, GA 30301',
    licenseNumber: 'GA-HVAC-2023-001',
    licenseExpiry: '2025-12-31',
    serviceAreas: ['Atlanta', 'Marietta', 'Roswell', 'Alpharetta'],
    specializations: ['HVAC', 'Electrical', 'Plumbing'],
    certificationLevel: 'Master',
    availabilityStatus: 'Available',
    insuranceExpiry: '2024-12-31',
    averageRating: 4.9,
    completedProjects: 156,
    onboardingDate: '2021-03-15',
    lastProjectDate: '2024-08-20',
    squireInstallerId: 'SI_001',
    workingRadius: 50,
    hourlyRate: 85,
  },
  {
    id: 'SQ_INST_002',
    installerName: 'Maria Gonzalez',
    businessName: 'Precision Install Services',
    contactEmail: 'maria@precisioninstalls.com',
    primaryPhone: '555-555-0002',
    serviceAddress: '555 Precision Way, Miami, FL 33101',
    licenseNumber: 'FL-MULTI-2023-002',
    licenseExpiry: '2025-06-30',
    serviceAreas: ['Miami', 'Fort Lauderdale', 'Boca Raton', 'West Palm Beach'],
    specializations: ['Solar', 'Electrical', 'Security Systems'],
    certificationLevel: 'Certified',
    availabilityStatus: 'Booked',
    insuranceExpiry: '2025-01-31',
    averageRating: 4.7,
    completedProjects: 89,
    onboardingDate: '2022-07-10',
    lastProjectDate: '2024-08-22',
    squireInstallerId: 'SI_002',
    workingRadius: 75,
    hourlyRate: 90,
  },
  {
    id: 'SQ_INST_003',
    installerName: 'David Kim',
    businessName: 'Elite Installation Co',
    contactEmail: 'david@eliteinstall.com',
    primaryPhone: '555-666-0003',
    serviceAddress: '666 Elite Drive, Los Angeles, CA 90210',
    licenseNumber: 'CA-CONT-2023-003',
    licenseExpiry: '2026-03-31',
    serviceAreas: ['Los Angeles', 'Beverly Hills', 'Santa Monica', 'Pasadena'],
    specializations: ['Home Theater', 'Security', 'Network'],
    certificationLevel: 'Advanced',
    availabilityStatus: 'Available',
    insuranceExpiry: '2025-05-31',
    averageRating: 4.8,
    completedProjects: 234,
    onboardingDate: '2020-11-20',
    lastProjectDate: '2024-08-18',
    squireInstallerId: 'SI_003',
    workingRadius: 60,
    hourlyRate: 95,
  },
];

export const squireProjects: SquireProject[] = [
  {
    id: 'SQ_PROJ_001',
    projectNumber: 'PRJ-2024-001',
    customerName: 'Acme Manufacturing Inc',
    projectType: 'HVAC Installation',
    projectStatus: 'In Progress',
    assignedInstaller: 'SQ_INST_001',
    installationDate: '2024-08-27',
    projectValue: 15000,
    commissionRate: 0.12,
    projectAddress: '123 Industrial Parkway, Seattle, WA 98101',
    equipmentList: ['Industrial HVAC Unit', 'Ductwork', 'Controls'],
    estimatedHours: 32,
    actualHours: 28,
    squireProjectId: 'SP_001',
    salesRepId: 'SR_001',
    payoutStatus: 'Pending',
    invoiceNumber: 'INV-2024-001',
  },
  {
    id: 'SQ_PROJ_002',
    projectNumber: 'PRJ-2024-002',
    customerName: 'Global Technology Partners',
    projectType: 'Security System',
    projectStatus: 'Completed',
    assignedInstaller: 'SQ_INST_003',
    installationDate: '2024-08-15',
    projectValue: 8500,
    commissionRate: 0.10,
    projectAddress: '456 Tech Boulevard, Austin, TX 78701',
    equipmentList: ['Security Cameras', 'Access Control', 'Monitoring System'],
    estimatedHours: 16,
    actualHours: 14,
    completionDate: '2024-08-16',
    customerSatisfaction: 5,
    squireProjectId: 'SP_002',
    salesRepId: 'SR_002',
    payoutStatus: 'Paid',
    invoiceNumber: 'INV-2024-002',
  },
  {
    id: 'SQ_PROJ_003',
    projectNumber: 'PRJ-2024-003',
    customerName: 'Retail Solutions Corp',
    projectType: 'Electrical Upgrade',
    projectStatus: 'Scheduled',
    assignedInstaller: 'SQ_INST_002',
    installationDate: '2024-09-05',
    projectValue: 12000,
    commissionRate: 0.11,
    projectAddress: '789 Retail Row, New York, NY 10001',
    equipmentList: ['Electrical Panel', 'LED Lighting', 'Outlets'],
    estimatedHours: 24,
    squireProjectId: 'SP_003',
    salesRepId: 'SR_001',
    payoutStatus: 'Not Started',
  },
];

export const squireCustomers: SquireCustomer[] = [
  {
    id: 'SQ_CUST_001',
    companyName: 'Acme Manufacturing Inc',
    contactEmail: 'procurement@acme.com',
    primaryPhone: '555-123-0001',
    mailingAddress: '123 Industrial Parkway, Seattle, WA 98101',
    customerClass: 'Enterprise',
    creditRating: 'AAA',
    isActive: true,
    businessType: 'Manufacturing',
    companyWebsite: 'acme.com',
    registrationDate: '2023-01-15',
    lastActivity: new Date().toISOString(),
    squireCustomerId: 'SC_001',
    accountManager: 'John Davis',
    annualRevenue: 5000000,
    paymentTerms: 'NET30',
  },
  {
    id: 'SQ_CUST_002',
    companyName: 'Global Technology Partners',
    contactEmail: 'partnerships@globaltech.com',
    primaryPhone: '555-456-0002',
    mailingAddress: '456 Tech Boulevard, Austin, TX 78701',
    customerClass: 'Premium',
    creditRating: 'AA+',
    isActive: true,
    businessType: 'Technology Services',
    companyWebsite: 'globaltech.com',
    registrationDate: '2023-03-22',
    lastActivity: new Date().toISOString(),
    squireCustomerId: 'SC_002',
    accountManager: 'Sarah Wilson',
    annualRevenue: 3500000,
    paymentTerms: 'NET15',
  },
  {
    id: 'SQ_CUST_003',
    companyName: 'Retail Solutions Corp',
    contactEmail: 'purchasing@retailsolutions.com',
    primaryPhone: '555-789-0003',
    mailingAddress: '789 Retail Row, New York, NY 10001',
    customerClass: 'Standard',
    creditRating: 'A',
    isActive: true,
    businessType: 'Retail Operations',
    companyWebsite: 'retailsolutions.com',
    registrationDate: '2023-06-10',
    lastActivity: new Date().toISOString(),
    squireCustomerId: 'SC_003',
    accountManager: 'Mike Johnson',
    annualRevenue: 1800000,
    paymentTerms: 'NET30',
  },
];

// SuiteCentral mapping metadata for each module
export const suiteCentralMappings: Record<'supplierCentral' | 'installerCentral' | 'payoutCentral', FieldMappingMetadata> = {
  supplierCentral: {
    sourceSystem: 'Squire',
    targetSystem: 'SuiteCentral-SupplierCentral',
    module: 'SupplierCentral',
    recordType: 'vendor',
    mappings: [
      { sourceField: 'id', targetField: 'externalId', transformation: 'direct', required: true },
      { sourceField: 'vendorName', targetField: 'supplierName', transformation: 'direct', required: true },
      { sourceField: 'contactPerson', targetField: 'primaryContact', transformation: 'direct', required: true },
      { sourceField: 'vendorEmail', targetField: 'contactEmail', transformation: 'direct', required: true },
      { sourceField: 'businessPhone', targetField: 'phone', transformation: 'direct', required: false },
      { sourceField: 'businessAddress', targetField: 'address', transformation: 'direct', required: false },
      { sourceField: 'paymentTermsCode', targetField: 'paymentTerms', transformation: 'lookup', required: true, transformationValue: '{"NET30": "30_days", "NET15": "15_days", "NET45": "45_days", "_default": "30_days"}' },
      { sourceField: 'vendorCategory', targetField: 'supplierType', transformation: 'lookup', required: true, transformationValue: '{"Office Equipment": "office", "Technology Hardware": "technology", "Industrial Equipment": "industrial", "_default": "general"}' },
      { sourceField: 'approvalStatus', targetField: 'status', transformation: 'lookup', required: true, transformationValue: '{"Approved": "active", "Under Review": "pending", "Rejected": "inactive", "_default": "pending"}' },
      { sourceField: 'qualityRating', targetField: 'supplierScore', transformation: 'calculation', required: false, transformationValue: '{qualityRating} * 20' },
      { sourceField: 'preferredVendor', targetField: 'isPreferred', transformation: 'direct', required: false },
      { sourceField: 'creditLimit', targetField: 'creditLimit', transformation: 'direct', required: false },
    ],
  },
  installerCentral: {
    sourceSystem: 'Squire',
    targetSystem: 'SuiteCentral-InstallerCentral',
    module: 'InstallerCentral',
    recordType: 'installer',
    mappings: [
      { sourceField: 'id', targetField: 'externalId', transformation: 'direct', required: true },
      { sourceField: 'installerName', targetField: 'installerName', transformation: 'direct', required: true },
      { sourceField: 'businessName', targetField: 'companyName', transformation: 'direct', required: true },
      { sourceField: 'contactEmail', targetField: 'email', transformation: 'direct', required: true },
      { sourceField: 'primaryPhone', targetField: 'phone', transformation: 'direct', required: false },
      { sourceField: 'serviceAddress', targetField: 'businessAddress', transformation: 'direct', required: false },
      { sourceField: 'licenseNumber', targetField: 'licenseId', transformation: 'direct', required: true },
      { sourceField: 'licenseExpiry', targetField: 'licenseExpiration', transformation: 'direct', required: true },
      { sourceField: 'serviceAreas', targetField: 'serviceZones', transformation: 'concatenation', required: false, transformationValue: '{serviceAreas}' },
      { sourceField: 'specializations', targetField: 'skills', transformation: 'concatenation', required: false, transformationValue: '{specializations}' },
      { sourceField: 'certificationLevel', targetField: 'level', transformation: 'lookup', required: true, transformationValue: '{"Master": "master", "Certified": "certified", "Advanced": "advanced", "_default": "standard"}' },
      { sourceField: 'availabilityStatus', targetField: 'status', transformation: 'lookup', required: true, transformationValue: '{"Available": "available", "Booked": "busy", "Unavailable": "inactive", "_default": "available"}' },
      { sourceField: 'averageRating', targetField: 'rating', transformation: 'direct', required: false },
      { sourceField: 'workingRadius', targetField: 'serviceRadius', transformation: 'direct', required: false },
      { sourceField: 'hourlyRate', targetField: 'rate', transformation: 'direct', required: false },
    ],
  },
  payoutCentral: {
    sourceSystem: 'Squire',
    targetSystem: 'SuiteCentral-PayoutCentral',
    module: 'PayoutCentral',
    recordType: 'project',
    mappings: [
      { sourceField: 'id', targetField: 'externalId', transformation: 'direct', required: true },
      { sourceField: 'projectNumber', targetField: 'projectId', transformation: 'direct', required: true },
      { sourceField: 'customerName', targetField: 'clientName', transformation: 'direct', required: true },
      { sourceField: 'projectType', targetField: 'serviceType', transformation: 'direct', required: true },
      { sourceField: 'projectStatus', targetField: 'status', transformation: 'lookup', required: true, transformationValue: '{"Completed": "completed", "In Progress": "active", "Scheduled": "scheduled", "Cancelled": "cancelled", "_default": "pending"}' },
      { sourceField: 'assignedInstaller', targetField: 'installerId', transformation: 'direct', required: true },
      { sourceField: 'projectValue', targetField: 'totalAmount', transformation: 'direct', required: true },
      { sourceField: 'commissionRate', targetField: 'commissionPercent', transformation: 'calculation', required: true, transformationValue: '{commissionRate} * 100' },
      { sourceField: 'actualHours', targetField: 'hoursWorked', transformation: 'direct', required: false },
      { sourceField: 'completionDate', targetField: 'completedDate', transformation: 'direct', required: false },
      { sourceField: 'customerSatisfaction', targetField: 'satisfactionScore', transformation: 'direct', required: false },
      { sourceField: 'payoutStatus', targetField: 'paymentStatus', transformation: 'lookup', required: true, transformationValue: '{"Paid": "paid", "Pending": "pending", "Not Started": "not_applicable", "_default": "pending"}' },
      { sourceField: 'invoiceNumber', targetField: 'invoiceRef', transformation: 'direct', required: false },
    ],
  },
};

// Helper function to get sample records by type
export function getSampleRecords(recordType: 'vendors' | 'installers' | 'projects' | 'customers'): DataRecord[] {
  switch (recordType) {
    case 'vendors':
      return squireVendors;
    case 'installers':
      return squireInstallers;
    case 'projects':
      return squireProjects;
    case 'customers':
      return squireCustomers;
    default:
      return [];
  }
}

// Helper function to get mapping metadata by module
export function getMappingMetadata(module: 'supplierCentral' | 'installerCentral' | 'payoutCentral'): FieldMappingMetadata {
  return suiteCentralMappings[module];
}
