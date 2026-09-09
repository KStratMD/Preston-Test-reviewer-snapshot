/**
 * QualityCentralService - Quality Control Management
 *
 * Provides comprehensive quality control including:
 * - Inspection management
 * - Quality testing and results
 * - Hold and release workflows
 * - Defect tracking
 * - Certificate of Analysis (COA)
 * - Quality metrics and analytics
 *
 * @module services/QualityCentralService
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from 'pino';

// ============================================================================
// Interfaces
// ============================================================================

export interface Inspection {
  id: string;
  itemId: string;
  itemName: string;
  itemType: 'product' | 'component' | 'raw_material' | 'batch';
  batchNumber?: string;
  lotNumber?: string;
  status: 'pending' | 'in_progress' | 'passed' | 'failed' | 'on_hold';
  inspectorId: string;
  inspectorName: string;
  inspectionType: 'incoming' | 'in_process' | 'final' | 'receiving';
  checklistId: string;
  checklistResults: ChecklistResult[];
  defects: Defect[];
  overallScore: number;
  notes: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistResult {
  checkpointId: string;
  checkpointName: string;
  category: string;
  expectedValue: string;
  actualValue: string;
  tolerance?: string;
  passed: boolean;
  notes?: string;
}

export interface Defect {
  id: string;
  inspectionId: string;
  type: 'critical' | 'major' | 'minor' | 'cosmetic';
  category: string;
  description: string;
  location?: string;
  imageUrl?: string;
  status: 'open' | 'under_review' | 'resolved' | 'accepted';
  resolution?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface HoldItem {
  id: string;
  itemId: string;
  itemName: string;
  itemType: string;
  batchNumber?: string;
  quantity: number;
  unit: string;
  reason: string;
  holdType: 'quality' | 'documentation' | 'regulatory' | 'customer';
  status: 'on_hold' | 'pending_release' | 'released' | 'rejected';
  inspectionId?: string;
  createdBy: string;
  createdAt: string;
  releasedAt?: string;
  releasedBy?: string;
  releaseNotes?: string;
  daysOnHold: number;
}

export interface QualityChecklist {
  id: string;
  name: string;
  description: string;
  itemType: string;
  version: string;
  checkpoints: Checkpoint[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Checkpoint {
  id: string;
  name: string;
  category: string;
  description: string;
  expectedValue: string;
  tolerance?: string;
  isCritical: boolean;
  measurementType: 'visual' | 'dimensional' | 'functional' | 'documentation';
  unit?: string;
}

export interface COA {
  id: string;
  itemId: string;
  itemName: string;
  batchNumber: string;
  lotNumber?: string;
  supplierId?: string;
  supplierName?: string;
  status: 'pending' | 'verified' | 'rejected';
  testResults: COATestResult[];
  certificationDate: string;
  expirationDate?: string;
  documentUrl?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  notes?: string;
  createdAt: string;
}

export interface COATestResult {
  testName: string;
  specification: string;
  result: string;
  passed: boolean;
  unit?: string;
}

export interface QualityMetrics {
  inspectionsToday: number;
  passRate: number;
  itemsOnHold: number;
  pendingRelease: number;
  totalInspections: number;
  passedInspections: number;
  failedInspections: number;
  releasedToday: number;
  avgInspectionTimeMinutes: number;
  qualityScore: number;
  criticalDefects: number;
  majorDefects: number;
  minorDefects: number;
  defectRate: number;
  coaVerificationRate: number;
}

export interface QualityCentralDashboard {
  summary: {
    inspectionsToday: number;
    passRate: string;
    itemsOnHold: number;
    pendingRelease: number;
  };
  metrics: QualityMetrics;
  recentInspections: Inspection[];
  holdQueue: HoldItem[];
  criticalDefects: Defect[];
  pendingCOAs: COA[];
  lastUpdated: number;
}

export interface InspectionCreateRequest {
  itemId: string;
  itemName: string;
  itemType: Inspection['itemType'];
  batchNumber?: string;
  lotNumber?: string;
  inspectorId: string;
  inspectorName: string;
  inspectionType: Inspection['inspectionType'];
  checklistId: string;
}

export interface InspectionResultRequest {
  checklistResults: ChecklistResult[];
  defects?: {
    type: Defect['type'];
    category: string;
    description: string;
    location?: string;
  }[];
  notes?: string;
}

// ============================================================================
// Service Implementation
// ============================================================================

@injectable()
export class QualityCentralService {
  private inspections = new Map<string, Inspection>();
  private defects = new Map<string, Defect>();
  private holdItems = new Map<string, HoldItem>();
  private checklists = new Map<string, QualityChecklist>();
  private coas = new Map<string, COA>();

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger
  ) {
    this.logger.info('QualityCentralService initialized');
    this.initializeDemoData();
  }

  // ==========================================================================
  // Dashboard & Metrics
  // ==========================================================================

  /**
   * Get comprehensive quality dashboard data
   */
  public async getDashboard(): Promise<QualityCentralDashboard> {
    this.logger.info('Fetching quality central dashboard');

    const metrics = await this.getMetrics();
    const recentInspections = await this.getRecentInspections(5);
    const holdQueue = await this.getHoldQueue();
    const criticalDefects = await this.getCriticalDefects();
    const pendingCOAs = await this.getPendingCOAs();

    return {
      summary: {
        inspectionsToday: metrics.inspectionsToday,
        passRate: `${metrics.passRate}%`,
        itemsOnHold: metrics.itemsOnHold,
        pendingRelease: metrics.pendingRelease,
      },
      metrics,
      recentInspections,
      holdQueue,
      criticalDefects,
      pendingCOAs,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Get quality metrics
   */
  public async getMetrics(): Promise<QualityMetrics> {
    const inspections = Array.from(this.inspections.values());
    const defects = Array.from(this.defects.values());
    const holds = Array.from(this.holdItems.values());
    const coas = Array.from(this.coas.values());

    const today = new Date().toISOString().split('T')[0];
    const inspectionsToday = inspections.filter(
      (i) => i.createdAt.startsWith(today)
    ).length;

    const completedInspections = inspections.filter(
      (i) => i.status === 'passed' || i.status === 'failed'
    );
    const passedInspections = inspections.filter((i) => i.status === 'passed').length;
    const failedInspections = inspections.filter((i) => i.status === 'failed').length;

    const passRate = completedInspections.length > 0
      ? Math.round((passedInspections / completedInspections.length) * 1000) / 10
      : 0;

    const itemsOnHold = holds.filter((h) => h.status === 'on_hold').length;
    const pendingRelease = holds.filter((h) => h.status === 'pending_release').length;

    const releasedToday = holds.filter(
      (h) => h.releasedAt && h.releasedAt.startsWith(today)
    ).length;

    // Average inspection time (for completed)
    const completedWithTime = completedInspections.filter(
      (i) => i.startedAt && i.completedAt
    );
    const totalMinutes = completedWithTime.reduce((sum, i) => {
      const start = new Date(i.startedAt!).getTime();
      const end = new Date(i.completedAt!).getTime();
      return sum + (end - start) / (1000 * 60);
    }, 0);
    const avgInspectionTimeMinutes = completedWithTime.length > 0
      ? Math.round((totalMinutes / completedWithTime.length) * 10) / 10
      : 0;

    // Quality score (weighted average of pass rate and defect rate)
    const totalDefects = defects.length;
    const totalItems = completedInspections.length;
    const defectRate = totalItems > 0 ? (totalDefects / totalItems) * 100 : 0;
    const qualityScore = Math.max(0, Math.min(100, 100 - defectRate + passRate / 10));

    const criticalDefects = defects.filter((d) => d.type === 'critical' && d.status === 'open').length;
    const majorDefects = defects.filter((d) => d.type === 'major' && d.status === 'open').length;
    const minorDefects = defects.filter((d) => d.type === 'minor' && d.status === 'open').length;

    const verifiedCOAs = coas.filter((c) => c.status === 'verified').length;
    const coaVerificationRate = coas.length > 0
      ? Math.round((verifiedCOAs / coas.length) * 100)
      : 100;

    return {
      inspectionsToday,
      passRate,
      itemsOnHold,
      pendingRelease,
      totalInspections: inspections.length,
      passedInspections,
      failedInspections,
      releasedToday,
      avgInspectionTimeMinutes,
      qualityScore: Math.round(qualityScore * 10) / 10,
      criticalDefects,
      majorDefects,
      minorDefects,
      defectRate: Math.round(defectRate * 10) / 10,
      coaVerificationRate,
    };
  }

  // ==========================================================================
  // Inspection Management
  // ==========================================================================

  /**
   * Get all inspections with optional filtering
   */
  public async getInspections(filters?: {
    status?: Inspection['status'];
    inspectionType?: Inspection['inspectionType'];
    itemType?: Inspection['itemType'];
    inspectorId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<Inspection[]> {
    let inspections = Array.from(this.inspections.values());

    if (filters?.status) {
      inspections = inspections.filter((i) => i.status === filters.status);
    }
    if (filters?.inspectionType) {
      inspections = inspections.filter((i) => i.inspectionType === filters.inspectionType);
    }
    if (filters?.itemType) {
      inspections = inspections.filter((i) => i.itemType === filters.itemType);
    }
    if (filters?.inspectorId) {
      inspections = inspections.filter((i) => i.inspectorId === filters.inspectorId);
    }
    if (filters?.startDate) {
      inspections = inspections.filter((i) => i.createdAt >= filters.startDate!);
    }
    if (filters?.endDate) {
      inspections = inspections.filter((i) => i.createdAt <= filters.endDate!);
    }

    // Sort by creation date descending
    inspections.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    if (filters?.limit) {
      inspections = inspections.slice(0, filters.limit);
    }

    return inspections;
  }

  /**
   * Get inspection by ID
   */
  public async getInspection(id: string): Promise<Inspection | null> {
    return this.inspections.get(id) || null;
  }

  /**
   * Get recent inspections
   */
  public async getRecentInspections(limit = 10): Promise<Inspection[]> {
    return this.getInspections({ limit });
  }

  /**
   * Create a new inspection
   */
  public async createInspection(request: InspectionCreateRequest): Promise<Inspection> {
    const id = `QI-${Date.now()}`;
    const now = new Date().toISOString();

    const inspection: Inspection = {
      id,
      itemId: request.itemId,
      itemName: request.itemName,
      itemType: request.itemType,
      batchNumber: request.batchNumber,
      lotNumber: request.lotNumber,
      status: 'pending',
      inspectorId: request.inspectorId,
      inspectorName: request.inspectorName,
      inspectionType: request.inspectionType,
      checklistId: request.checklistId,
      checklistResults: [],
      defects: [],
      overallScore: 0,
      notes: '',
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.inspections.set(id, inspection);
    this.logger.info({ inspectionId: id }, 'Created inspection');

    return inspection;
  }

  /**
   * Start an inspection
   */
  public async startInspection(id: string): Promise<Inspection | null> {
    const inspection = this.inspections.get(id);
    if (!inspection || inspection.status !== 'pending') {
      return null;
    }

    const now = new Date().toISOString();
    inspection.status = 'in_progress';
    inspection.startedAt = now;
    inspection.updatedAt = now;

    this.inspections.set(id, inspection);
    this.logger.info({ inspectionId: id }, 'Started inspection');

    return inspection;
  }

  /**
   * Submit inspection results
   */
  public async submitInspectionResults(
    id: string,
    results: InspectionResultRequest
  ): Promise<Inspection | null> {
    const inspection = this.inspections.get(id);
    if (!inspection || !['pending', 'in_progress'].includes(inspection.status)) {
      return null;
    }

    const now = new Date().toISOString();

    inspection.checklistResults = results.checklistResults;
    inspection.notes = results.notes || '';

    // Calculate pass/fail based on results
    const failedChecks = results.checklistResults.filter((r) => !r.passed);
    const criticalFailed = failedChecks.some((r) => {
      const checklist = this.checklists.get(inspection.checklistId);
      const checkpoint = checklist?.checkpoints.find((c) => c.id === r.checkpointId);
      return checkpoint?.isCritical;
    });

    // Add defects
    if (results.defects) {
      results.defects.forEach((defectData) => {
        const defectId = `DEF-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 4)}`;
        const defect: Defect = {
          id: defectId,
          inspectionId: id,
          type: defectData.type,
          category: defectData.category,
          description: defectData.description,
          location: defectData.location,
          status: 'open',
          createdAt: now,
        };
        this.defects.set(defectId, defect);
        inspection.defects.push(defect);
      });
    }

    // Determine status
    const hasCriticalDefects = inspection.defects.some((d) => d.type === 'critical');
    if (criticalFailed || hasCriticalDefects) {
      inspection.status = 'failed';
    } else if (failedChecks.length > 0) {
      inspection.status = 'on_hold';
    } else {
      inspection.status = 'passed';
    }

    // Calculate score
    const totalChecks = results.checklistResults.length;
    const passedChecks = results.checklistResults.filter((r) => r.passed).length;
    inspection.overallScore = totalChecks > 0
      ? Math.round((passedChecks / totalChecks) * 100)
      : 0;

    inspection.completedAt = now;
    inspection.updatedAt = now;

    this.inspections.set(id, inspection);
    this.logger.info({ inspectionId: id, status: inspection.status }, 'Submitted inspection results');

    return inspection;
  }

  // ==========================================================================
  // Hold Management
  // ==========================================================================

  /**
   * Get hold queue
   */
  public async getHoldQueue(): Promise<HoldItem[]> {
    const holds = Array.from(this.holdItems.values())
      .filter((h) => h.status === 'on_hold' || h.status === 'pending_release')
      .sort((a, b) => b.daysOnHold - a.daysOnHold);

    // Update days on hold
    const now = Date.now();
    holds.forEach((hold) => {
      hold.daysOnHold = Math.floor(
        (now - new Date(hold.createdAt).getTime()) / (24 * 60 * 60 * 1000)
      );
    });

    return holds;
  }

  /**
   * Get hold item by ID
   */
  public async getHoldItem(id: string): Promise<HoldItem | null> {
    return this.holdItems.get(id) || null;
  }

  /**
   * Place item on hold
   */
  public async placeOnHold(request: {
    itemId: string;
    itemName: string;
    itemType: string;
    batchNumber?: string;
    quantity: number;
    unit: string;
    reason: string;
    holdType: HoldItem['holdType'];
    inspectionId?: string;
    createdBy: string;
  }): Promise<HoldItem> {
    const id = `HOLD-${Date.now()}`;
    const now = new Date().toISOString();

    const hold: HoldItem = {
      id,
      itemId: request.itemId,
      itemName: request.itemName,
      itemType: request.itemType,
      batchNumber: request.batchNumber,
      quantity: request.quantity,
      unit: request.unit,
      reason: request.reason,
      holdType: request.holdType,
      status: 'on_hold',
      inspectionId: request.inspectionId,
      createdBy: request.createdBy,
      createdAt: now,
      daysOnHold: 0,
    };

    this.holdItems.set(id, hold);
    this.logger.info({ holdId: id }, 'Item placed on hold');

    return hold;
  }

  /**
   * Request release of held item
   */
  public async requestRelease(id: string): Promise<HoldItem | null> {
    const hold = this.holdItems.get(id);
    if (!hold || hold.status !== 'on_hold') {
      return null;
    }

    hold.status = 'pending_release';
    this.holdItems.set(id, hold);
    this.logger.info({ holdId: id }, 'Release requested');

    return hold;
  }

  /**
   * Release held item
   */
  public async releaseItem(
    id: string,
    releaseData: { releasedBy: string; releaseNotes?: string }
  ): Promise<HoldItem | null> {
    const hold = this.holdItems.get(id);
    if (!hold || !['on_hold', 'pending_release'].includes(hold.status)) {
      return null;
    }

    const now = new Date().toISOString();
    hold.status = 'released';
    hold.releasedAt = now;
    hold.releasedBy = releaseData.releasedBy;
    hold.releaseNotes = releaseData.releaseNotes;

    this.holdItems.set(id, hold);
    this.logger.info({ holdId: id }, 'Item released');

    return hold;
  }

  /**
   * Reject held item
   */
  public async rejectItem(
    id: string,
    rejectionData: { rejectedBy: string; reason: string }
  ): Promise<HoldItem | null> {
    const hold = this.holdItems.get(id);
    if (!hold || !['on_hold', 'pending_release'].includes(hold.status)) {
      return null;
    }

    hold.status = 'rejected';
    hold.releaseNotes = `Rejected by ${rejectionData.rejectedBy}: ${rejectionData.reason}`;

    this.holdItems.set(id, hold);
    this.logger.info({ holdId: id }, 'Item rejected');

    return hold;
  }

  // ==========================================================================
  // Defect Management
  // ==========================================================================

  /**
   * Get all defects with optional filtering
   */
  public async getDefects(filters?: {
    type?: Defect['type'];
    status?: Defect['status'];
    inspectionId?: string;
    limit?: number;
  }): Promise<Defect[]> {
    let defects = Array.from(this.defects.values());

    if (filters?.type) {
      defects = defects.filter((d) => d.type === filters.type);
    }
    if (filters?.status) {
      defects = defects.filter((d) => d.status === filters.status);
    }
    if (filters?.inspectionId) {
      defects = defects.filter((d) => d.inspectionId === filters.inspectionId);
    }

    defects.sort((a, b) => {
      const typeOrder = { critical: 0, major: 1, minor: 2, cosmetic: 3 };
      return typeOrder[a.type] - typeOrder[b.type];
    });

    if (filters?.limit) {
      defects = defects.slice(0, filters.limit);
    }

    return defects;
  }

  /**
   * Get critical defects
   */
  public async getCriticalDefects(): Promise<Defect[]> {
    return this.getDefects({ type: 'critical', status: 'open' });
  }

  /**
   * Resolve a defect
   */
  public async resolveDefect(
    id: string,
    resolution: { resolution: string; status: Defect['status'] }
  ): Promise<Defect | null> {
    const defect = this.defects.get(id);
    if (!defect) {
      return null;
    }

    defect.status = resolution.status;
    defect.resolution = resolution.resolution;
    if (resolution.status === 'resolved') {
      defect.resolvedAt = new Date().toISOString();
    }

    this.defects.set(id, defect);
    this.logger.info({ defectId: id }, 'Defect resolved');

    return defect;
  }

  // ==========================================================================
  // COA Management
  // ==========================================================================

  /**
   * Get all COAs
   */
  public async getCOAs(filters?: {
    status?: COA['status'];
    supplierId?: string;
    limit?: number;
  }): Promise<COA[]> {
    let coas = Array.from(this.coas.values());

    if (filters?.status) {
      coas = coas.filter((c) => c.status === filters.status);
    }
    if (filters?.supplierId) {
      coas = coas.filter((c) => c.supplierId === filters.supplierId);
    }

    coas.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    if (filters?.limit) {
      coas = coas.slice(0, filters.limit);
    }

    return coas;
  }

  /**
   * Get pending COAs
   */
  public async getPendingCOAs(): Promise<COA[]> {
    return this.getCOAs({ status: 'pending' });
  }

  /**
   * Create a COA
   */
  public async createCOA(request: {
    itemId: string;
    itemName: string;
    batchNumber: string;
    lotNumber?: string;
    supplierId?: string;
    supplierName?: string;
    testResults: COATestResult[];
    certificationDate: string;
    expirationDate?: string;
    documentUrl?: string;
  }): Promise<COA> {
    const id = `COA-${Date.now()}`;
    const now = new Date().toISOString();

    const coa: COA = {
      id,
      itemId: request.itemId,
      itemName: request.itemName,
      batchNumber: request.batchNumber,
      lotNumber: request.lotNumber,
      supplierId: request.supplierId,
      supplierName: request.supplierName,
      status: 'pending',
      testResults: request.testResults,
      certificationDate: request.certificationDate,
      expirationDate: request.expirationDate,
      documentUrl: request.documentUrl,
      createdAt: now,
    };

    this.coas.set(id, coa);
    this.logger.info({ coaId: id }, 'Created COA');

    return coa;
  }

  /**
   * Verify a COA
   */
  public async verifyCOA(
    id: string,
    verification: { verifiedBy: string; notes?: string }
  ): Promise<COA | null> {
    const coa = this.coas.get(id);
    if (!coa || coa.status !== 'pending') {
      return null;
    }

    const now = new Date().toISOString();
    coa.status = 'verified';
    coa.verifiedBy = verification.verifiedBy;
    coa.verifiedAt = now;
    coa.notes = verification.notes;

    this.coas.set(id, coa);
    this.logger.info({ coaId: id }, 'COA verified');

    return coa;
  }

  /**
   * Reject a COA
   */
  public async rejectCOA(
    id: string,
    rejection: { rejectedBy: string; reason: string }
  ): Promise<COA | null> {
    const coa = this.coas.get(id);
    if (!coa || coa.status !== 'pending') {
      return null;
    }

    coa.status = 'rejected';
    coa.notes = `Rejected by ${rejection.rejectedBy}: ${rejection.reason}`;

    this.coas.set(id, coa);
    this.logger.info({ coaId: id }, 'COA rejected');

    return coa;
  }

  // ==========================================================================
  // Checklist Management
  // ==========================================================================

  /**
   * Get all checklists
   */
  public async getChecklists(): Promise<QualityChecklist[]> {
    return Array.from(this.checklists.values()).filter((c) => c.isActive);
  }

  /**
   * Get checklist by ID
   */
  public async getChecklist(id: string): Promise<QualityChecklist | null> {
    return this.checklists.get(id) || null;
  }

  // ==========================================================================
  // Demo Data Initialization
  // ==========================================================================

  private initializeDemoData(): void {
    const now = new Date();

    // Create demo checklists
    const checklist1: QualityChecklist = {
      id: 'CL-001',
      name: 'Standard Product Inspection',
      description: 'Standard inspection checklist for finished products',
      itemType: 'product',
      version: '2.0',
      checkpoints: [
        { id: 'CP-001', name: 'Visual Inspection', category: 'Appearance', description: 'Check for visual defects', expectedValue: 'No defects', isCritical: false, measurementType: 'visual' },
        { id: 'CP-002', name: 'Dimensional Check', category: 'Dimensions', description: 'Verify dimensions within spec', expectedValue: 'Within tolerance', tolerance: '±0.5mm', isCritical: true, measurementType: 'dimensional' },
        { id: 'CP-003', name: 'Functional Test', category: 'Function', description: 'Verify functional operation', expectedValue: 'Pass all tests', isCritical: true, measurementType: 'functional' },
        { id: 'CP-004', name: 'Packaging Check', category: 'Packaging', description: 'Verify proper packaging', expectedValue: 'Complete and undamaged', isCritical: false, measurementType: 'visual' },
      ],
      isActive: true,
      createdAt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    this.checklists.set(checklist1.id, checklist1);

    // Create demo inspections
    const inspections: Inspection[] = [
      {
        id: 'QI-2026-001',
        itemId: 'PROD-001',
        itemName: 'Widget Assembly A',
        itemType: 'product',
        batchNumber: 'BATCH-445',
        status: 'passed',
        inspectorId: 'INS-001',
        inspectorName: 'John Smith',
        inspectionType: 'final',
        checklistId: 'CL-001',
        checklistResults: [
          { checkpointId: 'CP-001', checkpointName: 'Visual Inspection', category: 'Appearance', expectedValue: 'No defects', actualValue: 'No defects', passed: true },
          { checkpointId: 'CP-002', checkpointName: 'Dimensional Check', category: 'Dimensions', expectedValue: 'Within tolerance', actualValue: '10.2mm', tolerance: '±0.5mm', passed: true },
        ],
        defects: [],
        overallScore: 100,
        notes: 'All checks passed',
        startedAt: new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString(),
        completedAt: new Date(now.getTime() - 3.5 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 3.5 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 'QI-2026-002',
        itemId: 'COMP-042',
        itemName: 'Component X-42',
        itemType: 'component',
        batchNumber: 'BATCH-446',
        status: 'failed',
        inspectorId: 'INS-002',
        inspectorName: 'Jane Doe',
        inspectionType: 'incoming',
        checklistId: 'CL-001',
        checklistResults: [
          { checkpointId: 'CP-001', checkpointName: 'Visual Inspection', category: 'Appearance', expectedValue: 'No defects', actualValue: 'Surface scratches', passed: false },
          { checkpointId: 'CP-002', checkpointName: 'Dimensional Check', category: 'Dimensions', expectedValue: 'Within tolerance', actualValue: '11.2mm', tolerance: '±0.5mm', passed: false },
        ],
        defects: [],
        overallScore: 50,
        notes: 'Multiple failures detected',
        startedAt: new Date(now.getTime() - 8 * 60 * 60 * 1000).toISOString(),
        completedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date(now.getTime() - 8 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 'QI-2026-003',
        itemId: 'MOD-007',
        itemName: 'Module B-7',
        itemType: 'product',
        status: 'on_hold',
        inspectorId: 'INS-003',
        inspectorName: 'Mike Johnson',
        inspectionType: 'in_process',
        checklistId: 'CL-001',
        checklistResults: [],
        defects: [],
        overallScore: 0,
        notes: 'Pending additional documentation',
        startedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(),
        completedAt: null,
        createdAt: new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 10 * 60 * 60 * 1000).toISOString(),
      },
    ];
    inspections.forEach((i) => this.inspections.set(i.id, i));

    // Create demo defects
    const defect1: Defect = {
      id: 'DEF-001',
      inspectionId: 'QI-2026-002',
      type: 'major',
      category: 'Dimensional',
      description: 'Component exceeds dimensional tolerance',
      location: 'Edge measurement point A',
      status: 'open',
      createdAt: new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString(),
    };
    this.defects.set(defect1.id, defect1);
    inspections[1].defects.push(defect1);

    // Create demo holds
    const holds: HoldItem[] = [
      {
        id: 'HOLD-001',
        itemId: 'RM-445',
        itemName: 'Raw Material Batch 445',
        itemType: 'raw_material',
        batchNumber: 'BATCH-445',
        quantity: 500,
        unit: 'kg',
        reason: 'Pending COA verification',
        holdType: 'documentation',
        status: 'on_hold',
        createdBy: 'system',
        createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        daysOnHold: 2,
      },
      {
        id: 'HOLD-002',
        itemId: 'COMP-019',
        itemName: 'Component Y-19',
        itemType: 'component',
        quantity: 100,
        unit: 'pcs',
        reason: 'Dimensional variance',
        holdType: 'quality',
        status: 'pending_release',
        inspectionId: 'QI-2026-002',
        createdBy: 'INS-002',
        createdAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        daysOnHold: 1,
      },
    ];
    holds.forEach((h) => this.holdItems.set(h.id, h));

    // Create demo COAs
    const coa1: COA = {
      id: 'COA-001',
      itemId: 'RM-445',
      itemName: 'Aluminum Alloy 6061',
      batchNumber: 'BATCH-445',
      supplierId: 'SUP-001',
      supplierName: 'MetalCorp Inc',
      status: 'pending',
      testResults: [
        { testName: 'Tensile Strength', specification: '≥310 MPa', result: '325 MPa', passed: true, unit: 'MPa' },
        { testName: 'Hardness', specification: '95-105 HB', result: '100 HB', passed: true, unit: 'HB' },
        { testName: 'Chemical Composition', specification: 'Per ASTM B209', result: 'Compliant', passed: true },
      ],
      certificationDate: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      expirationDate: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    };
    this.coas.set(coa1.id, coa1);

    this.logger.info(
      {
        inspections: this.inspections.size,
        defects: this.defects.size,
        holdItems: this.holdItems.size,
        checklists: this.checklists.size,
        coas: this.coas.size,
      },
      'QualityCentralService demo data initialized'
    );
  }
}
