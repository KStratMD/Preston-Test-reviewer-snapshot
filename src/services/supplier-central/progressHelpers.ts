import type { VendorProfile } from '../../types/supplierCentral';

export function calculateOnboardingProgress(vendor: VendorProfile): number {
  let progress = 0;

  // Basic info (25%)
  if (vendor.basicInfo.companyName && vendor.basicInfo.taxId && vendor.contacts.primary.email) {
    progress += 25;
  }

  // W-9 Form (25%)
  if (vendor.compliance.w9Form.status === 'submitted' || vendor.compliance.w9Form.status === 'verified') {
    progress += 25;
  }

  // Insurance (25%)
  if (vendor.compliance.insurance.generalLiability.status === 'submitted' ||
      vendor.compliance.insurance.generalLiability.status === 'verified') {
    progress += 25;
  }

  // Banking info (25%)
  if (vendor.banking.accountNumber && vendor.banking.routingNumber) {
    progress += 25;
  }

  return Math.min(progress, 100);
}

export function getCompletedSteps(vendor: VendorProfile): string[] {
  const steps: string[] = [];

  if (vendor.basicInfo.companyName && vendor.basicInfo.taxId) {
    steps.push('basic_info');
  }

  if (vendor.contacts.primary.email && vendor.contacts.primary.phone) {
    steps.push('contact_info');
  }

  if (vendor.compliance.w9Form.status === 'submitted' || vendor.compliance.w9Form.status === 'verified') {
    steps.push('w9_form');
  }

  if (vendor.compliance.insurance.generalLiability.status === 'submitted' ||
      vendor.compliance.insurance.generalLiability.status === 'verified') {
    steps.push('insurance');
  }

  if (vendor.banking.accountNumber && vendor.banking.routingNumber) {
    steps.push('banking');
  }

  return steps;
}

export function getNextSteps(vendor: VendorProfile): string[] {
  const completed = getCompletedSteps(vendor);
  const allSteps = ['basic_info', 'contact_info', 'w9_form', 'insurance', 'banking'];

  return allSteps.filter(step => !completed.includes(step));
}

export function getProgressForStage(stage: VendorProfile['onboardingStatus']['stage']): number {
  const progressMap = {
    'initiated': 10,
    'profile_complete': 25,
    'documents_pending': 50,
    'compliance_review': 75,
    'approved': 95,
    'active': 100,
    'suspended': 100,
    'rejected': 0,
  };
  return progressMap[stage] || 0;
}

export function getStepsForStage(stage: VendorProfile['onboardingStatus']['stage']): string[] {
  switch (stage) {
    case 'initiated':
      return [];
    case 'profile_complete':
      return ['basic_info', 'contact_info'];
    case 'documents_pending':
      return ['basic_info', 'contact_info', 'banking'];
    case 'compliance_review':
      return ['basic_info', 'contact_info', 'banking', 'w9_form', 'insurance'];
    case 'approved':
    case 'active':
      return ['basic_info', 'contact_info', 'banking', 'w9_form', 'insurance', 'compliance_review'];
    default:
      return [];
  }
}

export function getNextStepsForStage(stage: VendorProfile['onboardingStatus']['stage']): string[] {
  switch (stage) {
    case 'initiated':
      return ['complete_profile', 'add_contacts'];
    case 'profile_complete':
      return ['upload_w9', 'upload_insurance', 'add_banking'];
    case 'documents_pending':
      return ['await_compliance_review'];
    case 'compliance_review':
      return ['await_approval'];
    case 'approved':
      return ['sync_to_business_central'];
    case 'active':
      return [];
    default:
      return [];
  }
}
