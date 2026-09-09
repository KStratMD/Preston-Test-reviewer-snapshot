/**
 * ServiceCentralService - Field Service Management
 *
 * Provides comprehensive field service management including:
 * - Work order lifecycle management
 * - Technician dispatch and scheduling
 * - SLA tracking and compliance
 * - Customer satisfaction metrics
 * - Parts and inventory for service
 * - Route optimization
 *
 * @module services/ServiceCentralService
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from 'pino';

// ============================================================================
// Interfaces
// ============================================================================

export interface WorkOrder {
  id: string;
  customerId: string;
  customerName: string;
  title: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'open' | 'assigned' | 'in_progress' | 'on_hold' | 'resolved' | 'closed';
  type: 'installation' | 'repair' | 'maintenance' | 'inspection' | 'warranty';
  assignedTechnicianId: string | null;
  assignedTechnicianName: string | null;
  location: ServiceLocation;
  scheduledDate: string | null;
  scheduledTimeSlot: string | null;
  actualStartTime: string | null;
  actualEndTime: string | null;
  slaDeadline: string;
  slaBreached: boolean;
  partsUsed: PartUsage[];
  laborHours: number;
  notes: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  customerSignature: boolean;
  satisfactionRating: number | null;
}

export interface ServiceLocation {
  address: string;
  city: string;
  state: string;
  zipCode: string;
  latitude?: number;
  longitude?: number;
  accessNotes?: string;
}

export interface PartUsage {
  partId: string;
  partName: string;
  quantity: number;
  unitCost: number;
}

export interface Technician {
  id: string;
  name: string;
  email: string;
  phone: string;
  status: 'available' | 'on_job' | 'traveling' | 'break' | 'off_duty';
  currentLocation?: ServiceLocation;
  skills: string[];
  certifications: string[];
  rating: number;
  completedJobsToday: number;
  completedJobsTotal: number;
  firstTimeFixRate: number;
  averageJobDuration: number; // in minutes
  currentWorkOrderId: string | null;
  scheduledWorkOrders: string[];
  vehicleId: string | null;
}

export interface ServiceDispatch {
  id: string;
  workOrderId: string;
  technicianId: string;
  technicianName: string;
  status: 'pending' | 'en_route' | 'arrived' | 'working' | 'completed' | 'cancelled';
  dispatchedAt: string;
  estimatedArrival: string;
  actualArrival: string | null;
  completedAt: string | null;
  travelDistance: number; // in miles
  travelTime: number; // in minutes
  notes: string;
}

export interface ServiceSLA {
  id: string;
  name: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  responseTimeHours: number;
  resolutionTimeHours: number;
  description: string;
}

export interface ServiceMetrics {
  openTickets: number;
  assignedTickets: number;
  inProgressTickets: number;
  resolvedToday: number;
  dispatchedToday: number;
  firstTimeFixRate: number;
  avgResolutionTimeHours: number;
  avgResponseTimeHours: number;
  customerSatisfaction: number;
  slaComplianceRate: number;
  technicianUtilization: number;
  partsUsedToday: number;
  laborHoursToday: number;
}

export interface TicketsByPriority {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface ServiceCentralDashboard {
  summary: {
    openTickets: number;
    dispatchedToday: number;
    firstTimeFixRate: string;
    avgResolutionTime: string;
  };
  metrics: ServiceMetrics;
  ticketsByPriority: TicketsByPriority;
  activeDispatches: ServiceDispatch[];
  technicianStatus: TechnicianStatusSummary[];
  recentWorkOrders: WorkOrder[];
  slaAtRisk: WorkOrder[];
}

export interface TechnicianStatusSummary {
  id: string;
  name: string;
  status: Technician['status'];
  currentJob: string | null;
  jobsCompleted: number;
  rating: number;
}

export interface DispatchRequest {
  workOrderId: string;
  technicianId: string;
  scheduledDate?: string;
  scheduledTimeSlot?: string;
  notes?: string;
}

export interface WorkOrderCreateRequest {
  customerId: string;
  customerName: string;
  title: string;
  description: string;
  priority: WorkOrder['priority'];
  type: WorkOrder['type'];
  location: ServiceLocation;
  scheduledDate?: string;
  scheduledTimeSlot?: string;
}

export interface WorkOrderUpdateRequest {
  title?: string;
  description?: string;
  priority?: WorkOrder['priority'];
  status?: WorkOrder['status'];
  scheduledDate?: string;
  scheduledTimeSlot?: string;
  notes?: string;
}

export interface TechnicianSchedule {
  technicianId: string;
  technicianName: string;
  date: string;
  slots: ScheduleSlot[];
  totalScheduledHours: number;
  availableHours: number;
}

export interface ScheduleSlot {
  startTime: string;
  endTime: string;
  workOrderId: string | null;
  workOrderTitle: string | null;
  status: 'available' | 'scheduled' | 'in_progress' | 'completed';
}

// ============================================================================
// Service Implementation
// ============================================================================

@injectable()
export class ServiceCentralService {
  private workOrders = new Map<string, WorkOrder>();
  private technicians = new Map<string, Technician>();
  private dispatches = new Map<string, ServiceDispatch>();
  private slas = new Map<string, ServiceSLA>();

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger
  ) {
    this.logger.info('ServiceCentralService initialized');
    this.initializeDemoData();
  }

  // ==========================================================================
  // Dashboard & Metrics
  // ==========================================================================

  /**
   * Get comprehensive service dashboard data
   */
  public async getDashboard(): Promise<ServiceCentralDashboard> {
    this.logger.info('Fetching service central dashboard');

    const metrics = await this.getMetrics();
    const ticketsByPriority = await this.getTicketsByPriority();
    const activeDispatches = await this.getActiveDispatches();
    const technicianStatus = await this.getTechnicianStatusSummary();
    const recentWorkOrders = await this.getRecentWorkOrders(5);
    const slaAtRisk = await this.getSLAAtRiskWorkOrders();

    return {
      summary: {
        openTickets: metrics.openTickets,
        dispatchedToday: metrics.dispatchedToday,
        firstTimeFixRate: `${metrics.firstTimeFixRate}%`,
        avgResolutionTime: `${metrics.avgResolutionTimeHours.toFixed(1)} hrs`,
      },
      metrics,
      ticketsByPriority,
      activeDispatches,
      technicianStatus,
      recentWorkOrders,
      slaAtRisk,
    };
  }

  /**
   * Get service metrics
   */
  public async getMetrics(): Promise<ServiceMetrics> {
    const workOrders = Array.from(this.workOrders.values());
    const technicians = Array.from(this.technicians.values());
    const dispatches = Array.from(this.dispatches.values());

    const today = new Date().toISOString().split('T')[0];

    const openTickets = workOrders.filter((wo) => wo.status === 'open').length;
    const assignedTickets = workOrders.filter((wo) => wo.status === 'assigned').length;
    const inProgressTickets = workOrders.filter((wo) => wo.status === 'in_progress').length;

    const resolvedToday = workOrders.filter(
      (wo) => wo.completedAt && wo.completedAt.startsWith(today)
    ).length;

    const dispatchedToday = dispatches.filter(
      (d) => d.dispatchedAt.startsWith(today)
    ).length;

    // Calculate first-time fix rate
    const completedOrders = workOrders.filter((wo) => wo.status === 'resolved' || wo.status === 'closed');
    const firstTimeFixes = completedOrders.filter((wo) => !wo.notes.some((n) => n.includes('revisit')));
    const firstTimeFixRate = completedOrders.length > 0
      ? Math.round((firstTimeFixes.length / completedOrders.length) * 100)
      : 0;

    // Calculate average resolution time
    const resolvedOrders = completedOrders.filter((wo) => wo.completedAt);
    const avgResolutionTimeHours = this.calculateAvgResolutionTime(resolvedOrders);

    // Calculate average response time
    const respondedOrders = workOrders.filter((wo) => wo.actualStartTime);
    const avgResponseTimeHours = this.calculateAvgResponseTime(respondedOrders);

    // Calculate customer satisfaction
    const ratedOrders = workOrders.filter((wo) => wo.satisfactionRating !== null);
    const customerSatisfaction = ratedOrders.length > 0
      ? Math.round(
          (ratedOrders.reduce((sum, wo) => sum + (wo.satisfactionRating || 0), 0) /
            ratedOrders.length) *
            20
        )
      : 0;

    // SLA compliance
    const slaTrackedOrders = completedOrders.filter((wo) => wo.slaDeadline);
    const slaCompliant = slaTrackedOrders.filter((wo) => !wo.slaBreached);
    const slaComplianceRate = slaTrackedOrders.length > 0
      ? Math.round((slaCompliant.length / slaTrackedOrders.length) * 100)
      : 100;

    // Technician utilization
    const onDutyTechs = technicians.filter((t) => t.status !== 'off_duty');
    const workingTechs = technicians.filter(
      (t) => t.status === 'on_job' || t.status === 'traveling'
    );
    const technicianUtilization = onDutyTechs.length > 0
      ? Math.round((workingTechs.length / onDutyTechs.length) * 100)
      : 0;

    // Parts and labor today
    const todayOrders = workOrders.filter(
      (wo) => wo.updatedAt.startsWith(today)
    );
    const partsUsedToday = todayOrders.reduce(
      (sum, wo) => sum + wo.partsUsed.reduce((ps, p) => ps + p.quantity, 0),
      0
    );
    const laborHoursToday = todayOrders.reduce((sum, wo) => sum + wo.laborHours, 0);

    return {
      openTickets,
      assignedTickets,
      inProgressTickets,
      resolvedToday,
      dispatchedToday,
      firstTimeFixRate,
      avgResolutionTimeHours,
      avgResponseTimeHours,
      customerSatisfaction,
      slaComplianceRate,
      technicianUtilization,
      partsUsedToday,
      laborHoursToday,
    };
  }

  /**
   * Get tickets by priority
   */
  public async getTicketsByPriority(): Promise<TicketsByPriority> {
    const workOrders = Array.from(this.workOrders.values());
    const openOrInProgress = workOrders.filter(
      (wo) => ['open', 'assigned', 'in_progress', 'on_hold'].includes(wo.status)
    );

    return {
      critical: openOrInProgress.filter((wo) => wo.priority === 'critical').length,
      high: openOrInProgress.filter((wo) => wo.priority === 'high').length,
      medium: openOrInProgress.filter((wo) => wo.priority === 'medium').length,
      low: openOrInProgress.filter((wo) => wo.priority === 'low').length,
    };
  }

  // ==========================================================================
  // Work Order Management
  // ==========================================================================

  /**
   * Get all work orders with optional filtering
   */
  public async getWorkOrders(filters?: {
    status?: WorkOrder['status'];
    priority?: WorkOrder['priority'];
    technicianId?: string;
    customerId?: string;
    limit?: number;
  }): Promise<WorkOrder[]> {
    let orders = Array.from(this.workOrders.values());

    if (filters?.status) {
      orders = orders.filter((wo) => wo.status === filters.status);
    }
    if (filters?.priority) {
      orders = orders.filter((wo) => wo.priority === filters.priority);
    }
    if (filters?.technicianId) {
      orders = orders.filter((wo) => wo.assignedTechnicianId === filters.technicianId);
    }
    if (filters?.customerId) {
      orders = orders.filter((wo) => wo.customerId === filters.customerId);
    }

    // Sort by priority and creation date
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    orders.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    if (filters?.limit) {
      orders = orders.slice(0, filters.limit);
    }

    return orders;
  }

  /**
   * Get work order by ID
   */
  public async getWorkOrder(id: string): Promise<WorkOrder | null> {
    return this.workOrders.get(id) || null;
  }

  /**
   * Create a new work order
   */
  public async createWorkOrder(request: WorkOrderCreateRequest): Promise<WorkOrder> {
    const id = `WO-${Date.now()}`;
    const now = new Date().toISOString();

    // Calculate SLA deadline based on priority
    const slaHours = this.getSLAHoursForPriority(request.priority);
    const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000).toISOString();

    const workOrder: WorkOrder = {
      id,
      customerId: request.customerId,
      customerName: request.customerName,
      title: request.title,
      description: request.description,
      priority: request.priority,
      status: 'open',
      type: request.type,
      assignedTechnicianId: null,
      assignedTechnicianName: null,
      location: request.location,
      scheduledDate: request.scheduledDate || null,
      scheduledTimeSlot: request.scheduledTimeSlot || null,
      actualStartTime: null,
      actualEndTime: null,
      slaDeadline,
      slaBreached: false,
      partsUsed: [],
      laborHours: 0,
      notes: [],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      customerSignature: false,
      satisfactionRating: null,
    };

    this.workOrders.set(id, workOrder);
    this.logger.info({ workOrderId: id }, 'Created work order');

    return workOrder;
  }

  /**
   * Update a work order
   */
  public async updateWorkOrder(
    id: string,
    updates: WorkOrderUpdateRequest
  ): Promise<WorkOrder | null> {
    const workOrder = this.workOrders.get(id);
    if (!workOrder) {
      return null;
    }

    const now = new Date().toISOString();

    if (updates.title !== undefined) workOrder.title = updates.title;
    if (updates.description !== undefined) workOrder.description = updates.description;
    if (updates.priority !== undefined) workOrder.priority = updates.priority;
    if (updates.status !== undefined) {
      workOrder.status = updates.status;
      if (updates.status === 'resolved' || updates.status === 'closed') {
        workOrder.completedAt = now;
        workOrder.actualEndTime = now;
      }
      if (updates.status === 'in_progress' && !workOrder.actualStartTime) {
        workOrder.actualStartTime = now;
      }
    }
    if (updates.scheduledDate !== undefined) workOrder.scheduledDate = updates.scheduledDate;
    if (updates.scheduledTimeSlot !== undefined) workOrder.scheduledTimeSlot = updates.scheduledTimeSlot;
    if (updates.notes !== undefined) workOrder.notes.push(updates.notes);

    workOrder.updatedAt = now;

    // Check SLA breach
    if (new Date(workOrder.slaDeadline) < new Date() && workOrder.status !== 'resolved' && workOrder.status !== 'closed') {
      workOrder.slaBreached = true;
    }

    this.workOrders.set(id, workOrder);
    this.logger.info({ workOrderId: id }, 'Updated work order');

    return workOrder;
  }

  /**
   * Complete a work order
   */
  public async completeWorkOrder(
    id: string,
    completion: {
      laborHours: number;
      partsUsed?: PartUsage[];
      notes?: string;
      customerSignature?: boolean;
      satisfactionRating?: number;
    }
  ): Promise<WorkOrder | null> {
    const workOrder = this.workOrders.get(id);
    if (!workOrder) {
      return null;
    }

    const now = new Date().toISOString();

    workOrder.status = 'resolved';
    workOrder.completedAt = now;
    workOrder.actualEndTime = now;
    workOrder.laborHours = completion.laborHours;

    if (completion.partsUsed) {
      workOrder.partsUsed = completion.partsUsed;
    }
    if (completion.notes) {
      workOrder.notes.push(completion.notes);
    }
    if (completion.customerSignature !== undefined) {
      workOrder.customerSignature = completion.customerSignature;
    }
    if (completion.satisfactionRating !== undefined) {
      workOrder.satisfactionRating = completion.satisfactionRating;
    }

    workOrder.updatedAt = now;

    // Update technician stats
    if (workOrder.assignedTechnicianId) {
      const tech = this.technicians.get(workOrder.assignedTechnicianId);
      if (tech) {
        tech.completedJobsToday++;
        tech.completedJobsTotal++;
        tech.status = 'available';
        tech.currentWorkOrderId = null;
        this.technicians.set(tech.id, tech);
      }
    }

    // Complete the dispatch
    const dispatch = Array.from(this.dispatches.values()).find(
      (d) => d.workOrderId === id && d.status !== 'completed' && d.status !== 'cancelled'
    );
    if (dispatch) {
      dispatch.status = 'completed';
      dispatch.completedAt = now;
      this.dispatches.set(dispatch.id, dispatch);
    }

    this.workOrders.set(id, workOrder);
    this.logger.info({ workOrderId: id }, 'Completed work order');

    return workOrder;
  }

  /**
   * Get recent work orders
   */
  public async getRecentWorkOrders(limit = 10): Promise<WorkOrder[]> {
    return this.getWorkOrders({ limit });
  }

  /**
   * Get work orders at risk of SLA breach
   */
  public async getSLAAtRiskWorkOrders(): Promise<WorkOrder[]> {
    const now = new Date();
    const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    return Array.from(this.workOrders.values()).filter((wo) => {
      if (wo.status === 'resolved' || wo.status === 'closed') return false;
      const deadline = new Date(wo.slaDeadline);
      return deadline < twoHoursFromNow && !wo.slaBreached;
    });
  }

  // ==========================================================================
  // Technician Management
  // ==========================================================================

  /**
   * Get all technicians
   */
  public async getTechnicians(filters?: {
    status?: Technician['status'];
    skill?: string;
    available?: boolean;
  }): Promise<Technician[]> {
    let techs = Array.from(this.technicians.values());

    if (filters?.status) {
      techs = techs.filter((t) => t.status === filters.status);
    }
    if (filters?.skill) {
      techs = techs.filter((t) =>
        t.skills.some((s) => s.toLowerCase().includes(filters.skill!.toLowerCase()))
      );
    }
    if (filters?.available) {
      techs = techs.filter((t) => t.status === 'available');
    }

    return techs;
  }

  /**
   * Get technician by ID
   */
  public async getTechnician(id: string): Promise<Technician | null> {
    return this.technicians.get(id) || null;
  }

  /**
   * Update technician status
   */
  public async updateTechnicianStatus(
    id: string,
    status: Technician['status'],
    location?: ServiceLocation
  ): Promise<Technician | null> {
    const tech = this.technicians.get(id);
    if (!tech) {
      return null;
    }

    tech.status = status;
    if (location) {
      tech.currentLocation = location;
    }

    this.technicians.set(id, tech);
    this.logger.info({ technicianId: id, status }, 'Updated technician status');

    return tech;
  }

  /**
   * Get technician status summary
   */
  public async getTechnicianStatusSummary(): Promise<TechnicianStatusSummary[]> {
    return Array.from(this.technicians.values()).map((tech) => {
      const currentWorkOrder = tech.currentWorkOrderId
        ? this.workOrders.get(tech.currentWorkOrderId)
        : null;

      return {
        id: tech.id,
        name: tech.name,
        status: tech.status,
        currentJob: currentWorkOrder?.title || null,
        jobsCompleted: tech.completedJobsToday,
        rating: tech.rating,
      };
    });
  }

  /**
   * Get technician schedule for a specific date
   */
  public async getTechnicianSchedule(
    technicianId: string,
    date: string
  ): Promise<TechnicianSchedule | null> {
    const tech = this.technicians.get(technicianId);
    if (!tech) {
      return null;
    }

    // Get work orders scheduled for this technician on this date
    const scheduledOrders = Array.from(this.workOrders.values()).filter(
      (wo) =>
        wo.assignedTechnicianId === technicianId &&
        wo.scheduledDate === date
    );

    const slots: ScheduleSlot[] = [];
    let totalScheduledHours = 0;

    // Create time slots (8 AM to 6 PM)
    for (let hour = 8; hour < 18; hour++) {
      const startTime = `${hour.toString().padStart(2, '0')}:00`;
      const endTime = `${(hour + 1).toString().padStart(2, '0')}:00`;

      const scheduledOrder = scheduledOrders.find(
        (wo) => wo.scheduledTimeSlot?.startsWith(startTime)
      );

      if (scheduledOrder) {
        slots.push({
          startTime,
          endTime,
          workOrderId: scheduledOrder.id,
          workOrderTitle: scheduledOrder.title,
          status: scheduledOrder.status === 'resolved' ? 'completed' :
                 scheduledOrder.status === 'in_progress' ? 'in_progress' : 'scheduled',
        });
        totalScheduledHours++;
      } else {
        slots.push({
          startTime,
          endTime,
          workOrderId: null,
          workOrderTitle: null,
          status: 'available',
        });
      }
    }

    return {
      technicianId,
      technicianName: tech.name,
      date,
      slots,
      totalScheduledHours,
      availableHours: 10 - totalScheduledHours,
    };
  }

  /**
   * Find best technician for a work order based on skills, location, and availability
   */
  public async findBestTechnician(workOrderId: string): Promise<{
    recommendations: {
      technician: Technician;
      score: number;
      reasons: string[];
    }[];
  }> {
    const workOrder = this.workOrders.get(workOrderId);
    if (!workOrder) {
      return { recommendations: [] };
    }

    const availableTechs = await this.getTechnicians({ available: true });

    const recommendations = availableTechs.map((tech) => {
      let score = 50; // Base score
      const reasons: string[] = [];

      // Rating bonus (up to 20 points)
      if (tech.rating >= 4.5) {
        score += 20;
        reasons.push('Excellent rating (4.5+)');
      } else if (tech.rating >= 4.0) {
        score += 15;
        reasons.push('Good rating (4.0+)');
      }

      // First-time fix rate bonus (up to 15 points)
      if (tech.firstTimeFixRate >= 90) {
        score += 15;
        reasons.push('High first-time fix rate (90%+)');
      } else if (tech.firstTimeFixRate >= 80) {
        score += 10;
        reasons.push('Good first-time fix rate (80%+)');
      }

      // Skill match bonus (up to 15 points)
      const requiredSkills = this.getRequiredSkillsForType(workOrder.type);
      const matchedSkills = requiredSkills.filter((skill) =>
        tech.skills.some((ts) => ts.toLowerCase().includes(skill.toLowerCase()))
      );
      if (matchedSkills.length === requiredSkills.length) {
        score += 15;
        reasons.push('All required skills matched');
      } else if (matchedSkills.length > 0) {
        score += 10;
        reasons.push(`${matchedSkills.length}/${requiredSkills.length} skills matched`);
      }

      return { technician: tech, score, reasons };
    });

    // Sort by score descending
    recommendations.sort((a, b) => b.score - a.score);

    return { recommendations: recommendations.slice(0, 5) };
  }

  // ==========================================================================
  // Dispatch Management
  // ==========================================================================

  /**
   * Dispatch a technician to a work order
   */
  public async dispatchTechnician(request: DispatchRequest): Promise<{
    success: boolean;
    dispatch?: ServiceDispatch;
    error?: string;
  }> {
    const workOrder = this.workOrders.get(request.workOrderId);
    if (!workOrder) {
      return { success: false, error: 'Work order not found' };
    }

    const technician = this.technicians.get(request.technicianId);
    if (!technician) {
      return { success: false, error: 'Technician not found' };
    }

    if (technician.status !== 'available') {
      return { success: false, error: 'Technician is not available' };
    }

    const now = new Date().toISOString();
    const dispatchId = `DSP-${Date.now()}`;

    // Create dispatch record
    const dispatch: ServiceDispatch = {
      id: dispatchId,
      workOrderId: request.workOrderId,
      technicianId: request.technicianId,
      technicianName: technician.name,
      status: 'pending',
      dispatchedAt: now,
      estimatedArrival: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min estimate
      actualArrival: null,
      completedAt: null,
      travelDistance: 0,
      travelTime: 30,
      notes: request.notes || '',
    };

    // Update work order
    workOrder.assignedTechnicianId = request.technicianId;
    workOrder.assignedTechnicianName = technician.name;
    workOrder.status = 'assigned';
    workOrder.scheduledDate = request.scheduledDate || workOrder.scheduledDate;
    workOrder.scheduledTimeSlot = request.scheduledTimeSlot || workOrder.scheduledTimeSlot;
    workOrder.updatedAt = now;

    // Update technician
    technician.status = 'traveling';
    technician.currentWorkOrderId = request.workOrderId;
    technician.scheduledWorkOrders.push(request.workOrderId);

    this.dispatches.set(dispatchId, dispatch);
    this.workOrders.set(request.workOrderId, workOrder);
    this.technicians.set(request.technicianId, technician);

    this.logger.info(
      { dispatchId, workOrderId: request.workOrderId, technicianId: request.technicianId },
      'Technician dispatched'
    );

    return { success: true, dispatch };
  }

  /**
   * Update dispatch status
   */
  public async updateDispatchStatus(
    dispatchId: string,
    status: ServiceDispatch['status']
  ): Promise<ServiceDispatch | null> {
    const dispatch = this.dispatches.get(dispatchId);
    if (!dispatch) {
      return null;
    }

    const now = new Date().toISOString();
    dispatch.status = status;

    if (status === 'arrived') {
      dispatch.actualArrival = now;
      // Update work order to in_progress
      const workOrder = this.workOrders.get(dispatch.workOrderId);
      if (workOrder) {
        workOrder.status = 'in_progress';
        workOrder.actualStartTime = now;
        workOrder.updatedAt = now;
        this.workOrders.set(workOrder.id, workOrder);
      }
      // Update technician status
      const tech = this.technicians.get(dispatch.technicianId);
      if (tech) {
        tech.status = 'on_job';
        this.technicians.set(tech.id, tech);
      }
    }

    if (status === 'completed') {
      dispatch.completedAt = now;
    }

    this.dispatches.set(dispatchId, dispatch);
    this.logger.info({ dispatchId, status }, 'Dispatch status updated');

    return dispatch;
  }

  /**
   * Get active dispatches
   */
  public async getActiveDispatches(): Promise<ServiceDispatch[]> {
    return Array.from(this.dispatches.values()).filter(
      (d) => ['pending', 'en_route', 'arrived', 'working'].includes(d.status)
    );
  }

  /**
   * Get dispatch history for a work order
   */
  public async getDispatchHistory(workOrderId: string): Promise<ServiceDispatch[]> {
    return Array.from(this.dispatches.values()).filter(
      (d) => d.workOrderId === workOrderId
    );
  }

  // ==========================================================================
  // SLA Management
  // ==========================================================================

  /**
   * Get all SLA definitions
   */
  public async getSLAs(): Promise<ServiceSLA[]> {
    return Array.from(this.slas.values());
  }

  /**
   * Get SLA compliance report
   */
  public async getSLAComplianceReport(startDate: string, endDate: string): Promise<{
    totalTickets: number;
    compliantTickets: number;
    breachedTickets: number;
    complianceRate: number;
    byPriority: Record<string, { total: number; compliant: number; rate: number }>;
  }> {
    const workOrders = Array.from(this.workOrders.values()).filter((wo) => {
      const created = new Date(wo.createdAt);
      return created >= new Date(startDate) && created <= new Date(endDate);
    });

    const completedOrders = workOrders.filter(
      (wo) => wo.status === 'resolved' || wo.status === 'closed'
    );

    const breachedTickets = completedOrders.filter((wo) => wo.slaBreached).length;
    const compliantTickets = completedOrders.length - breachedTickets;

    const byPriority: Record<string, { total: number; compliant: number; rate: number }> = {};
    for (const priority of ['critical', 'high', 'medium', 'low']) {
      const priorityOrders = completedOrders.filter((wo) => wo.priority === priority);
      const priorityCompliant = priorityOrders.filter((wo) => !wo.slaBreached).length;
      byPriority[priority] = {
        total: priorityOrders.length,
        compliant: priorityCompliant,
        rate: priorityOrders.length > 0
          ? Math.round((priorityCompliant / priorityOrders.length) * 100)
          : 100,
      };
    }

    return {
      totalTickets: completedOrders.length,
      compliantTickets,
      breachedTickets,
      complianceRate: completedOrders.length > 0
        ? Math.round((compliantTickets / completedOrders.length) * 100)
        : 100,
      byPriority,
    };
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private getSLAHoursForPriority(priority: WorkOrder['priority']): number {
    const slaMap = { critical: 4, high: 8, medium: 24, low: 72 };
    return slaMap[priority];
  }

  private getRequiredSkillsForType(type: WorkOrder['type']): string[] {
    const skillMap: Record<WorkOrder['type'], string[]> = {
      installation: ['installation', 'setup'],
      repair: ['troubleshooting', 'repair'],
      maintenance: ['preventive', 'inspection'],
      inspection: ['inspection', 'certification'],
      warranty: ['warranty', 'documentation'],
    };
    return skillMap[type] || [];
  }

  private calculateAvgResolutionTime(orders: WorkOrder[]): number {
    if (orders.length === 0) return 0;

    const totalHours = orders.reduce((sum, wo) => {
      if (!wo.completedAt) return sum;
      const created = new Date(wo.createdAt).getTime();
      const completed = new Date(wo.completedAt).getTime();
      return sum + (completed - created) / (1000 * 60 * 60);
    }, 0);

    return Math.round((totalHours / orders.length) * 10) / 10;
  }

  private calculateAvgResponseTime(orders: WorkOrder[]): number {
    if (orders.length === 0) return 0;

    const totalHours = orders.reduce((sum, wo) => {
      if (!wo.actualStartTime) return sum;
      const created = new Date(wo.createdAt).getTime();
      const started = new Date(wo.actualStartTime).getTime();
      return sum + (started - created) / (1000 * 60 * 60);
    }, 0);

    return Math.round((totalHours / orders.length) * 10) / 10;
  }

  // ==========================================================================
  // Demo Data Initialization
  // ==========================================================================

  private initializeDemoData(): void {
    // Initialize SLAs
    const slas: ServiceSLA[] = [
      { id: 'SLA-1', name: 'Critical Response', priority: 'critical', responseTimeHours: 1, resolutionTimeHours: 4, description: 'Emergency issues requiring immediate attention' },
      { id: 'SLA-2', name: 'High Priority', priority: 'high', responseTimeHours: 2, resolutionTimeHours: 8, description: 'Urgent issues affecting business operations' },
      { id: 'SLA-3', name: 'Standard', priority: 'medium', responseTimeHours: 4, resolutionTimeHours: 24, description: 'Standard service requests' },
      { id: 'SLA-4', name: 'Low Priority', priority: 'low', responseTimeHours: 8, resolutionTimeHours: 72, description: 'Non-urgent requests and improvements' },
    ];
    slas.forEach((sla) => this.slas.set(sla.id, sla));

    // Initialize Technicians
    const technicians: Technician[] = [
      {
        id: 'TECH-001',
        name: 'Mike Johnson',
        email: 'mike.johnson@company.com',
        phone: '555-0101',
        status: 'available',
        currentLocation: { address: '123 Main St', city: 'Denver', state: 'CO', zipCode: '80202' },
        skills: ['installation', 'repair', 'electrical', 'HVAC'],
        certifications: ['HVAC Certified', 'Electrical License'],
        rating: 4.8,
        completedJobsToday: 3,
        completedJobsTotal: 847,
        firstTimeFixRate: 94,
        averageJobDuration: 75,
        currentWorkOrderId: null,
        scheduledWorkOrders: [],
        vehicleId: 'VAN-001',
      },
      {
        id: 'TECH-002',
        name: 'Sarah Williams',
        email: 'sarah.williams@company.com',
        phone: '555-0102',
        status: 'on_job',
        currentLocation: { address: '456 Oak Ave', city: 'Boulder', state: 'CO', zipCode: '80301' },
        skills: ['installation', 'networking', 'security systems'],
        certifications: ['Network+ Certified', 'Security+'],
        rating: 4.9,
        completedJobsToday: 2,
        completedJobsTotal: 623,
        firstTimeFixRate: 96,
        averageJobDuration: 90,
        currentWorkOrderId: 'WO-002',
        scheduledWorkOrders: ['WO-002', 'WO-005'],
        vehicleId: 'VAN-002',
      },
      {
        id: 'TECH-003',
        name: 'James Chen',
        email: 'james.chen@company.com',
        phone: '555-0103',
        status: 'traveling',
        currentLocation: { address: '789 Pine Rd', city: 'Aurora', state: 'CO', zipCode: '80010' },
        skills: ['repair', 'troubleshooting', 'appliance repair'],
        certifications: ['Appliance Repair Certified'],
        rating: 4.6,
        completedJobsToday: 4,
        completedJobsTotal: 512,
        firstTimeFixRate: 88,
        averageJobDuration: 60,
        currentWorkOrderId: 'WO-003',
        scheduledWorkOrders: ['WO-003'],
        vehicleId: 'VAN-003',
      },
      {
        id: 'TECH-004',
        name: 'Emily Davis',
        email: 'emily.davis@company.com',
        phone: '555-0104',
        status: 'available',
        currentLocation: { address: '321 Elm St', city: 'Lakewood', state: 'CO', zipCode: '80214' },
        skills: ['installation', 'maintenance', 'inspection', 'warranty'],
        certifications: ['Certified Inspector', 'Warranty Specialist'],
        rating: 4.7,
        completedJobsToday: 2,
        completedJobsTotal: 389,
        firstTimeFixRate: 91,
        averageJobDuration: 85,
        currentWorkOrderId: null,
        scheduledWorkOrders: [],
        vehicleId: 'VAN-004',
      },
    ];
    technicians.forEach((tech) => this.technicians.set(tech.id, tech));

    // Initialize Work Orders
    const now = new Date();
    const workOrders: WorkOrder[] = [
      {
        id: 'WO-001',
        customerId: 'CUST-001',
        customerName: 'Acme Corporation',
        title: 'HVAC System Not Cooling',
        description: 'Main office HVAC unit not producing cold air. Multiple complaints from staff.',
        priority: 'high',
        status: 'open',
        type: 'repair',
        assignedTechnicianId: null,
        assignedTechnicianName: null,
        location: { address: '100 Corporate Blvd', city: 'Denver', state: 'CO', zipCode: '80203' },
        scheduledDate: null,
        scheduledTimeSlot: null,
        actualStartTime: null,
        actualEndTime: null,
        slaDeadline: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
        slaBreached: false,
        partsUsed: [],
        laborHours: 0,
        notes: ['Customer called at 9am reporting issue'],
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        completedAt: null,
        customerSignature: false,
        satisfactionRating: null,
      },
      {
        id: 'WO-002',
        customerId: 'CUST-002',
        customerName: 'Tech Solutions Inc',
        title: 'Network Switch Installation',
        description: 'Install new 48-port managed switch in server room.',
        priority: 'medium',
        status: 'in_progress',
        type: 'installation',
        assignedTechnicianId: 'TECH-002',
        assignedTechnicianName: 'Sarah Williams',
        location: { address: '200 Tech Park Dr', city: 'Boulder', state: 'CO', zipCode: '80301' },
        scheduledDate: now.toISOString().split('T')[0],
        scheduledTimeSlot: '10:00-12:00',
        actualStartTime: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(),
        actualEndTime: null,
        slaDeadline: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        slaBreached: false,
        partsUsed: [{ partId: 'PART-001', partName: 'Cisco 48-Port Switch', quantity: 1, unitCost: 1200 }],
        laborHours: 0,
        notes: ['Arrived on site', 'Began installation'],
        createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(),
        completedAt: null,
        customerSignature: false,
        satisfactionRating: null,
      },
      {
        id: 'WO-003',
        customerId: 'CUST-003',
        customerName: 'Mountain View Medical',
        title: 'Emergency Generator Inspection',
        description: 'Annual inspection of backup generator system.',
        priority: 'critical',
        status: 'assigned',
        type: 'inspection',
        assignedTechnicianId: 'TECH-003',
        assignedTechnicianName: 'James Chen',
        location: { address: '500 Medical Center Way', city: 'Aurora', state: 'CO', zipCode: '80010' },
        scheduledDate: now.toISOString().split('T')[0],
        scheduledTimeSlot: '14:00-16:00',
        actualStartTime: null,
        actualEndTime: null,
        slaDeadline: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(),
        slaBreached: false,
        partsUsed: [],
        laborHours: 0,
        notes: ['Healthcare facility - critical infrastructure'],
        createdAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
        completedAt: null,
        customerSignature: false,
        satisfactionRating: null,
      },
      {
        id: 'WO-004',
        customerId: 'CUST-004',
        customerName: 'Green Valley Apartments',
        title: 'Routine HVAC Maintenance',
        description: 'Quarterly maintenance on building HVAC systems.',
        priority: 'low',
        status: 'open',
        type: 'maintenance',
        assignedTechnicianId: null,
        assignedTechnicianName: null,
        location: { address: '800 Valley View Rd', city: 'Lakewood', state: 'CO', zipCode: '80214' },
        scheduledDate: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        scheduledTimeSlot: '09:00-17:00',
        actualStartTime: null,
        actualEndTime: null,
        slaDeadline: new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString(),
        slaBreached: false,
        partsUsed: [],
        laborHours: 0,
        notes: ['Full building maintenance - allocate full day'],
        createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(),
        completedAt: null,
        customerSignature: false,
        satisfactionRating: null,
      },
    ];
    workOrders.forEach((wo) => this.workOrders.set(wo.id, wo));

    // Initialize Dispatches
    const dispatches: ServiceDispatch[] = [
      {
        id: 'DSP-001',
        workOrderId: 'WO-002',
        technicianId: 'TECH-002',
        technicianName: 'Sarah Williams',
        status: 'working',
        dispatchedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        estimatedArrival: new Date(now.getTime() - 1.5 * 60 * 60 * 1000).toISOString(),
        actualArrival: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(),
        completedAt: null,
        travelDistance: 15,
        travelTime: 25,
        notes: 'Traffic delay on I-25',
      },
      {
        id: 'DSP-002',
        workOrderId: 'WO-003',
        technicianId: 'TECH-003',
        technicianName: 'James Chen',
        status: 'en_route',
        dispatchedAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
        estimatedArrival: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
        actualArrival: null,
        completedAt: null,
        travelDistance: 22,
        travelTime: 35,
        notes: '',
      },
    ];
    dispatches.forEach((d) => this.dispatches.set(d.id, d));

    this.logger.info(
      {
        workOrders: this.workOrders.size,
        technicians: this.technicians.size,
        dispatches: this.dispatches.size,
        slas: this.slas.size,
      },
      'ServiceCentralService demo data initialized'
    );
  }
}
