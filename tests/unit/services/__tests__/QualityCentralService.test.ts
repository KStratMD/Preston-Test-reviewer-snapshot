/**
 * QualityCentralService Unit Tests
 */

import 'reflect-metadata';
import { QualityCentralService } from '../../../../src/services/QualityCentralService';
import type { Logger } from 'pino';

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Logger>;
}

describe('QualityCentralService', () => {
  let service: QualityCentralService;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    service = new QualityCentralService(mockLogger);
  });

  describe('initialization', () => {
    it('should initialize with demo data', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('QualityCentralService initialized');
    });
  });

  describe('Dashboard & Metrics', () => {
    describe('getDashboard', () => {
      it('should return comprehensive dashboard data', async () => {
        const dashboard = await service.getDashboard();

        expect(dashboard).toHaveProperty('summary');
        expect(dashboard).toHaveProperty('metrics');
        expect(dashboard).toHaveProperty('recentInspections');
        expect(dashboard).toHaveProperty('holdQueue');
        expect(dashboard).toHaveProperty('criticalDefects');
        expect(dashboard).toHaveProperty('pendingCOAs');
        expect(dashboard).toHaveProperty('lastUpdated');
      });

      it('should have valid summary', async () => {
        const dashboard = await service.getDashboard();

        expect(dashboard.summary.inspectionsToday).toBeGreaterThanOrEqual(0);
        expect(dashboard.summary.passRate).toMatch(/%$/);
        expect(dashboard.summary.itemsOnHold).toBeGreaterThanOrEqual(0);
      });
    });

    describe('getMetrics', () => {
      it('should return quality metrics', async () => {
        const metrics = await service.getMetrics();

        expect(metrics).toHaveProperty('inspectionsToday');
        expect(metrics).toHaveProperty('passRate');
        expect(metrics).toHaveProperty('itemsOnHold');
        expect(metrics).toHaveProperty('pendingRelease');
        expect(metrics).toHaveProperty('totalInspections');
        expect(metrics).toHaveProperty('passedInspections');
        expect(metrics).toHaveProperty('failedInspections');
        expect(metrics).toHaveProperty('qualityScore');
        expect(metrics).toHaveProperty('criticalDefects');
        expect(metrics).toHaveProperty('defectRate');
        expect(metrics).toHaveProperty('coaVerificationRate');
      });
    });
  });

  describe('Inspection Management', () => {
    describe('getInspections', () => {
      it('should return inspections', async () => {
        const inspections = await service.getInspections();
        expect(inspections.length).toBeGreaterThan(0);
      });

      it('should filter by status', async () => {
        const inspections = await service.getInspections({ status: 'passed' });
        inspections.forEach((i) => expect(i.status).toBe('passed'));
      });

      it('should limit results', async () => {
        const inspections = await service.getInspections({ limit: 2 });
        expect(inspections.length).toBeLessThanOrEqual(2);
      });
    });

    describe('getInspection', () => {
      it('should return inspection by ID', async () => {
        const inspections = await service.getInspections();
        const inspection = await service.getInspection(inspections[0].id);
        expect(inspection).not.toBeNull();
        expect(inspection!.id).toBe(inspections[0].id);
      });

      it('should return null for non-existent', async () => {
        const inspection = await service.getInspection('NON-EXISTENT');
        expect(inspection).toBeNull();
      });
    });

    describe('createInspection', () => {
      it('should create a new inspection', async () => {
        const inspection = await service.createInspection({
          itemId: 'ITEM-001',
          itemName: 'Test Item',
          itemType: 'product',
          inspectorId: 'INS-001',
          inspectorName: 'Test Inspector',
          inspectionType: 'final',
          checklistId: 'CL-001',
        });

        expect(inspection.id).toMatch(/^QI-/);
        expect(inspection.status).toBe('pending');
        expect(inspection.itemName).toBe('Test Item');
      });
    });

    describe('startInspection', () => {
      it('should start a pending inspection', async () => {
        const created = await service.createInspection({
          itemId: 'ITEM-001',
          itemName: 'Test Item',
          itemType: 'product',
          inspectorId: 'INS-001',
          inspectorName: 'Test Inspector',
          inspectionType: 'final',
          checklistId: 'CL-001',
        });

        const started = await service.startInspection(created.id);
        expect(started).not.toBeNull();
        expect(started!.status).toBe('in_progress');
        expect(started!.startedAt).not.toBeNull();
      });

      it('should return null for non-existent inspection', async () => {
        const result = await service.startInspection('NON-EXISTENT');
        expect(result).toBeNull();
      });
    });

    describe('submitInspectionResults', () => {
      it('should submit results and determine pass/fail', async () => {
        const created = await service.createInspection({
          itemId: 'ITEM-001',
          itemName: 'Test Item',
          itemType: 'product',
          inspectorId: 'INS-001',
          inspectorName: 'Test Inspector',
          inspectionType: 'final',
          checklistId: 'CL-001',
        });

        const result = await service.submitInspectionResults(created.id, {
          checklistResults: [
            { checkpointId: 'CP-001', checkpointName: 'Test', category: 'Test', expectedValue: 'Pass', actualValue: 'Pass', passed: true },
          ],
          notes: 'All good',
        });

        expect(result).not.toBeNull();
        expect(result!.status).toBe('passed');
        expect(result!.overallScore).toBe(100);
        expect(result!.completedAt).not.toBeNull();
      });

      it('should mark as failed when critical checks fail', async () => {
        const created = await service.createInspection({
          itemId: 'ITEM-001',
          itemName: 'Test Item',
          itemType: 'product',
          inspectorId: 'INS-001',
          inspectorName: 'Test Inspector',
          inspectionType: 'final',
          checklistId: 'CL-001',
        });

        const result = await service.submitInspectionResults(created.id, {
          checklistResults: [
            { checkpointId: 'CP-002', checkpointName: 'Dimensional', category: 'Dimensions', expectedValue: 'Within spec', actualValue: 'Out of spec', passed: false },
          ],
          defects: [
            { type: 'critical', category: 'Dimensional', description: 'Out of tolerance' },
          ],
        });

        expect(result!.status).toBe('failed');
      });
    });
  });

  describe('Hold Management', () => {
    describe('getHoldQueue', () => {
      it('should return hold queue', async () => {
        const holds = await service.getHoldQueue();
        expect(Array.isArray(holds)).toBe(true);
      });
    });

    describe('placeOnHold', () => {
      it('should place item on hold', async () => {
        const hold = await service.placeOnHold({
          itemId: 'ITEM-001',
          itemName: 'Test Item',
          itemType: 'product',
          quantity: 100,
          unit: 'pcs',
          reason: 'Test hold',
          holdType: 'quality',
          createdBy: 'test-user',
        });

        expect(hold.id).toMatch(/^HOLD-/);
        expect(hold.status).toBe('on_hold');
        expect(hold.reason).toBe('Test hold');
      });
    });

    describe('requestRelease', () => {
      it('should request release of held item', async () => {
        const hold = await service.placeOnHold({
          itemId: 'ITEM-001',
          itemName: 'Test Item',
          itemType: 'product',
          quantity: 100,
          unit: 'pcs',
          reason: 'Test hold',
          holdType: 'quality',
          createdBy: 'test-user',
        });

        const requested = await service.requestRelease(hold.id);
        expect(requested).not.toBeNull();
        expect(requested!.status).toBe('pending_release');
      });
    });

    describe('releaseItem', () => {
      it('should release held item', async () => {
        const hold = await service.placeOnHold({
          itemId: 'ITEM-001',
          itemName: 'Test Item',
          itemType: 'product',
          quantity: 100,
          unit: 'pcs',
          reason: 'Test hold',
          holdType: 'quality',
          createdBy: 'test-user',
        });

        const released = await service.releaseItem(hold.id, {
          releasedBy: 'releaser',
          releaseNotes: 'Issue resolved',
        });

        expect(released).not.toBeNull();
        expect(released!.status).toBe('released');
        expect(released!.releasedBy).toBe('releaser');
        expect(released!.releasedAt).not.toBeNull();
      });
    });

    describe('rejectItem', () => {
      it('should reject held item', async () => {
        const hold = await service.placeOnHold({
          itemId: 'ITEM-001',
          itemName: 'Test Item',
          itemType: 'product',
          quantity: 100,
          unit: 'pcs',
          reason: 'Test hold',
          holdType: 'quality',
          createdBy: 'test-user',
        });

        const rejected = await service.rejectItem(hold.id, {
          rejectedBy: 'rejecter',
          reason: 'Cannot be salvaged',
        });

        expect(rejected).not.toBeNull();
        expect(rejected!.status).toBe('rejected');
      });
    });
  });

  describe('Defect Management', () => {
    describe('getDefects', () => {
      it('should return defects', async () => {
        const defects = await service.getDefects();
        expect(Array.isArray(defects)).toBe(true);
      });

      it('should filter by type', async () => {
        const defects = await service.getDefects({ type: 'major' });
        defects.forEach((d) => expect(d.type).toBe('major'));
      });
    });

    describe('getCriticalDefects', () => {
      it('should return only critical open defects', async () => {
        const defects = await service.getCriticalDefects();
        defects.forEach((d) => {
          expect(d.type).toBe('critical');
          expect(d.status).toBe('open');
        });
      });
    });

    describe('resolveDefect', () => {
      it('should resolve a defect', async () => {
        const defects = await service.getDefects({ status: 'open' });
        if (defects.length > 0) {
          const resolved = await service.resolveDefect(defects[0].id, {
            resolution: 'Fixed',
            status: 'resolved',
          });

          expect(resolved).not.toBeNull();
          expect(resolved!.status).toBe('resolved');
          expect(resolved!.resolution).toBe('Fixed');
          expect(resolved!.resolvedAt).not.toBeNull();
        }
      });
    });
  });

  describe('COA Management', () => {
    describe('getCOAs', () => {
      it('should return COAs', async () => {
        const coas = await service.getCOAs();
        expect(Array.isArray(coas)).toBe(true);
      });
    });

    describe('getPendingCOAs', () => {
      it('should return only pending COAs', async () => {
        const coas = await service.getPendingCOAs();
        coas.forEach((c) => expect(c.status).toBe('pending'));
      });
    });

    describe('createCOA', () => {
      it('should create a COA', async () => {
        const coa = await service.createCOA({
          itemId: 'ITEM-001',
          itemName: 'Test Material',
          batchNumber: 'BATCH-001',
          testResults: [
            { testName: 'Purity', specification: '≥99%', result: '99.5%', passed: true },
          ],
          certificationDate: new Date().toISOString(),
        });

        expect(coa.id).toMatch(/^COA-/);
        expect(coa.status).toBe('pending');
      });
    });

    describe('verifyCOA', () => {
      it('should verify a COA', async () => {
        const coa = await service.createCOA({
          itemId: 'ITEM-001',
          itemName: 'Test Material',
          batchNumber: 'BATCH-001',
          testResults: [
            { testName: 'Purity', specification: '≥99%', result: '99.5%', passed: true },
          ],
          certificationDate: new Date().toISOString(),
        });

        const verified = await service.verifyCOA(coa.id, {
          verifiedBy: 'verifier',
          notes: 'Confirmed',
        });

        expect(verified).not.toBeNull();
        expect(verified!.status).toBe('verified');
        expect(verified!.verifiedBy).toBe('verifier');
        expect(verified!.verifiedAt).not.toBeNull();
      });
    });

    describe('rejectCOA', () => {
      it('should reject a COA', async () => {
        const coa = await service.createCOA({
          itemId: 'ITEM-001',
          itemName: 'Test Material',
          batchNumber: 'BATCH-001',
          testResults: [
            { testName: 'Purity', specification: '≥99%', result: '98%', passed: false },
          ],
          certificationDate: new Date().toISOString(),
        });

        const rejected = await service.rejectCOA(coa.id, {
          rejectedBy: 'reviewer',
          reason: 'Purity below spec',
        });

        expect(rejected).not.toBeNull();
        expect(rejected!.status).toBe('rejected');
      });
    });
  });

  describe('Checklist Management', () => {
    describe('getChecklists', () => {
      it('should return active checklists', async () => {
        const checklists = await service.getChecklists();
        expect(checklists.length).toBeGreaterThan(0);
        checklists.forEach((c) => expect(c.isActive).toBe(true));
      });
    });

    describe('getChecklist', () => {
      it('should return checklist by ID', async () => {
        const checklists = await service.getChecklists();
        const checklist = await service.getChecklist(checklists[0].id);
        expect(checklist).not.toBeNull();
        expect(checklist!.checkpoints.length).toBeGreaterThan(0);
      });
    });
  });
});
