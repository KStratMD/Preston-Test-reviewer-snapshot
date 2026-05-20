import type {
  VendorProfile,
  OnboardingTemplate,
  PortalActivity,
  CreateVendorProfileInput,
  VendorProfileFilters,
  PortalActivityPage,
} from '../../types/supplierCentral';
import type { SupplierCentralRuntime } from './SupplierCentralRuntime';
import {
  calculateOnboardingProgress,
  getProgressForStage,
  getStepsForStage,
  getNextStepsForStage,
} from './progressHelpers';

export class VendorDirectory {
  private vendors = new Map<string, VendorProfile>();
  private templates = new Map<string, OnboardingTemplate>();
  private activities = new Map<string, PortalActivity>();

  constructor(private runtime: SupplierCentralRuntime) {}

  /**
   * Create vendor profile from portal registration
   */
  async createVendorProfile(profileData: CreateVendorProfileInput): Promise<string> {
    const id = this.runtime.createId('vendor');

    const vendor: VendorProfile = {
      ...profileData,
      id,
      onboardingStatus: {
        stage: 'profile_complete',
        progress: 25,
        completedSteps: ['basic_info', 'contact_info'],
        nextSteps: ['upload_w9', 'upload_insurance'],
        notes: [{
          id: `note_${this.runtime.now()}`,
          timestamp: this.runtime.now(),
          author: 'system',
          content: 'Vendor profile created via self-service portal',
          type: 'info',
        }],
      },
      businessCentral: {
        syncStatus: 'pending',
        syncAttempts: 0,
      },
      netSuite: {
        syncStatus: 'pending',
        syncAttempts: 0,
      },
      metadata: {
        createdAt: this.runtime.now(),
        updatedAt: this.runtime.now(),
        source: 'portal',
        tags: [],
        customFields: {},
      },
    };

    this.vendors.set(id, vendor);

    // Record activity
    await this.recordActivity({
      vendorId: id,
      type: 'profile_update',
      description: 'Vendor profile created',
      metadata: { stage: 'initiated' },
    });

    this.runtime.logger.info('Vendor profile created', {
      vendorId: id,
      companyName: vendor.basicInfo.companyName,
      source: 'portal',
    });

    return id;
  }

  /**
   * Update vendor profile
   */
  async updateVendorProfile(vendorId: string, updates: Partial<VendorProfile>): Promise<void> {
    const vendor = this.vendors.get(vendorId);
    if (!vendor) {
      throw new Error(`Vendor not found: ${vendorId}`);
    }

    const updatedVendor: VendorProfile = {
      ...vendor,
      ...updates,
      metadata: {
        ...vendor.metadata,
        updatedAt: this.runtime.now(),
      },
    };

    // Recalculate onboarding progress
    updatedVendor.onboardingStatus = {
      ...updatedVendor.onboardingStatus,
      progress: calculateOnboardingProgress(updatedVendor),
    };

    this.vendors.set(vendorId, updatedVendor);

    // Record activity
    await this.recordActivity({
      vendorId,
      type: 'profile_update',
      description: 'Vendor profile updated',
      metadata: { updatedFields: Object.keys(updates) },
    });

    this.runtime.logger.info('Vendor profile updated', { vendorId, updates: Object.keys(updates) });
  }

  /**
   * Get vendor profile
   */
  async getVendorProfile(vendorId: string): Promise<VendorProfile | null> {
    const vendor = this.vendors.get(vendorId);
    return vendor ? this.cloneVendor(vendor) : null;
  }

  /**
   * Get vendor profiles with filtering
   */
  async getVendorProfiles(filters: VendorProfileFilters = {}): Promise<{ vendors: VendorProfile[]; totalCount: number }> {
    let filteredVendors = Array.from(this.vendors.values());

    // Apply filters
    if (filters.stage && filters.stage.length > 0) {
      filteredVendors = filteredVendors.filter(v => filters.stage!.includes(v.onboardingStatus.stage));
    }

    if (filters.industry && filters.industry.length > 0) {
      filteredVendors = filteredVendors.filter(v => filters.industry!.includes(v.basicInfo.industry));
    }

    if (filters.companySize && filters.companySize.length > 0) {
      filteredVendors = filteredVendors.filter(v => filters.companySize!.includes(v.basicInfo.companySize));
    }

    if (filters.source && filters.source.length > 0) {
      filteredVendors = filteredVendors.filter(v => filters.source!.includes(v.metadata.source));
    }

    if (filters.createdAfter) {
      filteredVendors = filteredVendors.filter(v => v.metadata.createdAt >= filters.createdAfter!);
    }

    if (filters.createdBefore) {
      filteredVendors = filteredVendors.filter(v => v.metadata.createdAt <= filters.createdBefore!);
    }

    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      filteredVendors = filteredVendors.filter(v =>
        v.basicInfo.companyName.toLowerCase().includes(searchLower) ||
        v.basicInfo.legalName?.toLowerCase().includes(searchLower) ||
        v.contacts.primary.email.toLowerCase().includes(searchLower) ||
        v.basicInfo.industry.toLowerCase().includes(searchLower)
      );
    }

    const totalCount = filteredVendors.length;

    // Sort by most recent first
    filteredVendors.sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt);

    // Apply pagination
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const vendors = filteredVendors
      .slice(offset, offset + limit)
      .map(vendor => this.cloneVendor(vendor));

    return { vendors, totalCount };
  }

  /**
   * Get vendor portal activity
   */
  async getPortalActivity(vendorId?: string, limit = 50, offset = 0): Promise<PortalActivityPage> {
    let activities = Array.from(this.activities.values());

    if (vendorId) {
      activities = activities.filter(a => a.vendorId === vendorId);
    }

    const totalCount = activities.length;

    // Sort by timestamp (most recent first)
    activities.sort((a, b) => b.timestamp - a.timestamp);

    // Apply pagination
    const paginatedActivities = activities.slice(offset, offset + limit);

    return { activities: paginatedActivities, totalCount };
  }

  async recordActivity(activity: Omit<PortalActivity, 'id' | 'timestamp'>): Promise<void> {
    const id = this.runtime.createId('activity');
    const fullActivity: PortalActivity = {
      ...activity,
      id,
      timestamp: this.runtime.now(),
    };

    this.activities.set(id, fullActivity);
  }

  // Collaborator-facing helpers used by other services (Tasks 4-7)
  updateVendor(vendorId: string, apply: (draft: VendorProfile) => undefined): VendorProfile | null {
    const vendor = this.vendors.get(vendorId);
    if (!vendor) {
      return null;
    }

    const draft = this.cloneVendor(vendor);
    const applyResult: unknown = apply(draft);
    // Reject async callbacks: mutations after an `await` would run AFTER we've
    // already stored `draft`, so the store would miss them. Type `undefined`
    // return catches this at compile time; this guards against the JS-level
    // escape hatch where a caller bypasses the types.
    if (
      typeof applyResult === 'object' &&
      applyResult !== null &&
      'then' in applyResult &&
      typeof (applyResult as { then?: unknown }).then === 'function'
    ) {
      throw new TypeError('updateVendor apply callback must be synchronous.');
    }
    this.vendors.set(vendorId, draft);
    return this.cloneVendor(draft);
  }

  getAllVendors(): VendorProfile[] {
    return Array.from(this.vendors.values(), vendor => this.cloneVendor(vendor));
  }

  getVendorById(vendorId: string): VendorProfile | undefined {
    const vendor = this.vendors.get(vendorId);
    return vendor ? this.cloneVendor(vendor) : undefined;
  }

  hasVendor(vendorId: string): boolean {
    return this.vendors.has(vendorId);
  }

  getAllActivities(): PortalActivity[] {
    return Array.from(this.activities.values());
  }

  private cloneVendor(vendor: VendorProfile): VendorProfile {
    return structuredClone(vendor);
  }

  /**
   * Initialize demo data
   */
  seedDemoData(): void {
    // Create sample onboarding templates
    const defaultTemplate: OnboardingTemplate = {
      id: 'template_default',
      name: 'Standard Vendor Onboarding',
      description: 'Default onboarding process for all vendor types',
      requiredDocuments: [
        {
          documentType: 'w9',
          required: true,
          description: 'W-9 Tax Form',
          acceptedFormats: ['pdf', 'png', 'jpg'],
          maxSize: 5 * 1024 * 1024, // 5MB
          expirationRequired: false,
        },
        {
          documentType: 'insurance_gl',
          required: true,
          description: 'General Liability Insurance Certificate',
          acceptedFormats: ['pdf', 'png', 'jpg'],
          maxSize: 10 * 1024 * 1024, // 10MB
          expirationRequired: true,
        },
      ],
      complianceRequirements: {
        minimumInsuranceCoverage: {
          generalLiability: 1000000, // $1M
        },
      },
      approvalWorkflow: {
        steps: [
          {
            id: 'compliance_review',
            name: 'Compliance Review',
            assignedRole: 'compliance_officer',
          },
          {
            id: 'final_approval',
            name: 'Final Approval',
            assignedRole: 'procurement_manager',
          },
        ],
        slaHours: 72,
        escalationRules: [
          {
            afterHours: 48,
            escalateTo: 'procurement_director',
          },
        ],
      },
      isActive: true,
      isDefault: true,
      createdAt: this.runtime.now() - (30 * 24 * 60 * 60 * 1000),
      updatedAt: this.runtime.now() - (7 * 24 * 60 * 60 * 1000),
    };

    this.templates.set(defaultTemplate.id, defaultTemplate);

    // Generate sample vendor profiles
    const sampleVendors = [
      {
        companyName: 'TechStart Solutions LLC',
        industry: 'Software Development',
        companySize: 'small' as const,
        stage: 'active' as const,
        email: 'contact@techstart-solutions.com',
        phone: '555-0101',
      },
      {
        companyName: 'Global Consulting Partners',
        industry: 'Management Consulting',
        companySize: 'medium' as const,
        stage: 'compliance_review' as const,
        email: 'admin@globalcp.com',
        phone: '555-0102',
      },
      {
        companyName: 'Advanced Manufacturing Co',
        industry: 'Manufacturing',
        companySize: 'large' as const,
        stage: 'documents_pending' as const,
        email: 'procurement@advmanuf.com',
        phone: '555-0103',
      },
      {
        companyName: 'Digital Marketing Pro',
        industry: 'Marketing',
        companySize: 'small' as const,
        stage: 'profile_complete' as const,
        email: 'hello@digitalmarketingpro.com',
        phone: '555-0104',
      },
      {
        companyName: 'Enterprise Security Systems',
        industry: 'Security Services',
        companySize: 'enterprise' as const,
        stage: 'approved' as const,
        email: 'security@enterprisesec.com',
        phone: '555-0105',
      },
    ];

    const now = this.runtime.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

    sampleVendors.forEach((sample, index) => {
      const id = `vendor_demo_${this.runtime.now()}_${index}`;
      const createdAt = thirtyDaysAgo + (this.runtime.random() * (now - thirtyDaysAgo));

      const vendor: VendorProfile = {
        id,
        basicInfo: {
          companyName: sample.companyName,
          legalName: sample.companyName,
          taxId: `12-345678${index}`,
          website: `https://www.${sample.companyName.toLowerCase().replace(/\s+/g, '')}.com`,
          industry: sample.industry,
          companySize: sample.companySize,
          yearEstablished: 2015 + Math.floor(this.runtime.random() * 8),
        },
        contacts: {
          primary: {
            firstName: 'John',
            lastName: `Doe${index + 1}`,
            title: 'CEO',
            email: sample.email,
            phone: sample.phone,
          },
        },
        addresses: {
          headquarters: {
            street1: `${123 + index} Business Blvd`,
            city: 'New York',
            state: 'NY',
            postalCode: `1000${index}`,
            country: 'US',
          },
        },
        banking: {
          accountName: sample.companyName,
          accountNumber: `****${1000 + index}`, // Encrypted in real implementation
          routingNumber: '021000021',
          bankName: 'Demo Bank',
          accountType: 'checking',
          currency: 'USD',
        },
        compliance: {
          w9Form: {
            status: sample.stage === 'active' ? 'verified' :
                   sample.stage === 'compliance_review' ? 'submitted' : 'pending',
            submittedAt: sample.stage !== 'profile_complete' ? createdAt + (24 * 60 * 60 * 1000) : undefined,
            verifiedAt: sample.stage === 'active' ? createdAt + (72 * 60 * 60 * 1000) : undefined,
          },
          insurance: {
            generalLiability: {
              status: sample.stage === 'active' ? 'verified' :
                     sample.stage === 'compliance_review' ? 'submitted' : 'pending',
              coverage: 1000000,
              expirationDate: now + (365 * 24 * 60 * 60 * 1000),
            },
            workersComp: {
              status: 'not_required',
            },
            professionalLiability: {
              status: 'not_required',
            },
          },
          certifications: sample.industry === 'Software Development' ? [
            {
              name: 'ISO 27001',
              issuingBody: 'International Organization for Standardization',
              certificateNumber: `ISO27001-${1000 + index}`,
              issuedDate: createdAt,
              expirationDate: now + (1095 * 24 * 60 * 60 * 1000), // 3 years
            },
          ] : [],
        },
        capabilities: {
          services: this.getServicesForIndustry(sample.industry),
          specializations: [],
          geographicCoverage: ['US', 'Canada'],
          languages: ['English'],
          businessHours: {
            timezone: 'EST',
            monday: { start: '09:00', end: '17:00' },
            tuesday: { start: '09:00', end: '17:00' },
            wednesday: { start: '09:00', end: '17:00' },
            thursday: { start: '09:00', end: '17:00' },
            friday: { start: '09:00', end: '17:00' },
            saturday: null,
            sunday: null,
          },
          capacity: {
            maxConcurrentProjects: 5,
            availableStartDate: now + (14 * 24 * 60 * 60 * 1000),
            preferredProjectSize: sample.companySize === 'small' ? 'small' :
                                  sample.companySize === 'large' ? 'large' : 'medium',
          },
        },
        onboardingStatus: {
          stage: sample.stage,
          progress: getProgressForStage(sample.stage),
          completedSteps: getStepsForStage(sample.stage),
          nextSteps: getNextStepsForStage(sample.stage),
          notes: [
            {
              id: `note_${createdAt}`,
              timestamp: createdAt,
              author: 'system',
              content: 'Vendor profile created via demo data initialization',
              type: 'info',
            },
          ],
          approvedAt: sample.stage === 'active' ? createdAt + (96 * 60 * 60 * 1000) : undefined,
          approvedBy: sample.stage === 'active' ? 'demo_admin' : undefined,
        },
        businessCentral: {
          vendorId: sample.stage === 'active' ? `BC_V_${1000 + index}` : undefined,
          syncStatus: sample.stage === 'active' ? 'synced' : 'pending',
          syncAttempts: sample.stage === 'active' ? 1 : 0,
          lastSyncAttempt: sample.stage === 'active' ? createdAt + (96 * 60 * 60 * 1000) : undefined,
        },
        netSuite: {
          vendorId: sample.stage === 'active' ? `NS_${100000 + index}` : undefined,
          internalId: sample.stage === 'active' ? `NS_${100000 + index}` : undefined,
          externalId: sample.stage === 'active' ? `VND_${sample.companyName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20)}_${index}` : undefined,
          syncStatus: sample.stage === 'active' ? 'synced' :
                     sample.stage === 'approved' ? 'pending' : 'pending',
          syncAttempts: sample.stage === 'active' ? 1 : 0,
          lastSyncAttempt: sample.stage === 'active' ? createdAt + (96 * 60 * 60 * 1000) : undefined,
          lastSyncSuccess: sample.stage === 'active' ? createdAt + (96 * 60 * 60 * 1000) : undefined,
          subsidiary: sample.stage === 'active' ? 'Parent Company' : undefined,
          terms: sample.stage === 'active' ? 'Net 30' : undefined,
          currency: sample.stage === 'active' ? 'USD' : undefined,
        },
        metadata: {
          createdAt,
          updatedAt: now - (this.runtime.random() * 86400000), // Updated within last day
          source: 'portal',
          tags: [sample.industry.toLowerCase().replace(/\s+/g, '_')],
          customFields: {},
        },
      };

      this.vendors.set(id, vendor);

      // Generate some sample activities
      this.generateSampleActivities(id, createdAt);
    });

    this.runtime.logger.info('SupplierCentral demo data initialized', {
      vendors: this.vendors.size,
      templates: this.templates.size,
    });
  }

  private getServicesForIndustry(industry: string): string[] {
    const serviceMap: Record<string, string[]> = {
      'Software Development': ['Custom Software Development', 'Mobile App Development', 'Web Development', 'API Integration'],
      'Management Consulting': ['Strategy Consulting', 'Process Optimization', 'Change Management', 'Business Analysis'],
      'Manufacturing': ['Product Manufacturing', 'Quality Control', 'Supply Chain Management', 'Logistics'],
      'Marketing': ['Digital Marketing', 'Content Creation', 'SEO Services', 'Social Media Management'],
      'Security Services': ['Cybersecurity Assessment', 'Penetration Testing', 'Security Monitoring', 'Compliance Auditing'],
    };

    return serviceMap[industry] || ['Professional Services'];
  }

  private generateSampleActivities(vendorId: string, createdAt: number): void {
    const activities = [
      {
        type: 'profile_update' as const,
        description: 'Vendor profile created',
        timestamp: createdAt,
      },
      {
        type: 'document_upload' as const,
        description: 'W-9 form uploaded',
        timestamp: createdAt + (24 * 60 * 60 * 1000),
      },
      {
        type: 'document_upload' as const,
        description: 'Insurance certificate uploaded',
        timestamp: createdAt + (25 * 60 * 60 * 1000),
      },
    ];

    activities.forEach((activity, index) => {
      const id = `activity_${vendorId}_${index}`;
      this.activities.set(id, {
        id,
        vendorId,
        ...activity,
      });
    });
  }
}
