import * as express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { SupplierCentralService } from '../services/SupplierCentralService';
import type { CreateVendorProfileInput } from '../types/supplierCentral';
import { resolveActor } from '../services/governance/resolveActor';
import { extractIdentityContext } from '../services/governance/identityContext';

type VendorCertification = CreateVendorProfileInput['compliance']['certifications'][number];

const router = express.Router();

// Vendor Profile Management Routes
router.post('/vendors', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const profileData = req.body ?? {};
  // Only attribute on a plain-object body. resolveActor returns the authenticated
  // userId when authed, the trimmed body string pre-auth, or undefined for a
  // missing/malformed (non-string) pre-auth value — so a spoofed object/number
  // actor is sanitized to undefined rather than persisting via VendorDirectory's
  // spread. A non-object body (primitive/array) carries no createdBy to spoof and
  // is forwarded unchanged (avoids a 500 from assigning a property on a primitive;
  // the service rejects malformed shapes).
  if (profileData && typeof profileData === 'object' && !Array.isArray(profileData)) {
    profileData.createdBy = resolveActor(req, profileData.createdBy);
  }
  const vendorId = await supplierService.createVendorProfile(tenantId, profileData);
  res.status(201).json({ vendorId });
}));

router.get('/vendors', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const {
    stage,
    industry,
    companySize,
    source,
    createdAfter,
    createdBefore,
    search,
    limit = '50',
    offset = '0'
  } = req.query;

  const filters: Record<string, unknown> = {
    limit: parseInt(limit as string, 10),
    offset: parseInt(offset as string, 10),
  };

  if (stage) {
    filters.stage = Array.isArray(stage) ? stage : [stage];
  }

  if (industry) {
    filters.industry = Array.isArray(industry) ? industry : [industry];
  }

  if (companySize) {
    filters.companySize = Array.isArray(companySize) ? companySize : [companySize];
  }

  if (source) {
    filters.source = Array.isArray(source) ? source : [source];
  }

  if (createdAfter) {
    filters.createdAfter = parseInt(createdAfter as string, 10);
  }

  if (createdBefore) {
    filters.createdBefore = parseInt(createdBefore as string, 10);
  }

  if (search) {
    filters.search = search as string;
  }

  const result = await supplierService.getVendorProfiles(tenantId, filters);
  res.json(result);
}));

router.get('/vendors/:vendorId', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorId } = req.params;

  if (!vendorId) {
    res.status(400).json({ error: 'Vendor ID is required' });
    return;
  }

  const vendor = await supplierService.getVendorProfile(tenantId, vendorId);
  if (!vendor) {
    res.status(404).json({ error: 'Vendor not found' });
    return;
  }

  res.json(vendor);
}));

router.put('/vendors/:vendorId', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorId } = req.params;

  if (!vendorId) {
    res.status(400).json({ error: 'Vendor ID is required' });
    return;
  }

  await supplierService.updateVendorProfile(tenantId, vendorId, req.body);
  res.json({ success: true });
}));

// Document Upload Routes
router.post('/vendors/:vendorId/documents', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorId } = req.params;
  const { documentType, fileName, fileSize, mimeType, content, expirationDate, metadata } = req.body;

  if (!vendorId) {
    res.status(400).json({ error: 'Vendor ID is required' });
    return;
  }

  if (!documentType || !fileName) {
    res.status(400).json({ error: 'Document type and file name are required' });
    return;
  }

  const result = await supplierService.uploadDocument(tenantId, vendorId, documentType, {
    fileName,
    fileSize: fileSize || 0,
    mimeType: mimeType || 'application/octet-stream',
    content,
    expirationDate,
    metadata,
  });

  res.status(201).json(result);
}));

// Document Parsing Route (re-parse or preview)
router.post('/documents/:documentId/parse', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { documentId } = req.params;
  const { fileName, mimeType, content, expectedType, vendorContext } = req.body;

  if (!documentId) {
    res.status(400).json({ error: 'Document ID is required' });
    return;
  }

  if (!fileName || !content) {
    res.status(400).json({ error: 'File name and content are required' });
    return;
  }

  const result = await supplierService.parseDocument(
    tenantId,
    documentId,
    {
      fileName,
      mimeType: mimeType || 'application/octet-stream',
      content,
      expectedType,
    },
    vendorContext
  );

  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.json({
    documentId,
    parsing: result.parsing,
    timestamp: Date.now(),
  });
}));

// Vendor Approval Routes
router.post('/vendors/:vendorId/approve', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorId } = req.params;
  const body = req.body ?? {};
  const { notes } = body;
  const approvedBy = resolveActor(req, body.approvedBy);

  if (!vendorId) {
    res.status(400).json({ error: 'Vendor ID is required' });
    return;
  }

  if (!approvedBy) {
    res.status(400).json({ error: 'Approved by is required' });
    return;
  }

  await supplierService.approveVendor(tenantId, vendorId, approvedBy, notes);
  res.json({ success: true });
}));

router.post('/vendors/:vendorId/reject', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorId } = req.params;
  const body = req.body ?? {};
  const { reason } = body;
  const rejectedBy = resolveActor(req, body.rejectedBy);

  if (!vendorId) {
    res.status(400).json({ error: 'Vendor ID is required' });
    return;
  }

  if (!rejectedBy || !reason) {
    res.status(400).json({ error: 'Rejected by and reason are required' });
    return;
  }

  await supplierService.rejectVendor(tenantId, vendorId, rejectedBy, reason);
  res.json({ success: true });
}));

// AI-powered vendor assessment
router.get('/vendors/:vendorId/ai-assessment', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorId } = req.params;

  if (!vendorId) {
    res.status(400).json({ error: 'Vendor ID is required' });
    return;
  }

  // Check if vendor exists
  const vendor = await supplierService.getVendorProfile(tenantId, vendorId);
  if (!vendor) {
    res.status(404).json({ error: 'Vendor not found' });
    return;
  }

  // Check if there's a recent AI assessment in metadata
  const existingAssessment = vendor.metadata.customFields?.aiAssessment as
    | { assessedAt: number; [key: string]: unknown }
    | undefined;
  if (existingAssessment) {
    const assessedAt = existingAssessment.assessedAt;
    const hoursSinceAssessment = (Date.now() - assessedAt) / (1000 * 60 * 60);

    // Return cached assessment if less than 24 hours old
    if (hoursSinceAssessment < 24) {
      res.json({
        vendorId,
        vendorName: vendor.basicInfo.companyName,
        assessment: existingAssessment,
        cached: true,
        cachedAt: assessedAt,
        expiresIn: Math.round(24 - hoursSinceAssessment) + ' hours',
      });
      return;
    }
  }

  // Run fresh AI assessment
  const result = await supplierService.assessVendorForApproval(tenantId, vendorId);

  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({
    vendorId: result.vendorId,
    vendorName: vendor.basicInfo.companyName,
    assessment: result.assessment,
    cached: false,
    timestamp: Date.now(),
  });
}));

// Run AI recommendation for vendor approval
router.post('/vendors/:vendorId/ai-recommend', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorId } = req.params;
  // Note: forceRefresh could be added later to bypass cached assessments

  if (!vendorId) {
    res.status(400).json({ error: 'Vendor ID is required' });
    return;
  }

  // Check if vendor exists
  const vendor = await supplierService.getVendorProfile(tenantId, vendorId);
  if (!vendor) {
    res.status(404).json({ error: 'Vendor not found' });
    return;
  }

  // Run AI assessment
  const result = await supplierService.assessVendorForApproval(tenantId, vendorId);

  if (result.error) {
    res.status(400).json({
      vendorId,
      error: result.error,
      fallbackRecommendation: {
        recommend: 'review',
        confidence: 0,
        reasoning: 'AI assessment unavailable, manual review required',
      }
    });
    return;
  }

  const assessment = result.assessment;

  res.json({
    vendorId: result.vendorId,
    vendorName: vendor.basicInfo.companyName,
    currentStage: vendor.onboardingStatus.stage,
    recommendation: assessment?.approvalRecommendation || null,
    riskAssessment: assessment?.riskAssessment ? {
      overallRisk: assessment.riskAssessment.overallRisk,
      riskScore: assessment.riskAssessment.riskScore,
      topRiskFactors: assessment.riskAssessment.riskFactors.slice(0, 3),
    } : null,
    complianceStatus: assessment?.complianceChecklist ? {
      overallStatus: assessment.complianceChecklist.overallStatus,
      completionPercentage: assessment.complianceChecklist.completionPercentage,
      nextSteps: assessment.complianceChecklist.nextSteps.slice(0, 3),
    } : null,
    suggestedActions: assessment?.actions.slice(0, 5) || [],
    timestamp: Date.now(),
  });
}));

// Business Central Sync Routes
router.post('/vendors/:vendorId/sync', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorId } = req.params;

  if (!vendorId) {
    res.status(400).json({ error: 'Vendor ID is required' });
    return;
  }

  const result = await supplierService.syncVendorToBusinessCentral(tenantId, vendorId);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
}));

// Statistics and Analytics Routes
router.get('/analytics/onboarding', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const stats = await supplierService.getOnboardingStats(tenantId);
  res.json(stats);
}));

// Portal Activity Routes
router.get('/activity', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorId, limit = '50', offset = '0' } = req.query;

  const result = await supplierService.getPortalActivity(
    tenantId,
    vendorId as string | undefined,
    parseInt(limit as string, 10),
    parseInt(offset as string, 10)
  );
  
  res.json(result);
}));

// Dashboard Routes
router.get('/dashboard', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);

  // Get onboarding statistics
  const stats = await supplierService.getOnboardingStats(tenantId);

  // Get recent vendors
  const recentVendors = await supplierService.getVendorProfiles(tenantId, {
    limit: 10,
    createdAfter: Date.now() - (7 * 24 * 60 * 60 * 1000), // Last 7 days
  });

  // Get vendors pending approval
  const pendingApproval = await supplierService.getVendorProfiles(tenantId, {
    stage: ['compliance_review', 'documents_pending'],
    limit: 20,
  });

  // Get recent activity
  const recentActivity = await supplierService.getPortalActivity(tenantId, undefined, 15);

  const dashboard = {
    summary: stats.summary,
    recentVendors: recentVendors.vendors,
    pendingApproval: pendingApproval.vendors,
    stageBreakdown: stats.byStage,
    industryBreakdown: stats.byIndustry.slice(0, 5), // Top 5 industries
    complianceStats: stats.complianceStats,
    recentActivity: recentActivity.activities,
    alerts: [
      // Generate alerts based on data
      ...(stats.summary.pendingApproval > 10 ? [{
        id: 'high_pending_approval',
        type: 'warning',
        message: `${stats.summary.pendingApproval} vendors pending approval`,
        severity: 'medium',
        timestamp: Date.now(),
      }] : []),
      ...(stats.complianceStats.overallComplianceRate < 80 ? [{
        id: 'low_compliance_rate',
        type: 'alert',
        message: `Overall compliance rate is ${stats.complianceStats.overallComplianceRate.toFixed(1)}% (below 80% threshold)`,
        severity: 'high',
        timestamp: Date.now(),
      }] : []),
      ...(stats.summary.averageOnboardingTime > 14 ? [{
        id: 'slow_onboarding',
        type: 'warning',
        message: `Average onboarding time is ${stats.summary.averageOnboardingTime.toFixed(1)} days (above 14 day target)`,
        severity: 'medium',
        timestamp: Date.now(),
      }] : []),
    ],
    lastUpdated: Date.now(),
  };

  res.json(dashboard);
}));

// Health Check Route
router.get('/health', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const stats = await supplierService.getOnboardingStats(tenantId);
  
  const health = {
    status: stats.complianceStats.overallComplianceRate >= 80 && stats.summary.averageOnboardingTime <= 14 ? 'healthy' :
            stats.complianceStats.overallComplianceRate >= 60 && stats.summary.averageOnboardingTime <= 21 ? 'degraded' : 'critical',
    metrics: {
      totalVendors: stats.summary.totalVendors,
      activeVendors: stats.summary.activeVendors,
      pendingApproval: stats.summary.pendingApproval,
      completionRate: stats.summary.completionRate,
      averageOnboardingTime: stats.summary.averageOnboardingTime,
      complianceRate: stats.complianceStats.overallComplianceRate,
    },
    timestamp: Date.now(),
  };

  res.json(health);
}));

// Bulk Operations Routes
router.post('/vendors/bulk-approve', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const body = req.body ?? {};
  const { vendorIds, notes } = body;
  const approvedBy = resolveActor(req, body.approvedBy);

  if (!Array.isArray(vendorIds) || vendorIds.length === 0) {
    res.status(400).json({ error: 'Vendor IDs array is required' });
    return;
  }

  if (!approvedBy) {
    res.status(400).json({ error: 'Approved by is required' });
    return;
  }

  const results = {
    successful: [] as string[],
    failed: [] as { vendorId: string; error: string }[],
  };

  for (const vendorId of vendorIds) {
    try {
      await supplierService.approveVendor(tenantId, vendorId, approvedBy, notes);
      results.successful.push(vendorId);
    } catch (error) {
      results.failed.push({
        vendorId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  res.json({
    total: vendorIds.length,
    successful: results.successful.length,
    failed: results.failed.length,
    results,
  });
}));

router.post('/vendors/bulk-sync', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorIds } = req.body;
  
  if (!Array.isArray(vendorIds) || vendorIds.length === 0) {
    res.status(400).json({ error: 'Vendor IDs array is required' });
    return;
  }

  const results = {
    successful: [] as { vendorId: string; bcVendorId: string }[],
    failed: [] as { vendorId: string; error: string }[],
  };

  for (const vendorId of vendorIds) {
    try {
      const result = await supplierService.syncVendorToBusinessCentral(tenantId, vendorId);
      if (result.success && result.bcVendorId) {
        results.successful.push({
          vendorId,
          bcVendorId: result.bcVendorId,
        });
      } else {
        results.failed.push({
          vendorId,
          error: result.error || 'Unknown error',
        });
      }
    } catch (error) {
      results.failed.push({
        vendorId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  res.json({
    total: vendorIds.length,
    successful: results.successful.length,
    failed: results.failed.length,
    results,
  });
}));

// Export Routes
router.get('/export/vendors', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const {
    stage,
    industry,
    format = 'json'
  } = req.query;

  const filters: Record<string, unknown> = {};

  if (stage) {
    filters.stage = Array.isArray(stage) ? stage : [stage];
  }

  if (industry) {
    filters.industry = Array.isArray(industry) ? industry : [industry];
  }

  // Get all vendors matching filters (remove limit for export)
  const result = await supplierService.getVendorProfiles(tenantId, {
    ...filters,
    limit: 10000, // Large limit for export
  });

  if (format === 'csv') {
    // Convert to CSV format
    const headers = [
      'Vendor ID', 'Company Name', 'Industry', 'Contact Email', 'Phone',
      'Stage', 'Progress', 'Created At', 'Updated At', 'BC Vendor ID',
      'Sync Status', 'W-9 Status', 'Insurance Status'
    ];
    
    const csvRows = result.vendors.map(v => [
      v.id,
      v.basicInfo.companyName,
      v.basicInfo.industry,
      v.contacts.primary.email,
      v.contacts.primary.phone,
      v.onboardingStatus.stage,
      v.onboardingStatus.progress,
      new Date(v.metadata.createdAt).toISOString(),
      new Date(v.metadata.updatedAt).toISOString(),
      v.businessCentral.vendorId || '',
      v.businessCentral.syncStatus,
      v.compliance.w9Form.status,
      v.compliance.insurance.generalLiability.status
    ]);
    
    const csv = [headers, ...csvRows]
      .map(row => row.map(cell => `"${cell}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="supplier-vendors.csv"');
    res.send(csv);
  } else {
    // JSON format
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="supplier-vendors.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      totalVendors: result.totalCount,
      vendors: result.vendors,
    });
  }
}));

// Public Registration Routes (for vendor self-service portal)
router.post('/public/register', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  
  // Minimal profile creation for self-service registration
  const profileData = {
    basicInfo: req.body.basicInfo,
    contacts: req.body.contacts,
    addresses: req.body.addresses,
    banking: {
      accountName: '',
      accountNumber: '',
      routingNumber: '',
      bankName: '',
      accountType: 'checking' as const,
      currency: 'USD',
    },
    compliance: {
      w9Form: { status: 'pending' as const },
      insurance: {
        generalLiability: { status: 'pending' as const },
        workersComp: { status: 'not_required' as const },
        professionalLiability: { status: 'not_required' as const },
      },
      certifications: [] as VendorCertification[],
    },
    capabilities: req.body.capabilities || {
      services: [],
      specializations: [],
      geographicCoverage: [],
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
      capacity: {},
    },
  };
  
  const vendorId = await supplierService.createVendorProfile(tenantId, profileData);

  res.status(201).json({
    vendorId,
    message: 'Registration successful. Please complete your profile and upload required documents.',
    nextSteps: ['complete_banking_info', 'upload_w9', 'upload_insurance'],
  });
}));

// ==========================================
// Purchase Order Management Routes
// ==========================================

// Get purchase orders for a vendor
router.get('/vendors/:vendorId/purchase-orders', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorId } = req.params;
  const { status, fromDate, toDate, limit = '50', offset = '0' } = req.query;

  if (!vendorId) {
    res.status(400).json({ error: 'Vendor ID is required' });
    return;
  }

  const filters: Record<string, unknown> = {
    limit: parseInt(limit as string, 10),
    offset: parseInt(offset as string, 10),
  };

  if (status) {
    filters.status = status;
  }
  if (fromDate) {
    filters.fromDate = parseInt(fromDate as string, 10);
  }
  if (toDate) {
    filters.toDate = parseInt(toDate as string, 10);
  }

  const result = await supplierService.getPurchaseOrdersForVendor(tenantId, vendorId, filters);
  res.json(result);
}));

// Create a purchase order
router.post('/purchase-orders', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const {
    vendorId,
    vendorName,
    buyerCompany,
    buyerContact,
    requestedDeliveryDate,
    currency,
    notes,
    createdBy,
    shippingAddress,
    lines,
  } = req.body ?? {};

  const normalizeOptionalString = (field: string, value: unknown): string | undefined | null => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      res.status(400).json({ error: `${field} must be a string when provided` });
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const normalizedVendorId = normalizeOptionalString('vendorId', vendorId);
  if (normalizedVendorId === null) return;
  const normalizedVendorName = normalizeOptionalString('vendorName', vendorName);
  if (normalizedVendorName === null) return;

  if (!normalizedVendorId && !normalizedVendorName) {
    res.status(400).json({ error: 'vendorId or vendorName is required' });
    return;
  }

  const normalizedBuyerCompany = normalizeOptionalString('buyerCompany', buyerCompany);
  if (normalizedBuyerCompany === null) return;
  const normalizedBuyerContact = normalizeOptionalString('buyerContact', buyerContact);
  if (normalizedBuyerContact === null) return;
  const normalizedCurrency = normalizeOptionalString('currency', currency);
  if (normalizedCurrency === null) return;
  const normalizedNotes = normalizeOptionalString('notes', notes);
  if (normalizedNotes === null) return;
  const normalizedBodyCreatedBy = normalizeOptionalString('createdBy', createdBy);
  if (normalizedBodyCreatedBy === null) return;
  const normalizedCreatedBy = resolveActor(req, normalizedBodyCreatedBy);

  const normalizedRequestedDeliveryDate = requestedDeliveryDate === undefined
    ? undefined
    : Number(requestedDeliveryDate);
  if (normalizedRequestedDeliveryDate !== undefined && !Number.isFinite(normalizedRequestedDeliveryDate)) {
    res.status(400).json({ error: 'requestedDeliveryDate must be a finite timestamp number' });
    return;
  }

  let normalizedShippingAddress: typeof shippingAddress | undefined = undefined;
  if (shippingAddress !== undefined) {
    if (!shippingAddress || typeof shippingAddress !== 'object' || Array.isArray(shippingAddress)) {
      res.status(400).json({ error: 'shippingAddress must be an object when provided' });
      return;
    }

    const rawAddress = shippingAddress as Record<string, unknown>;
    const normalizedAddress = {
      street1: normalizeOptionalString('shippingAddress.street1', rawAddress.street1),
      street2: normalizeOptionalString('shippingAddress.street2', rawAddress.street2),
      city: normalizeOptionalString('shippingAddress.city', rawAddress.city),
      state: normalizeOptionalString('shippingAddress.state', rawAddress.state),
      postalCode: normalizeOptionalString('shippingAddress.postalCode', rawAddress.postalCode),
      country: normalizeOptionalString('shippingAddress.country', rawAddress.country),
    };

    if (Object.values(normalizedAddress).some(value => value === null)) return;
    normalizedShippingAddress = normalizedAddress;
  }

  let normalizedLines: typeof lines | undefined = undefined;
  if (lines !== undefined) {
    if (!Array.isArray(lines)) {
      res.status(400).json({ error: 'lines must be an array when provided' });
      return;
    }

    const candidateLines = lines.map((line: unknown) => {
      const value = (line || {}) as Record<string, unknown>;
      return {
        itemId: typeof value.itemId === 'string' ? value.itemId : undefined,
        itemName: typeof value.itemName === 'string' ? value.itemName.trim() : '',
        description: typeof value.description === 'string' ? value.description : undefined,
        quantity: Number(value.quantity),
        unitPrice: Number(value.unitPrice),
        expectedShipDate: value.expectedShipDate === undefined ? undefined : Number(value.expectedShipDate),
      };
    });

    const invalidLine = candidateLines.find(
      line =>
        line.itemName.length === 0 ||
        !Number.isFinite(line.quantity) ||
        line.quantity <= 0 ||
        !Number.isFinite(line.unitPrice) ||
        line.unitPrice < 0 ||
        (line.expectedShipDate !== undefined && !Number.isFinite(line.expectedShipDate))
    );
    if (invalidLine) {
      res.status(400).json({
        error: 'lines[] contains invalid values (itemName required, quantity > 0, unitPrice >= 0, expectedShipDate finite when provided)'
      });
      return;
    }

    normalizedLines = candidateLines;
  }

  const po = await supplierService.createPurchaseOrder(tenantId, {
    vendorId: normalizedVendorId,
    vendorName: normalizedVendorName,
    buyerCompany: normalizedBuyerCompany,
    buyerContact: normalizedBuyerContact,
    requestedDeliveryDate: normalizedRequestedDeliveryDate,
    currency: normalizedCurrency,
    notes: normalizedNotes,
    createdBy: normalizedCreatedBy,
    shippingAddress: normalizedShippingAddress,
    lines: normalizedLines,
  });

  res.status(201).json(po);
}));

// Get a single purchase order
router.get('/purchase-orders/:poId', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { poId } = req.params;

  if (!poId) {
    res.status(400).json({ error: 'PO ID is required' });
    return;
  }

  const po = await supplierService.getPurchaseOrder(tenantId, poId);
  if (!po) {
    res.status(404).json({ error: 'Purchase order not found' });
    return;
  }

  res.json(po);
}));

// Acknowledge a purchase order
router.post('/purchase-orders/:poId/acknowledge', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { poId } = req.params;
  const body = req.body ?? {};
  const { notes, lineConfirmations } = body;
  const acknowledgedBy = resolveActor(req, body.acknowledgedBy);

  if (!poId) {
    res.status(400).json({ error: 'PO ID is required' });
    return;
  }

  if (!acknowledgedBy) {
    res.status(400).json({ error: 'Acknowledged by is required' });
    return;
  }

  const po = await supplierService.acknowledgePurchaseOrder(tenantId, poId, {
    acknowledgedBy,
    notes,
    lineConfirmations,
  });

  res.json(po);
}));

// Create an Advanced Shipping Notice
router.post('/purchase-orders/:poId/asn', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { poId } = req.params;
  const { vendorId, carrierName, trackingNumber, shipDate, estimatedDeliveryDate, lines, packingList } = req.body;

  if (!poId) {
    res.status(400).json({ error: 'PO ID is required' });
    return;
  }

  if (!vendorId || !carrierName || !trackingNumber || !shipDate || !estimatedDeliveryDate || !lines) {
    res.status(400).json({ error: 'Missing required fields: vendorId, carrierName, trackingNumber, shipDate, estimatedDeliveryDate, lines' });
    return;
  }

  const asn = await supplierService.createAdvancedShippingNotice(tenantId, {
    purchaseOrderId: poId,
    vendorId,
    carrierName,
    trackingNumber,
    shipDate,
    estimatedDeliveryDate,
    lines,
    packingList,
  });

  res.status(201).json(asn);
}));

// Get ASNs for a vendor
router.get('/vendors/:vendorId/asn', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorId } = req.params;

  if (!vendorId) {
    res.status(400).json({ error: 'Vendor ID is required' });
    return;
  }

  const asns = await supplierService.getAdvancedShippingNoticesForVendor(tenantId, vendorId);
  res.json({ asns, totalCount: asns.length });
}));

// Get ASNs for a purchase order
router.get('/purchase-orders/:poId/asn', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { poId } = req.params;

  if (!poId) {
    res.status(400).json({ error: 'PO ID is required' });
    return;
  }

  const asns = await supplierService.getAdvancedShippingNoticesForPO(tenantId, poId);
  res.json({ asns, totalCount: asns.length });
}));

// Update ASN status
router.patch('/asn/:asnId/status', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { asnId } = req.params;
  const { status, actualDeliveryDate } = req.body;

  if (!asnId) {
    res.status(400).json({ error: 'ASN ID is required' });
    return;
  }

  if (!status) {
    res.status(400).json({ error: 'Status is required' });
    return;
  }

  const asn = await supplierService.updateASNStatus(tenantId, asnId, status, actualDeliveryDate);
  res.json(asn);
}));

// ==================== NETSUITE SYNC ROUTES ====================

// Sync a vendor to NetSuite
router.post('/vendors/:vendorId/sync-netsuite', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorId } = req.params;

  if (!vendorId) {
    res.status(400).json({ error: 'Vendor ID is required' });
    return;
  }

  const result = await supplierService.syncVendorToNetSuite(tenantId, vendorId);
  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.json(result);
}));

// Batch sync vendors to NetSuite
router.post('/netsuite/batch-sync', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { vendorIds } = req.body;

  const result = await supplierService.batchSyncVendorsToNetSuite(tenantId, vendorIds);
  res.json(result);
}));

// Get NetSuite sync status
router.get('/netsuite/sync-status', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const status = await supplierService.getNetSuiteSyncStatus(tenantId);
  res.json(status);
}));

// Sync purchase order to NetSuite
router.post('/purchase-orders/:poId/sync-netsuite', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const { poId } = req.params;

  if (!poId) {
    res.status(400).json({ error: 'PO ID is required' });
    return;
  }

  const result = await supplierService.syncPurchaseOrderToNetSuite(tenantId, poId);
  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.json(result);
}));

// Get governance metrics
router.get('/netsuite/governance', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const metrics = supplierService.getGovernanceMetrics(tenantId);
  res.json(metrics);
}));

// Update governance configuration
router.patch('/netsuite/governance', asyncHandler(async (req, res, next) => {
  const supplierService = container.get<SupplierCentralService>(TYPES.SupplierCentralService);
  const { tenantId } = extractIdentityContext(req);
  const config = req.body;

  supplierService.updateGovernanceConfig(tenantId, config);
  res.json({ success: true, config: supplierService.getGovernanceMetrics(tenantId).config });
}));

export { router as supplierCentralRouter };
