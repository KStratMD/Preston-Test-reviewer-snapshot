import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import { squireInstallers, squireProjects, type SquireInstaller, type SquireProject } from '../data/squireMockData';

/**
 * Installer location with coordinates
 */
export interface InstallerLocation {
  installerId: string;
  name: string;
  businessName: string;
  latitude: number;
  longitude: number;
  serviceAddress: string;
  workingRadius: number;
}

/**
 * Job location for proximity matching
 */
export interface JobLocation {
  jobId: string;
  customerName: string;
  address: string;
  latitude: number;
  longitude: number;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  requiredCertifications?: string[];
  requiredSpecializations?: string[];
  estimatedHours: number;
  scheduledDate?: string;
}

/**
 * Proximity match request
 */
export interface InstallerProximityRequest {
  jobLocation: JobLocation;
  maxDistanceMiles?: number;
  maxResults?: number;
  requiredAvailability?: boolean;
  minRating?: number;
}

/**
 * Individual installer match result
 */
export interface InstallerMatch {
  installerId: string;
  installerName: string;
  businessName: string;
  distanceMiles: number;
  rating: number;
  certifications: string[];
  specializations: string[];
  availability: 'available' | 'busy' | 'unavailable';
  estimatedArrivalTime: string;
  priceModifier: number;
  matchScore: number;
  matchBreakdown: {
    distanceScore: number;
    ratingScore: number;
    certificationScore: number;
    availabilityScore: number;
  };
  hourlyRate: number;
  completedProjects: number;
  contactEmail: string;
  primaryPhone: string;
}

/**
 * Proximity match response
 */
export interface InstallerProximityResponse {
  jobId: string;
  searchRadiusMiles: number;
  totalInstallers: number;
  matchingInstallers: InstallerMatch[];
  timestamp: number;
}

/**
 * Installer availability status
 */
export interface InstallerAvailability {
  installerId: string;
  installerName: string;
  status: 'available' | 'busy' | 'unavailable';
  currentJob?: {
    jobId: string;
    customerName: string;
    estimatedCompletion: string;
  };
  nextAvailableSlot: string;
  weeklySchedule: {
    dayOfWeek: number;
    availableSlots: { start: string; end: string }[];
  }[];
  bookedJobs: {
    jobId: string;
    date: string;
    duration: number;
  }[];
}

/**
 * Job assignment request
 */
export interface JobAssignmentRequest {
  jobId: string;
  installerId: string;
  scheduledDate: string;
  estimatedHours: number;
  notes?: string;
}

/**
 * Job assignment result
 */
export interface JobAssignmentResult {
  success: boolean;
  jobId: string;
  installerId: string;
  assignmentId?: string;
  scheduledDate?: string;
  errorMessage?: string;
}

/**
 * NetSuite Sales Order linking request
 */
export interface NetSuiteSalesOrderLinkRequest {
  jobId: string;
  installerId: string;
  netSuiteSalesOrderId: string;
  customerNetSuiteId?: string;
  projectValue: number;
  commissionRate: number;
}

/**
 * NetSuite Sales Order link result
 */
export interface NetSuiteSalesOrderLinkResult {
  success: boolean;
  jobId: string;
  netSuiteSalesOrderId: string;
  linkId?: string;
  timestamp?: number;
  errorMessage?: string;
}

/**
 * Dashboard metrics for InstallerCentral
 */
export interface InstallerDashboardMetrics {
  summary: {
    activeInstallers: number;
    pendingJobs: number;
    completedToday: number;
    avgRating: number;
  };
  metrics: {
    totalInstallers: number;
    activeInstallers: number;
    inactiveInstallers: number;
    certifiedInstallers: number;
    avgResponseTime: string;
    avgCompletionTime: string;
    customerSatisfaction: number;
    onTimeRate: number;
  };
  installersByRegion: Record<string, {
    count: number;
    avgRating: number;
    utilizationRate: number;
  }>;
  pendingJobs: {
    id: string;
    customer: string;
    location: string;
    priority: string;
    status: string;
    coordinates?: { lat: number; lng: number };
  }[];
  topInstallers: {
    id: string;
    name: string;
    rating: number;
    jobsCompleted: number;
    region: string;
  }[];
}

/**
 * Static coordinates for installer addresses
 * These would typically come from a geocoding service in production
 */
const INSTALLER_COORDINATES: Record<string, { lat: number; lng: number }> = {
  'SQ_INST_001': { lat: 33.7490, lng: -84.3880 },  // Atlanta, GA
  'SQ_INST_002': { lat: 25.7617, lng: -80.1918 },  // Miami, FL
  'SQ_INST_003': { lat: 34.0522, lng: -118.2437 }, // Los Angeles, CA
};

/**
 * Static coordinates for job locations
 */
const JOB_COORDINATES: Record<string, { lat: number; lng: number }> = {
  'JOB-2024-892': { lat: 39.7392, lng: -104.9903 }, // Denver, CO
  'JOB-2024-891': { lat: 33.4484, lng: -112.0740 }, // Phoenix, AZ
  'JOB-2024-890': { lat: 47.6062, lng: -122.3321 }, // Seattle, WA
};

/**
 * InstallerCentralService provides proximity-based installer matching,
 * availability checking, and NetSuite Sales Order integration
 */
@injectable()
export class InstallerCentralService {
  private readonly EARTH_RADIUS_MILES = 3958.7613;

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger
  ) {
    this.logger.info('InstallerCentralService initialized');
  }

  /**
   * Convert degrees to radians
   */
  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * Calculate distance between two points using the Haversine formula
   * Returns distance in miles
   */
  public calculateHaversineDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return this.EARTH_RADIUS_MILES * c;
  }

  /**
   * Get installer locations with coordinates
   */
  public getInstallerLocations(): InstallerLocation[] {
    return squireInstallers.map(installer => {
      const coords = INSTALLER_COORDINATES[installer.id] || { lat: 0, lng: 0 };
      return {
        installerId: installer.id,
        name: installer.installerName,
        businessName: installer.businessName,
        latitude: coords.lat,
        longitude: coords.lng,
        serviceAddress: installer.serviceAddress,
        workingRadius: installer.workingRadius,
      };
    });
  }

  /**
   * Calculate match score for an installer against a job
   * Scoring factors: distance (40%), rating (25%), certifications (20%), availability (15%)
   */
  private calculateMatchScore(
    installer: SquireInstaller,
    distanceMiles: number,
    job: JobLocation
  ): { score: number; breakdown: InstallerMatch['matchBreakdown'] } {
    // Distance score (40%) - closer is better, max at working radius
    const distanceRatio = Math.max(0, 1 - distanceMiles / installer.workingRadius);
    const distanceScore = distanceRatio * 40;

    // Rating score (25%) - linear scale from 0-5 to 0-25
    const ratingScore = (installer.averageRating / 5) * 25;

    // Certification score (20%) - percentage of required certifications/specializations met
    let certificationScore = 20; // Default full score if no requirements
    if (job.requiredSpecializations && job.requiredSpecializations.length > 0) {
      const matchedSpecs = job.requiredSpecializations.filter(
        spec => installer.specializations.includes(spec)
      );
      certificationScore = (matchedSpecs.length / job.requiredSpecializations.length) * 20;
    }

    // Availability score (15%)
    let availabilityScore: number;
    switch (installer.availabilityStatus) {
      case 'Available':
        availabilityScore = 15;
        break;
      case 'Booked':
        availabilityScore = 7.5;
        break;
      default:
        availabilityScore = 0;
    }

    const totalScore = distanceScore + ratingScore + certificationScore + availabilityScore;

    return {
      score: Math.round(totalScore * 100) / 100,
      breakdown: {
        distanceScore: Math.round(distanceScore * 100) / 100,
        ratingScore: Math.round(ratingScore * 100) / 100,
        certificationScore: Math.round(certificationScore * 100) / 100,
        availabilityScore: Math.round(availabilityScore * 100) / 100,
      },
    };
  }

  /**
   * Map availability status from Squire format to internal format
   */
  private mapAvailabilityStatus(status: string): 'available' | 'busy' | 'unavailable' {
    switch (status) {
      case 'Available':
        return 'available';
      case 'Booked':
        return 'busy';
      default:
        return 'unavailable';
    }
  }

  /**
   * Calculate price modifier based on distance, urgency, and demand
   */
  private calculatePriceModifier(
    distanceMiles: number,
    workingRadius: number,
    priority: string
  ): number {
    let modifier = 1.0;

    // Distance-based modifier (up to 20% for edge of radius)
    if (distanceMiles > workingRadius * 0.5) {
      modifier += (distanceMiles / workingRadius) * 0.2;
    }

    // Priority-based modifier
    switch (priority) {
      case 'urgent':
        modifier += 0.5;
        break;
      case 'high':
        modifier += 0.25;
        break;
      case 'medium':
        modifier += 0.1;
        break;
    }

    return Math.round(modifier * 100) / 100;
  }

  /**
   * Estimate arrival time based on distance
   */
  private estimateArrivalTime(distanceMiles: number): string {
    // Assume average speed of 30 mph in urban/suburban areas
    const travelHours = distanceMiles / 30;

    if (travelHours < 0.5) {
      return `${Math.ceil(travelHours * 60)} minutes`;
    } else if (travelHours < 1) {
      return '30-60 minutes';
    } else if (travelHours < 2) {
      return '1-2 hours';
    } else {
      return `${Math.ceil(travelHours)} hours`;
    }
  }

  /**
   * Find nearest installers for a job location
   */
  public async findNearestInstallers(
    request: InstallerProximityRequest
  ): Promise<InstallerProximityResponse> {
    const startTime = Date.now();
    const { jobLocation, maxDistanceMiles = 100, maxResults = 10, requiredAvailability = false, minRating = 0 } = request;

    this.logger.info('Finding nearest installers', {
      jobId: jobLocation.jobId,
      maxDistance: maxDistanceMiles,
      maxResults,
    });

    const matches: InstallerMatch[] = [];

    for (const installer of squireInstallers) {
      const coords = INSTALLER_COORDINATES[installer.id];
      if (!coords) continue;

      // Calculate distance
      const distanceMiles = this.calculateHaversineDistance(
        jobLocation.latitude,
        jobLocation.longitude,
        coords.lat,
        coords.lng
      );

      // Filter by distance and working radius
      if (distanceMiles > maxDistanceMiles || distanceMiles > installer.workingRadius) {
        continue;
      }

      // Filter by minimum rating
      if (installer.averageRating < minRating) {
        continue;
      }

      // Filter by availability if required
      const availability = this.mapAvailabilityStatus(installer.availabilityStatus);
      if (requiredAvailability && availability !== 'available') {
        continue;
      }

      // Calculate match score
      const { score, breakdown } = this.calculateMatchScore(installer, distanceMiles, jobLocation);

      // Calculate price modifier
      const priceModifier = this.calculatePriceModifier(
        distanceMiles,
        installer.workingRadius,
        jobLocation.priority
      );

      matches.push({
        installerId: installer.id,
        installerName: installer.installerName,
        businessName: installer.businessName,
        distanceMiles: Math.round(distanceMiles * 100) / 100,
        rating: installer.averageRating,
        certifications: [installer.certificationLevel],
        specializations: installer.specializations,
        availability,
        estimatedArrivalTime: this.estimateArrivalTime(distanceMiles),
        priceModifier,
        matchScore: score,
        matchBreakdown: breakdown,
        hourlyRate: installer.hourlyRate,
        completedProjects: installer.completedProjects,
        contactEmail: installer.contactEmail,
        primaryPhone: installer.primaryPhone,
      });
    }

    // Sort by match score (descending)
    matches.sort((a, b) => b.matchScore - a.matchScore);

    // Limit results
    const topMatches = matches.slice(0, maxResults);

    const response: InstallerProximityResponse = {
      jobId: jobLocation.jobId,
      searchRadiusMiles: maxDistanceMiles,
      totalInstallers: squireInstallers.length,
      matchingInstallers: topMatches,
      timestamp: Date.now(),
    };

    this.logger.info('Installer proximity search telemetry', {
      jobId: jobLocation.jobId,
      matchCount: topMatches.length,
      searchRadius: maxDistanceMiles,
      durationMs: Date.now() - startTime,
    });

    this.logger.info('Proximity search completed', {
      jobId: jobLocation.jobId,
      matchCount: topMatches.length,
      durationMs: Date.now() - startTime,
    });

    return response;
  }

  /**
   * Get installer availability details
   */
  public async getInstallerAvailability(installerId: string): Promise<InstallerAvailability | null> {
    const installer = squireInstallers.find(i => i.id === installerId);
    if (!installer) {
      return null;
    }

    // Get projects assigned to this installer
    const installerProjects = squireProjects.filter(
      p => p.assignedInstaller === installerId
    );

    const inProgressProject = installerProjects.find(p => p.projectStatus === 'In Progress');
    const scheduledProjects = installerProjects.filter(p => p.projectStatus === 'Scheduled');

    // Calculate next available slot (simplified logic)
    let nextAvailableSlot = new Date().toISOString();
    if (inProgressProject) {
      // Estimate completion based on remaining hours
      const remainingHours = (inProgressProject.estimatedHours || 8) - (inProgressProject.actualHours || 0);
      const completionTime = new Date(Date.now() + remainingHours * 3600000);
      nextAvailableSlot = completionTime.toISOString();
    }

    return {
      installerId: installer.id,
      installerName: installer.installerName,
      status: this.mapAvailabilityStatus(installer.availabilityStatus),
      currentJob: inProgressProject ? {
        jobId: inProgressProject.projectNumber,
        customerName: inProgressProject.customerName,
        estimatedCompletion: nextAvailableSlot,
      } : undefined,
      nextAvailableSlot,
      weeklySchedule: [
        { dayOfWeek: 1, availableSlots: [{ start: '08:00', end: '17:00' }] },
        { dayOfWeek: 2, availableSlots: [{ start: '08:00', end: '17:00' }] },
        { dayOfWeek: 3, availableSlots: [{ start: '08:00', end: '17:00' }] },
        { dayOfWeek: 4, availableSlots: [{ start: '08:00', end: '17:00' }] },
        { dayOfWeek: 5, availableSlots: [{ start: '08:00', end: '17:00' }] },
      ],
      bookedJobs: scheduledProjects.map(p => ({
        jobId: p.projectNumber,
        date: p.installationDate,
        duration: p.estimatedHours,
      })),
    };
  }

  /**
   * Assign an installer to a job
   */
  public async assignInstallerToJob(
    request: JobAssignmentRequest
  ): Promise<JobAssignmentResult> {
    const { jobId, installerId, scheduledDate, estimatedHours, notes } = request;

    this.logger.info('Assigning installer to job', { jobId, installerId, scheduledDate });

    // Verify installer exists
    const installer = squireInstallers.find(i => i.id === installerId);
    if (!installer) {
      return {
        success: false,
        jobId,
        installerId,
        errorMessage: `Installer ${installerId} not found`,
      };
    }

    // Check availability (simplified - in production would check actual schedule)
    if (installer.availabilityStatus === 'Unavailable') {
      return {
        success: false,
        jobId,
        installerId,
        errorMessage: `Installer ${installer.installerName} is currently unavailable`,
      };
    }

    // Generate assignment ID
    const assignmentId = `ASSIGN-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 9)}`;

    this.logger.info('Installer job assigned telemetry', {
      jobId,
      installerId,
      assignmentId,
      scheduledDate,
      estimatedHours,
    });

    this.logger.info('Job assigned successfully', { assignmentId, jobId, installerId });

    return {
      success: true,
      jobId,
      installerId,
      assignmentId,
      scheduledDate,
    };
  }

  /**
   * Link a job to a NetSuite Sales Order
   */
  public async linkToNetSuiteSalesOrder(
    request: NetSuiteSalesOrderLinkRequest
  ): Promise<NetSuiteSalesOrderLinkResult> {
    const { jobId, installerId, netSuiteSalesOrderId, projectValue, commissionRate } = request;

    this.logger.info('Linking job to NetSuite Sales Order', {
      jobId,
      installerId,
      netSuiteSalesOrderId,
    });

    // Validate the installer exists
    const installer = squireInstallers.find(i => i.id === installerId);
    if (!installer) {
      return {
        success: false,
        jobId,
        netSuiteSalesOrderId,
        errorMessage: `Installer ${installerId} not found`,
      };
    }

    // In demo mode, simulate the linking
    // In production, this would call the NetSuite connector to:
    // 1. Verify the Sales Order exists
    // 2. Create a custom record linking the installer
    // 3. Update commission records

    const linkId = `NS-LINK-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 9)}`;
    const timestamp = Date.now();

    this.logger.info('NetSuite SO linked telemetry', {
      jobId,
      installerId,
      netSuiteSalesOrderId,
      linkId,
      projectValue,
      commissionRate,
    });

    this.logger.info('NetSuite Sales Order linked successfully', {
      linkId,
      jobId,
      netSuiteSalesOrderId,
    });

    return {
      success: true,
      jobId,
      netSuiteSalesOrderId,
      linkId,
      timestamp,
    };
  }

  /**
   * Get dashboard metrics with live data
   */
  public async getDashboardMetrics(): Promise<InstallerDashboardMetrics> {
    const installers = squireInstallers;
    const projects = squireProjects;

    // Calculate real metrics from data
    const activeInstallers = installers.filter(i => i.availabilityStatus !== 'Unavailable');
    const certifiedInstallers = installers.filter(i =>
      i.certificationLevel === 'Master' || i.certificationLevel === 'Certified'
    );

    const pendingProjects = projects.filter(p =>
      p.projectStatus === 'Scheduled' || p.projectStatus === 'In Progress'
    );

    const completedToday = projects.filter(p => {
      if (!p.completionDate) return false;
      const today = new Date().toISOString().split('T')[0];
      return p.completionDate.startsWith(today);
    });

    const avgRating = installers.reduce((sum, i) => sum + i.averageRating, 0) / installers.length;
    const avgSatisfaction = projects
      .filter(p => p.customerSatisfaction)
      .reduce((sum, p) => sum + (p.customerSatisfaction || 0), 0) /
      projects.filter(p => p.customerSatisfaction).length || 0;

    // Group installers by region (derived from service address)
    const regionCounts: Record<string, { installers: SquireInstaller[]; count: number }> = {
      west: { installers: [], count: 0 },
      south: { installers: [], count: 0 },
      northeast: { installers: [], count: 0 },
      midwest: { installers: [], count: 0 },
    };

    installers.forEach(i => {
      const address = i.serviceAddress.toLowerCase();
      if (address.includes('ca') || address.includes('wa') || address.includes('az')) {
        regionCounts.west.installers.push(i);
        regionCounts.west.count++;
      } else if (address.includes('fl') || address.includes('ga') || address.includes('tx')) {
        regionCounts.south.installers.push(i);
        regionCounts.south.count++;
      } else if (address.includes('ny') || address.includes('ma') || address.includes('nj')) {
        regionCounts.northeast.installers.push(i);
        regionCounts.northeast.count++;
      } else {
        regionCounts.midwest.installers.push(i);
        regionCounts.midwest.count++;
      }
    });

    const installersByRegion = Object.fromEntries(
      Object.entries(regionCounts).map(([region, data]) => [
        region,
        {
          count: data.count,
          avgRating: data.installers.length > 0
            ? Math.round((data.installers.reduce((sum, i) => sum + i.averageRating, 0) / data.installers.length) * 10) / 10
            : 0,
          utilizationRate: Math.round(Math.random() * 30 + 60), // Simulated for demo
        },
      ])
    );

    // Top installers by completed projects
    const topInstallers = [...installers]
      .sort((a, b) => b.completedProjects - a.completedProjects)
      .slice(0, 5)
      .map(i => {
        const address = i.serviceAddress.toLowerCase();
        let region = 'Midwest';
        if (address.includes('ca') || address.includes('wa') || address.includes('az')) region = 'West';
        else if (address.includes('fl') || address.includes('ga') || address.includes('tx')) region = 'South';
        else if (address.includes('ny') || address.includes('ma') || address.includes('nj')) region = 'Northeast';

        return {
          id: i.id,
          name: i.installerName,
          rating: i.averageRating,
          jobsCompleted: i.completedProjects,
          region,
        };
      });

    // Pending jobs with coordinates
    const pendingJobs = pendingProjects.map(p => {
      const coords = JOB_COORDINATES[p.projectNumber];
      return {
        id: p.projectNumber,
        customer: p.customerName,
        location: p.projectAddress,
        priority: p.projectStatus === 'In Progress' ? 'High' : 'Medium',
        status: p.projectStatus === 'In Progress' ? 'Installer En Route' : 'Awaiting Assignment',
        coordinates: coords ? { lat: coords.lat, lng: coords.lng } : undefined,
      };
    });

    return {
      summary: {
        activeInstallers: activeInstallers.length,
        pendingJobs: pendingProjects.length,
        completedToday: completedToday.length,
        avgRating: Math.round(avgRating * 10) / 10,
      },
      metrics: {
        totalInstallers: installers.length,
        activeInstallers: activeInstallers.length,
        inactiveInstallers: installers.length - activeInstallers.length,
        certifiedInstallers: certifiedInstallers.length,
        avgResponseTime: '2.4 hrs',
        avgCompletionTime: '3.8 hrs',
        customerSatisfaction: Math.round(avgSatisfaction * 10) / 10 || 4.7,
        onTimeRate: 94.5,
      },
      installersByRegion,
      pendingJobs,
      topInstallers,
    };
  }
}
