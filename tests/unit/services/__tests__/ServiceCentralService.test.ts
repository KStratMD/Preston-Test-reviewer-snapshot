/**
 * ServiceCentralService Unit Tests
 *
 * Tests for field service management including:
 * - Work order lifecycle
 * - Technician management
 * - Dispatch operations
 * - SLA tracking
 * - Metrics calculations
 */

import 'reflect-metadata';
import { ServiceCentralService } from '../../../../src/services/ServiceCentralService';
import type { Logger } from 'pino';

// Mock logger
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

describe('ServiceCentralService', () => {
  let service: ServiceCentralService;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    service = new ServiceCentralService(mockLogger);
  });

  describe('initialization', () => {
    it('should initialize with demo data', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('ServiceCentralService initialized');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          workOrders: expect.any(Number),
          technicians: expect.any(Number),
          dispatches: expect.any(Number),
          slas: expect.any(Number),
        }),
        'ServiceCentralService demo data initialized'
      );
    });
  });

  describe('Dashboard & Metrics', () => {
    describe('getDashboard', () => {
      it('should return comprehensive dashboard data', async () => {
        const dashboard = await service.getDashboard();

        expect(dashboard).toHaveProperty('summary');
        expect(dashboard).toHaveProperty('metrics');
        expect(dashboard).toHaveProperty('ticketsByPriority');
        expect(dashboard).toHaveProperty('activeDispatches');
        expect(dashboard).toHaveProperty('technicianStatus');
        expect(dashboard).toHaveProperty('recentWorkOrders');
        expect(dashboard).toHaveProperty('slaAtRisk');
      });

      it('should have summary with formatted values', async () => {
        const dashboard = await service.getDashboard();

        expect(dashboard.summary).toHaveProperty('openTickets');
        expect(dashboard.summary).toHaveProperty('dispatchedToday');
        expect(dashboard.summary.firstTimeFixRate).toMatch(/%$/);
        expect(dashboard.summary.avgResolutionTime).toMatch(/hrs$/);
      });
    });

    describe('getMetrics', () => {
      it('should return service metrics', async () => {
        const metrics = await service.getMetrics();

        expect(metrics).toHaveProperty('openTickets');
        expect(metrics).toHaveProperty('assignedTickets');
        expect(metrics).toHaveProperty('inProgressTickets');
        expect(metrics).toHaveProperty('resolvedToday');
        expect(metrics).toHaveProperty('dispatchedToday');
        expect(metrics).toHaveProperty('firstTimeFixRate');
        expect(metrics).toHaveProperty('avgResolutionTimeHours');
        expect(metrics).toHaveProperty('avgResponseTimeHours');
        expect(metrics).toHaveProperty('customerSatisfaction');
        expect(metrics).toHaveProperty('slaComplianceRate');
        expect(metrics).toHaveProperty('technicianUtilization');
      });

      it('should calculate technician utilization', async () => {
        const metrics = await service.getMetrics();

        expect(metrics.technicianUtilization).toBeGreaterThanOrEqual(0);
        expect(metrics.technicianUtilization).toBeLessThanOrEqual(100);
      });
    });

    describe('getTicketsByPriority', () => {
      it('should return ticket counts by priority', async () => {
        const tickets = await service.getTicketsByPriority();

        expect(tickets).toHaveProperty('critical');
        expect(tickets).toHaveProperty('high');
        expect(tickets).toHaveProperty('medium');
        expect(tickets).toHaveProperty('low');
        expect(typeof tickets.critical).toBe('number');
        expect(typeof tickets.high).toBe('number');
        expect(typeof tickets.medium).toBe('number');
        expect(typeof tickets.low).toBe('number');
      });
    });
  });

  describe('Work Order Management', () => {
    describe('getWorkOrders', () => {
      it('should return all work orders', async () => {
        const orders = await service.getWorkOrders();
        expect(orders.length).toBeGreaterThan(0);
      });

      it('should filter by status', async () => {
        const openOrders = await service.getWorkOrders({ status: 'open' });
        openOrders.forEach((order) => {
          expect(order.status).toBe('open');
        });
      });

      it('should filter by priority', async () => {
        const highPriorityOrders = await service.getWorkOrders({ priority: 'high' });
        highPriorityOrders.forEach((order) => {
          expect(order.priority).toBe('high');
        });
      });

      it('should limit results', async () => {
        const orders = await service.getWorkOrders({ limit: 2 });
        expect(orders.length).toBeLessThanOrEqual(2);
      });

      it('should sort by priority and date', async () => {
        const orders = await service.getWorkOrders();
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

        for (let i = 0; i < orders.length - 1; i++) {
          const currentPriority = priorityOrder[orders[i].priority];
          const nextPriority = priorityOrder[orders[i + 1].priority];
          expect(currentPriority).toBeLessThanOrEqual(nextPriority);
        }
      });
    });

    describe('getWorkOrder', () => {
      it('should return a specific work order', async () => {
        const orders = await service.getWorkOrders();
        const order = await service.getWorkOrder(orders[0].id);
        expect(order).not.toBeNull();
        expect(order!.id).toBe(orders[0].id);
      });

      it('should return null for non-existent work order', async () => {
        const order = await service.getWorkOrder('NON-EXISTENT');
        expect(order).toBeNull();
      });
    });

    describe('createWorkOrder', () => {
      it('should create a new work order', async () => {
        const request = {
          customerId: 'CUST-TEST',
          customerName: 'Test Customer',
          title: 'Test Work Order',
          description: 'Test description',
          priority: 'high' as const,
          type: 'repair' as const,
          location: {
            address: '123 Test St',
            city: 'Test City',
            state: 'TS',
            zipCode: '12345',
          },
        };

        const order = await service.createWorkOrder(request);

        expect(order.id).toMatch(/^WO-/);
        expect(order.customerId).toBe('CUST-TEST');
        expect(order.customerName).toBe('Test Customer');
        expect(order.title).toBe('Test Work Order');
        expect(order.status).toBe('open');
        expect(order.priority).toBe('high');
        expect(order.type).toBe('repair');
        expect(order.slaDeadline).toBeDefined();
        expect(order.createdAt).toBeDefined();
      });

      it('should set SLA deadline based on priority', async () => {
        const criticalOrder = await service.createWorkOrder({
          customerId: 'CUST-1',
          customerName: 'Test',
          title: 'Critical',
          description: 'Test',
          priority: 'critical',
          type: 'repair',
          location: { address: '1', city: 'C', state: 'S', zipCode: '1' },
        });

        const lowOrder = await service.createWorkOrder({
          customerId: 'CUST-2',
          customerName: 'Test',
          title: 'Low',
          description: 'Test',
          priority: 'low',
          type: 'repair',
          location: { address: '1', city: 'C', state: 'S', zipCode: '1' },
        });

        const criticalDeadline = new Date(criticalOrder.slaDeadline).getTime();
        const lowDeadline = new Date(lowOrder.slaDeadline).getTime();

        // Low priority should have later deadline than critical
        expect(lowDeadline).toBeGreaterThan(criticalDeadline);
      });
    });

    describe('updateWorkOrder', () => {
      it('should update a work order', async () => {
        const orders = await service.getWorkOrders({ status: 'open' });
        const orderId = orders[0].id;

        const updated = await service.updateWorkOrder(orderId, {
          title: 'Updated Title',
          priority: 'critical',
        });

        expect(updated).not.toBeNull();
        expect(updated!.title).toBe('Updated Title');
        expect(updated!.priority).toBe('critical');
      });

      it('should add notes to work order', async () => {
        const orders = await service.getWorkOrders({ status: 'open' });
        const orderId = orders[0].id;
        const originalNotesCount = orders[0].notes.length;

        const updated = await service.updateWorkOrder(orderId, {
          notes: 'New note added',
        });

        expect(updated!.notes.length).toBe(originalNotesCount + 1);
        expect(updated!.notes).toContain('New note added');
      });

      it('should set actualStartTime when status changes to in_progress', async () => {
        const order = await service.createWorkOrder({
          customerId: 'CUST-1',
          customerName: 'Test',
          title: 'Test',
          description: 'Test',
          priority: 'medium',
          type: 'repair',
          location: { address: '1', city: 'C', state: 'S', zipCode: '1' },
        });

        expect(order.actualStartTime).toBeNull();

        const updated = await service.updateWorkOrder(order.id, {
          status: 'in_progress',
        });

        expect(updated!.actualStartTime).not.toBeNull();
      });

      it('should return null for non-existent work order', async () => {
        const result = await service.updateWorkOrder('NON-EXISTENT', { title: 'Test' });
        expect(result).toBeNull();
      });
    });

    describe('completeWorkOrder', () => {
      it('should complete a work order', async () => {
        const order = await service.createWorkOrder({
          customerId: 'CUST-1',
          customerName: 'Test',
          title: 'Test',
          description: 'Test',
          priority: 'medium',
          type: 'repair',
          location: { address: '1', city: 'C', state: 'S', zipCode: '1' },
        });

        const completed = await service.completeWorkOrder(order.id, {
          laborHours: 2.5,
          partsUsed: [{ partId: 'P-1', partName: 'Test Part', quantity: 2, unitCost: 50 }],
          notes: 'Job completed successfully',
          customerSignature: true,
          satisfactionRating: 5,
        });

        expect(completed).not.toBeNull();
        expect(completed!.status).toBe('resolved');
        expect(completed!.laborHours).toBe(2.5);
        expect(completed!.partsUsed.length).toBe(1);
        expect(completed!.customerSignature).toBe(true);
        expect(completed!.satisfactionRating).toBe(5);
        expect(completed!.completedAt).not.toBeNull();
      });

      it('should return null for non-existent work order', async () => {
        const result = await service.completeWorkOrder('NON-EXISTENT', { laborHours: 1 });
        expect(result).toBeNull();
      });
    });

    describe('getRecentWorkOrders', () => {
      it('should return limited recent work orders', async () => {
        const recent = await service.getRecentWorkOrders(3);
        expect(recent.length).toBeLessThanOrEqual(3);
      });
    });

    describe('getSLAAtRiskWorkOrders', () => {
      it('should return work orders at risk of SLA breach', async () => {
        const atRisk = await service.getSLAAtRiskWorkOrders();
        expect(Array.isArray(atRisk)).toBe(true);
      });
    });
  });

  describe('Technician Management', () => {
    describe('getTechnicians', () => {
      it('should return all technicians', async () => {
        const techs = await service.getTechnicians();
        expect(techs.length).toBeGreaterThan(0);
      });

      it('should filter by status', async () => {
        const availableTechs = await service.getTechnicians({ status: 'available' });
        availableTechs.forEach((tech) => {
          expect(tech.status).toBe('available');
        });
      });

      it('should filter by skill', async () => {
        const hvacTechs = await service.getTechnicians({ skill: 'HVAC' });
        hvacTechs.forEach((tech) => {
          expect(tech.skills.some((s) => s.toLowerCase().includes('hvac'))).toBe(true);
        });
      });

      it('should filter available only', async () => {
        const availableTechs = await service.getTechnicians({ available: true });
        availableTechs.forEach((tech) => {
          expect(tech.status).toBe('available');
        });
      });
    });

    describe('getTechnician', () => {
      it('should return a specific technician', async () => {
        const techs = await service.getTechnicians();
        const tech = await service.getTechnician(techs[0].id);
        expect(tech).not.toBeNull();
        expect(tech!.id).toBe(techs[0].id);
      });

      it('should return null for non-existent technician', async () => {
        const tech = await service.getTechnician('NON-EXISTENT');
        expect(tech).toBeNull();
      });
    });

    describe('updateTechnicianStatus', () => {
      it('should update technician status', async () => {
        const techs = await service.getTechnicians({ status: 'available' });
        if (techs.length > 0) {
          const updated = await service.updateTechnicianStatus(techs[0].id, 'break');
          expect(updated).not.toBeNull();
          expect(updated!.status).toBe('break');
        }
      });

      it('should update technician location', async () => {
        const techs = await service.getTechnicians();
        const newLocation = {
          address: '999 New St',
          city: 'New City',
          state: 'NC',
          zipCode: '99999',
        };

        const updated = await service.updateTechnicianStatus(techs[0].id, 'available', newLocation);
        expect(updated!.currentLocation).toEqual(newLocation);
      });

      it('should return null for non-existent technician', async () => {
        const result = await service.updateTechnicianStatus('NON-EXISTENT', 'available');
        expect(result).toBeNull();
      });
    });

    describe('getTechnicianStatusSummary', () => {
      it('should return status summary for all technicians', async () => {
        const summary = await service.getTechnicianStatusSummary();

        expect(summary.length).toBeGreaterThan(0);
        summary.forEach((item) => {
          expect(item).toHaveProperty('id');
          expect(item).toHaveProperty('name');
          expect(item).toHaveProperty('status');
          expect(item).toHaveProperty('currentJob');
          expect(item).toHaveProperty('jobsCompleted');
          expect(item).toHaveProperty('rating');
        });
      });
    });

    describe('getTechnicianSchedule', () => {
      it('should return schedule for a technician', async () => {
        const techs = await service.getTechnicians();
        const today = new Date().toISOString().split('T')[0];
        const schedule = await service.getTechnicianSchedule(techs[0].id, today);

        expect(schedule).not.toBeNull();
        expect(schedule!.technicianId).toBe(techs[0].id);
        expect(schedule!.date).toBe(today);
        expect(schedule!.slots.length).toBe(10); // 8 AM to 6 PM
        expect(schedule!).toHaveProperty('totalScheduledHours');
        expect(schedule!).toHaveProperty('availableHours');
      });

      it('should return null for non-existent technician', async () => {
        const schedule = await service.getTechnicianSchedule('NON-EXISTENT', '2026-01-01');
        expect(schedule).toBeNull();
      });
    });

    describe('findBestTechnician', () => {
      it('should return technician recommendations for a work order', async () => {
        const orders = await service.getWorkOrders({ status: 'open' });
        if (orders.length > 0) {
          const result = await service.findBestTechnician(orders[0].id);

          expect(result).toHaveProperty('recommendations');
          expect(Array.isArray(result.recommendations)).toBe(true);
        }
      });

      it('should score technicians based on multiple factors', async () => {
        const order = await service.createWorkOrder({
          customerId: 'CUST-1',
          customerName: 'Test',
          title: 'HVAC Repair',
          description: 'Need HVAC repair',
          priority: 'high',
          type: 'repair',
          location: { address: '1', city: 'C', state: 'S', zipCode: '1' },
        });

        const result = await service.findBestTechnician(order.id);

        if (result.recommendations.length > 0) {
          result.recommendations.forEach((rec) => {
            expect(rec).toHaveProperty('technician');
            expect(rec).toHaveProperty('score');
            expect(rec).toHaveProperty('reasons');
            expect(rec.score).toBeGreaterThanOrEqual(50);
            expect(Array.isArray(rec.reasons)).toBe(true);
          });
        }
      });

      it('should return empty recommendations for non-existent work order', async () => {
        const result = await service.findBestTechnician('NON-EXISTENT');
        expect(result.recommendations).toEqual([]);
      });
    });
  });

  describe('Dispatch Management', () => {
    describe('dispatchTechnician', () => {
      it('should dispatch a technician to a work order', async () => {
        // Create a fresh work order
        const order = await service.createWorkOrder({
          customerId: 'CUST-1',
          customerName: 'Test',
          title: 'Test Dispatch',
          description: 'Test',
          priority: 'medium',
          type: 'repair',
          location: { address: '1', city: 'C', state: 'S', zipCode: '1' },
        });

        // Get an available technician
        const techs = await service.getTechnicians({ available: true });
        if (techs.length > 0) {
          const result = await service.dispatchTechnician({
            workOrderId: order.id,
            technicianId: techs[0].id,
            notes: 'Test dispatch',
          });

          expect(result.success).toBe(true);
          expect(result.dispatch).toBeDefined();
          expect(result.dispatch!.workOrderId).toBe(order.id);
          expect(result.dispatch!.technicianId).toBe(techs[0].id);
          expect(result.dispatch!.status).toBe('pending');
        }
      });

      it('should fail for non-existent work order', async () => {
        const techs = await service.getTechnicians({ available: true });
        if (techs.length > 0) {
          const result = await service.dispatchTechnician({
            workOrderId: 'NON-EXISTENT',
            technicianId: techs[0].id,
          });

          expect(result.success).toBe(false);
          expect(result.error).toBe('Work order not found');
        }
      });

      it('should fail for non-existent technician', async () => {
        const orders = await service.getWorkOrders({ status: 'open' });
        if (orders.length > 0) {
          const result = await service.dispatchTechnician({
            workOrderId: orders[0].id,
            technicianId: 'NON-EXISTENT',
          });

          expect(result.success).toBe(false);
          expect(result.error).toBe('Technician not found');
        }
      });

      it('should fail for unavailable technician', async () => {
        const order = await service.createWorkOrder({
          customerId: 'CUST-1',
          customerName: 'Test',
          title: 'Test',
          description: 'Test',
          priority: 'medium',
          type: 'repair',
          location: { address: '1', city: 'C', state: 'S', zipCode: '1' },
        });

        // Get a busy technician
        const techs = await service.getTechnicians({ status: 'on_job' });
        if (techs.length > 0) {
          const result = await service.dispatchTechnician({
            workOrderId: order.id,
            technicianId: techs[0].id,
          });

          expect(result.success).toBe(false);
          expect(result.error).toBe('Technician is not available');
        }
      });

      it('should update work order status to assigned after dispatch', async () => {
        const order = await service.createWorkOrder({
          customerId: 'CUST-1',
          customerName: 'Test',
          title: 'Test',
          description: 'Test',
          priority: 'medium',
          type: 'repair',
          location: { address: '1', city: 'C', state: 'S', zipCode: '1' },
        });

        const techs = await service.getTechnicians({ available: true });
        if (techs.length > 0) {
          await service.dispatchTechnician({
            workOrderId: order.id,
            technicianId: techs[0].id,
          });

          const updatedOrder = await service.getWorkOrder(order.id);
          expect(updatedOrder!.status).toBe('assigned');
          expect(updatedOrder!.assignedTechnicianId).toBe(techs[0].id);
        }
      });
    });

    describe('updateDispatchStatus', () => {
      it('should update dispatch status', async () => {
        const dispatches = await service.getActiveDispatches();
        if (dispatches.length > 0) {
          const updated = await service.updateDispatchStatus(dispatches[0].id, 'arrived');
          expect(updated).not.toBeNull();
          expect(updated!.status).toBe('arrived');
          expect(updated!.actualArrival).not.toBeNull();
        }
      });

      it('should return null for non-existent dispatch', async () => {
        const result = await service.updateDispatchStatus('NON-EXISTENT', 'arrived');
        expect(result).toBeNull();
      });
    });

    describe('getActiveDispatches', () => {
      it('should return active dispatches', async () => {
        const dispatches = await service.getActiveDispatches();
        expect(Array.isArray(dispatches)).toBe(true);

        dispatches.forEach((dispatch) => {
          expect(['pending', 'en_route', 'arrived', 'working']).toContain(dispatch.status);
        });
      });
    });

    describe('getDispatchHistory', () => {
      it('should return dispatch history for a work order', async () => {
        const orders = await service.getWorkOrders();
        const history = await service.getDispatchHistory(orders[0].id);
        expect(Array.isArray(history)).toBe(true);
      });
    });
  });

  describe('SLA Management', () => {
    describe('getSLAs', () => {
      it('should return all SLA definitions', async () => {
        const slas = await service.getSLAs();

        expect(slas.length).toBeGreaterThan(0);
        slas.forEach((sla) => {
          expect(sla).toHaveProperty('id');
          expect(sla).toHaveProperty('name');
          expect(sla).toHaveProperty('priority');
          expect(sla).toHaveProperty('responseTimeHours');
          expect(sla).toHaveProperty('resolutionTimeHours');
          expect(sla).toHaveProperty('description');
        });
      });
    });

    describe('getSLAComplianceReport', () => {
      it('should return SLA compliance report', async () => {
        const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const endDate = new Date().toISOString().split('T')[0];

        const report = await service.getSLAComplianceReport(startDate, endDate);

        expect(report).toHaveProperty('totalTickets');
        expect(report).toHaveProperty('compliantTickets');
        expect(report).toHaveProperty('breachedTickets');
        expect(report).toHaveProperty('complianceRate');
        expect(report).toHaveProperty('byPriority');
      });

      it('should have byPriority breakdown', async () => {
        const report = await service.getSLAComplianceReport('2020-01-01', '2030-01-01');

        expect(report.byPriority).toHaveProperty('critical');
        expect(report.byPriority).toHaveProperty('high');
        expect(report.byPriority).toHaveProperty('medium');
        expect(report.byPriority).toHaveProperty('low');

        Object.values(report.byPriority).forEach((item) => {
          expect(item).toHaveProperty('total');
          expect(item).toHaveProperty('compliant');
          expect(item).toHaveProperty('rate');
        });
      });

      it('should calculate compliance rate correctly', async () => {
        const report = await service.getSLAComplianceReport('2020-01-01', '2030-01-01');

        expect(report.complianceRate).toBeGreaterThanOrEqual(0);
        expect(report.complianceRate).toBeLessThanOrEqual(100);

        if (report.totalTickets > 0) {
          expect(report.compliantTickets + report.breachedTickets).toBe(report.totalTickets);
        }
      });
    });
  });
});
