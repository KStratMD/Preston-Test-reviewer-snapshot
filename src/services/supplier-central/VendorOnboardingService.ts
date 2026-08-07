import type {
  VendorProfile,
  VendorAssessmentResult,
  VendorOnboardingStats,
  BusinessCentralSyncResult,
} from '../../types/supplierCentral';
import type { SupplierCentralRuntime } from './SupplierCentralRuntime';
import type { VendorDirectory } from './VendorDirectory';
import type { VendorOnboardingAgentAdapter } from './VendorOnboardingAgentAdapter';

/**
 * Business workflow service for vendor onboarding lifecycle:
 * approve/reject/assess/sync-to-BC/stats. Owns no state — delegates to
 * VendorDirectory for persistence and to VendorOnboardingAgentAdapter for AI I/O.
 */
export class VendorOnboardingService {
  constructor(
    private runtime: SupplierCentralRuntime,
    private vendorDirectory: VendorDirectory,
    private adapter: VendorOnboardingAgentAdapter,
  ) {}

  /**
   * Approve vendor
   */
  async approveVendor(vendorId: string, approvedBy: string, notes?: string): Promise<void> {
    const now = this.runtime.now();
    const updatedVendor = this.vendorDirectory.updateVendor(vendorId, draft => {
      draft.onboardingStatus.stage = 'approved';
      draft.onboardingStatus.progress = 100;
      draft.onboardingStatus.approvedAt = now;
      draft.onboardingStatus.approvedBy = approvedBy;
      draft.onboardingStatus.nextSteps = ['sync_to_business_central'];

      if (notes) {
        draft.onboardingStatus.notes.push({
          id: `note_${now}`,
          timestamp: now,
          author: approvedBy,
          content: notes,
          type: 'success',
        });
      }

      draft.onboardingStatus.notes.push({
        id: `note_${now + 1}`,
        timestamp: now,
        author: 'system',
        content: `Vendor approved by ${approvedBy}`,
        type: 'success',
      });

      draft.metadata.updatedAt = now;
    });
    if (!updatedVendor) {
      throw new Error(`Vendor not found: ${vendorId}`);
    }

    // Record activity
    await this.vendorDirectory.recordActivity({
      vendorId,
      type: 'status_change',
      description: `Vendor approved by ${approvedBy}`,
      metadata: { previousStage: 'compliance_review', newStage: 'approved', approvedBy },
    });

    this.runtime.logger.info('Vendor approved', { vendorId, approvedBy });

    // Trigger Business Central sync
    await this.syncVendorToBusinessCentral(vendorId);
  }

  /**
   * Assess vendor for approval using AI-powered risk assessment
   * Calls VendorOnboardingAgent to evaluate risk, compliance, and generate recommendation
   */
  async assessVendorForApproval(vendorId: string): Promise<VendorAssessmentResult> {
    const vendor = this.vendorDirectory.getVendorById(vendorId);
    if (!vendor) {
      return { vendorId, assessment: null, error: 'Vendor not found' };
    }

    if (!this.runtime.vendorOnboardingAgent) {
      this.runtime.logger.warn('VendorOnboardingAgent not available, skipping AI assessment', { vendorId });
      return { vendorId, assessment: null, error: 'AI assessment not available' };
    }

    const adapterResult = await this.adapter.assess(vendor);

    if (!adapterResult.success || !adapterResult.data) {
      return { vendorId, assessment: null, error: adapterResult.error || 'Assessment failed' };
    }

    const assessment = adapterResult.data;

    this.runtime.logger.info('VendorOnboardingAgent assessment completed', {
      vendorId,
      onboardingStatus: assessment.onboardingStatus,
      recommendation: assessment.approvalRecommendation.recommend,
      riskLevel: assessment.riskAssessment?.overallRisk,
      complianceStatus: assessment.complianceChecklist?.overallStatus,
    });

    // Store assessment in vendor notes
    const now = this.runtime.now();
    const updatedVendor = this.vendorDirectory.updateVendor(vendorId, draft => {
      draft.onboardingStatus.notes.push({
        id: `note_${now}_assessment`,
        timestamp: now,
        author: 'ai-system',
        content: `AI Assessment: ${assessment.approvalRecommendation.recommend.toUpperCase()} (${(assessment.approvalRecommendation.confidence * 100).toFixed(0)}% confidence). Risk: ${assessment.riskAssessment?.overallRisk || 'N/A'}. Compliance: ${assessment.complianceChecklist?.completionPercentage || 0}%`,
        type: assessment.approvalRecommendation.recommend === 'approve' ? 'success' :
              assessment.approvalRecommendation.recommend === 'reject' ? 'error' : 'warning',
      });

      draft.metadata.customFields.aiAssessment = {
        assessedAt: now,
        recommendation: assessment.approvalRecommendation.recommend,
        confidence: assessment.approvalRecommendation.confidence,
        riskLevel: assessment.riskAssessment?.overallRisk,
        riskScore: assessment.riskAssessment?.riskScore,
        compliancePercentage: assessment.complianceChecklist?.completionPercentage,
      };

      draft.metadata.updatedAt = now;
    });
    if (!updatedVendor) {
      throw new Error(`Vendor not found: ${vendorId}`);
    }

    // Record activity
    await this.vendorDirectory.recordActivity({
      vendorId,
      type: 'status_change',
      description: `AI assessment completed: ${assessment.approvalRecommendation.recommend}`,
      metadata: {
        recommendation: assessment.approvalRecommendation.recommend,
        confidence: assessment.approvalRecommendation.confidence,
        riskLevel: assessment.riskAssessment?.overallRisk,
      },
    });

    return { vendorId, assessment };
  }

  /**
   * Reject vendor with reason
   */
  async rejectVendor(vendorId: string, rejectedBy: string, reason: string): Promise<void> {
    const now = this.runtime.now();
    const updatedVendor = this.vendorDirectory.updateVendor(vendorId, draft => {
      draft.onboardingStatus.stage = 'rejected';
      draft.onboardingStatus.rejectionReason = reason;
      draft.onboardingStatus.nextSteps = [];

      draft.onboardingStatus.notes.push({
        id: `note_${now}`,
        timestamp: now,
        author: rejectedBy,
        content: `Vendor rejected: ${reason}`,
        type: 'error',
      });

      draft.metadata.updatedAt = now;
    });
    if (!updatedVendor) {
      throw new Error(`Vendor not found: ${vendorId}`);
    }

    // Record activity
    await this.vendorDirectory.recordActivity({
      vendorId,
      type: 'status_change',
      description: `Vendor rejected by ${rejectedBy}`,
      metadata: { reason, rejectedBy },
    });

    this.runtime.logger.warn('Vendor rejected', { vendorId, rejectedBy, reason });
  }

  /**
   * Sync vendor to Business Central
   */
  async syncVendorToBusinessCentral(vendorId: string): Promise<BusinessCentralSyncResult> {
    if (!this.vendorDirectory.hasVendor(vendorId)) {
      throw new Error(`Vendor not found: ${vendorId}`);
    }

    try {
      // Simulate Business Central API call
      const now = this.runtime.now();
      const bcVendorId = `BC_V_${now}_${this.runtime.random().toString(36).slice(2, 2 + 6)}`;

      const updatedVendor = this.vendorDirectory.updateVendor(vendorId, draft => {
        draft.businessCentral.syncStatus = 'synced';
        draft.businessCentral.vendorId = bcVendorId;
        draft.businessCentral.syncAttempts++;
        draft.businessCentral.lastSyncAttempt = now;
        draft.businessCentral.syncErrors = [];

        if (draft.onboardingStatus.stage === 'approved') {
          draft.onboardingStatus.stage = 'active';
          draft.onboardingStatus.notes.push({
            id: `note_${now}`,
            timestamp: now,
            author: 'system',
            content: `Vendor successfully synced to Business Central (ID: ${bcVendorId})`,
            type: 'success',
          });
        }

        draft.metadata.updatedAt = now;
      });
      if (!updatedVendor) {
        throw new Error(`Vendor not found: ${vendorId}`);
      }

      // Record activity
      await this.vendorDirectory.recordActivity({
        vendorId,
        type: 'status_change',
        description: 'Vendor synced to Business Central',
        metadata: { bcVendorId, syncStatus: 'synced' },
      });

      this.runtime.logger.info('Vendor synced to Business Central', {
        vendorId,
        bcVendorId,
        companyName: updatedVendor.basicInfo.companyName,
      });

      return { success: true, bcVendorId };
    } catch (error) {
      const now = this.runtime.now();
      this.vendorDirectory.updateVendor(vendorId, draft => {
        draft.businessCentral.syncStatus = 'failed';
        draft.businessCentral.syncAttempts++;
        draft.businessCentral.lastSyncAttempt = now;
        draft.businessCentral.syncErrors = [
          error instanceof Error ? error.message : 'Unknown sync error'
        ];

        draft.metadata.updatedAt = now;
      });

      this.runtime.logger.error('Failed to sync vendor to Business Central', { error, vendorId });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown sync error'
      };
    }
  }

  /**
   * Get onboarding statistics
   */
  async getOnboardingStats(): Promise<VendorOnboardingStats> {
    const vendors = this.vendorDirectory.getAllVendors();
    const now = this.runtime.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

    // Summary
    const totalVendors = vendors.length;
    const activeVendors = vendors.filter(v => v.onboardingStatus.stage === 'active').length;
    const pendingApproval = vendors.filter(v =>
      v.onboardingStatus.stage === 'compliance_review' ||
      v.onboardingStatus.stage === 'documents_pending'
    ).length;
    const recentlyOnboarded = vendors.filter(v =>
      v.onboardingStatus.approvedAt && v.onboardingStatus.approvedAt >= thirtyDaysAgo
    ).length;

    // Calculate average onboarding time for approved vendors
    const approvedVendors = vendors.filter(v => v.onboardingStatus.approvedAt);
    const avgOnboardingTime = approvedVendors.length > 0 ?
      approvedVendors.reduce((sum, v) =>
        sum + (v.onboardingStatus.approvedAt! - v.metadata.createdAt), 0
      ) / (approvedVendors.length * 24 * 60 * 60 * 1000) : 0; // in days

    const completionRate = totalVendors > 0 ? (activeVendors / totalVendors) * 100 : 0;

    // By stage
    const stageStats = new Map<VendorProfile['onboardingStatus']['stage'], number>();
    vendors.forEach(v => {
      stageStats.set(v.onboardingStatus.stage, (stageStats.get(v.onboardingStatus.stage) || 0) + 1);
    });

    const byStage = Array.from(stageStats.entries()).map(([stage, count]) => ({
      stage,
      count,
      percentage: (count / totalVendors) * 100,
      averageTimeInStage: 2.5 + this.runtime.random() * 5, // Demo: 2.5-7.5 days
    }));

    // By industry
    const industryStats = new Map<string, { count: number; totalOnboardingTime: number }>();
    approvedVendors.forEach(v => {
      const stats = industryStats.get(v.basicInfo.industry) || { count: 0, totalOnboardingTime: 0 };
      stats.count++;
      stats.totalOnboardingTime += v.onboardingStatus.approvedAt! - v.metadata.createdAt;
      industryStats.set(v.basicInfo.industry, stats);
    });

    const byIndustry = Array.from(industryStats.entries()).map(([industry, stats]) => ({
      industry,
      count: stats.count,
      averageOnboardingTime: stats.totalOnboardingTime / (stats.count * 24 * 60 * 60 * 1000), // days
    }));

    // Compliance stats
    const w9Complete = vendors.filter(v => v.compliance.w9Form.status === 'verified').length;
    const insuranceComplete = vendors.filter(v =>
      v.compliance.insurance.generalLiability.status === 'verified' ||
      v.compliance.insurance.workersComp.status === 'verified'
    ).length;
    const certificationComplete = vendors.filter(v => v.compliance.certifications.length > 0).length;

    const complianceStats = {
      w9Completion: totalVendors > 0 ? (w9Complete / totalVendors) * 100 : 0,
      insuranceCompletion: totalVendors > 0 ? (insuranceComplete / totalVendors) * 100 : 0,
      certificationCompletion: totalVendors > 0 ? (certificationComplete / totalVendors) * 100 : 0,
      overallComplianceRate: totalVendors > 0 ?
        ((w9Complete + insuranceComplete + certificationComplete) / (totalVendors * 3)) * 100 : 0,
    };

    // Recent activity
    const recentVendors = vendors.filter(v => v.metadata.createdAt >= thirtyDaysAgo);
    const recentActivities = this.vendorDirectory.getAllActivities()
      .filter(a => a.timestamp >= thirtyDaysAgo);

    const recentActivity = {
      newRegistrations: recentVendors.length,
      completedOnboardings: recentVendors.filter(v => v.onboardingStatus.stage === 'active').length,
      documentsSubmitted: recentActivities.filter(a => a.type === 'document_upload').length,
      approvalsPending: vendors.filter(v => v.onboardingStatus.stage === 'compliance_review').length,
    };

    return {
      summary: {
        totalVendors,
        activeVendors,
        pendingApproval,
        recentlyOnboarded,
        averageOnboardingTime: avgOnboardingTime,
        completionRate,
      },
      byStage,
      byIndustry,
      complianceStats,
      recentActivity,
    };
  }
}
