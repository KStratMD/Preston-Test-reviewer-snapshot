/**
 * InstallerCentralService Tests
 * Tests for Haversine distance calculation, proximity matching, and NetSuite SO linking
 */

import { InstallerCentralService } from '../../../../src/services/InstallerCentralService';
import type { Logger } from '../../../../src/utils/Logger';
import type { InstallerProximityRequest, JobLocation } from '../../../../src/services/InstallerCentralService';

// Create mocks
function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<Logger>;
}

describe('InstallerCentralService', () => {
  let service: InstallerCentralService;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    service = new InstallerCentralService(mockLogger);
  });

  describe('Initialization', () => {
    it('should initialize successfully', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('InstallerCentralService initialized');
    });
  });

  describe('Haversine Distance Calculation', () => {
    // Known distances for validation (verified against Google Maps)
    const KNOWN_DISTANCES = [
      {
        name: 'New York to Los Angeles',
        from: { lat: 40.7128, lng: -74.0060 },
        to: { lat: 34.0522, lng: -118.2437 },
        expectedMiles: 2451, // ~2451 miles
        tolerance: 50, // Allow 2% tolerance
      },
      {
        name: 'San Francisco to Seattle',
        from: { lat: 37.7749, lng: -122.4194 },
        to: { lat: 47.6062, lng: -122.3321 },
        expectedMiles: 679, // ~679 miles
        tolerance: 15,
      },
      {
        name: 'Miami to Atlanta',
        from: { lat: 25.7617, lng: -80.1918 },
        to: { lat: 33.7490, lng: -84.3880 },
        expectedMiles: 604, // ~604 miles
        tolerance: 15,
      },
      {
        name: 'Same location (zero distance)',
        from: { lat: 40.7128, lng: -74.0060 },
        to: { lat: 40.7128, lng: -74.0060 },
        expectedMiles: 0,
        tolerance: 0.01,
      },
      {
        name: 'Denver to Phoenix',
        from: { lat: 39.7392, lng: -104.9903 },
        to: { lat: 33.4484, lng: -112.0740 },
        expectedMiles: 586, // ~586 miles
        tolerance: 15,
      },
    ];

    test.each(KNOWN_DISTANCES)(
      'should calculate correct distance for $name',
      ({ from, to, expectedMiles, tolerance }) => {
        const distance = service.calculateHaversineDistance(
          from.lat,
          from.lng,
          to.lat,
          to.lng
        );
        expect(distance).toBeGreaterThanOrEqual(expectedMiles - tolerance);
        expect(distance).toBeLessThanOrEqual(expectedMiles + tolerance);
      }
    );

    it('should be within 5% of Google Maps distances', () => {
      // Los Angeles to Atlanta
      const distance = service.calculateHaversineDistance(34.0522, -118.2437, 33.7490, -84.3880);
      const expectedDistance = 1940; // Google Maps: ~1940 miles
      const percentageDiff = Math.abs(distance - expectedDistance) / expectedDistance * 100;
      expect(percentageDiff).toBeLessThan(5);
    });

    it('should be symmetric (A to B = B to A)', () => {
      const d1 = service.calculateHaversineDistance(40.7128, -74.0060, 34.0522, -118.2437);
      const d2 = service.calculateHaversineDistance(34.0522, -118.2437, 40.7128, -74.0060);
      expect(d1).toBeCloseTo(d2, 6);
    });

    it('should handle edge cases', () => {
      // North Pole to South Pole (approx half earth circumference)
      const polarDistance = service.calculateHaversineDistance(90, 0, -90, 0);
      expect(polarDistance).toBeGreaterThan(12000); // ~12,430 miles
      expect(polarDistance).toBeLessThan(13000);
    });
  });

  describe('Proximity Matching', () => {
    const createJobLocation = (overrides: Partial<JobLocation> = {}): JobLocation => ({
      jobId: 'JOB-TEST-001',
      customerName: 'Test Customer',
      address: '123 Test St, Test City, TX',
      latitude: 33.4484, // Phoenix, AZ
      longitude: -112.0740,
      priority: 'medium',
      estimatedHours: 8,
      ...overrides,
    });

    it('should find nearest installers sorted by match score', async () => {
      const request: InstallerProximityRequest = {
        jobLocation: createJobLocation(),
        maxDistanceMiles: 1000,
        maxResults: 10,
      };

      const result = await service.findNearestInstallers(request);

      expect(result.jobId).toBe('JOB-TEST-001');
      expect(result.matchingInstallers).toBeDefined();
      expect(Array.isArray(result.matchingInstallers)).toBe(true);

      // Should be sorted by matchScore descending
      for (let i = 1; i < result.matchingInstallers.length; i++) {
        expect(result.matchingInstallers[i - 1].matchScore)
          .toBeGreaterThanOrEqual(result.matchingInstallers[i].matchScore);
      }
    });

    it('should respect maxDistanceMiles filter', async () => {
      const request: InstallerProximityRequest = {
        jobLocation: createJobLocation({
          latitude: 33.7490, // Atlanta
          longitude: -84.3880,
        }),
        maxDistanceMiles: 100, // Very restrictive
        maxResults: 10,
      };

      const result = await service.findNearestInstallers(request);

      // All returned installers should be within max distance
      for (const installer of result.matchingInstallers) {
        expect(installer.distanceMiles).toBeLessThanOrEqual(100);
      }
    });

    it('should respect maxResults limit', async () => {
      const request: InstallerProximityRequest = {
        jobLocation: createJobLocation(),
        maxDistanceMiles: 5000,
        maxResults: 2,
      };

      const result = await service.findNearestInstallers(request);
      expect(result.matchingInstallers.length).toBeLessThanOrEqual(2);
    });

    it('should filter by minimum rating', async () => {
      const request: InstallerProximityRequest = {
        jobLocation: createJobLocation(),
        maxDistanceMiles: 5000,
        minRating: 4.8,
      };

      const result = await service.findNearestInstallers(request);

      for (const installer of result.matchingInstallers) {
        expect(installer.rating).toBeGreaterThanOrEqual(4.8);
      }
    });

    it('should filter by availability when required', async () => {
      const request: InstallerProximityRequest = {
        jobLocation: createJobLocation(),
        maxDistanceMiles: 5000,
        requiredAvailability: true,
      };

      const result = await service.findNearestInstallers(request);

      for (const installer of result.matchingInstallers) {
        expect(installer.availability).toBe('available');
      }
    });

    it('should include match score breakdown', async () => {
      const request: InstallerProximityRequest = {
        jobLocation: createJobLocation(),
        maxDistanceMiles: 5000,
        maxResults: 1,
      };

      const result = await service.findNearestInstallers(request);

      if (result.matchingInstallers.length > 0) {
        const breakdown = result.matchingInstallers[0].matchBreakdown;
        expect(breakdown).toBeDefined();
        expect(breakdown.distanceScore).toBeGreaterThanOrEqual(0);
        expect(breakdown.distanceScore).toBeLessThanOrEqual(40);
        expect(breakdown.ratingScore).toBeGreaterThanOrEqual(0);
        expect(breakdown.ratingScore).toBeLessThanOrEqual(25);
        expect(breakdown.certificationScore).toBeGreaterThanOrEqual(0);
        expect(breakdown.certificationScore).toBeLessThanOrEqual(20);
        expect(breakdown.availabilityScore).toBeGreaterThanOrEqual(0);
        expect(breakdown.availabilityScore).toBeLessThanOrEqual(15);

        // Total should equal sum of parts
        const expectedTotal =
          breakdown.distanceScore +
          breakdown.ratingScore +
          breakdown.certificationScore +
          breakdown.availabilityScore;
        expect(result.matchingInstallers[0].matchScore).toBeCloseTo(expectedTotal, 1);
      }
    });

    it('should log telemetry for proximity searches', async () => {
      const request: InstallerProximityRequest = {
        jobLocation: createJobLocation(),
        maxDistanceMiles: 1000,
      };

      await service.findNearestInstallers(request);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Installer proximity search telemetry',
        expect.objectContaining({
          jobId: 'JOB-TEST-001',
          searchRadius: 1000,
        })
      );
    });

    it('should complete search in under 500ms for reasonable dataset', async () => {
      const request: InstallerProximityRequest = {
        jobLocation: createJobLocation(),
        maxDistanceMiles: 5000,
        maxResults: 100,
      };

      const startTime = Date.now();
      await service.findNearestInstallers(request);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(500);
    });
  });

  describe('Installer Availability', () => {
    it('should return availability for valid installer', async () => {
      const availability = await service.getInstallerAvailability('SQ_INST_001');

      expect(availability).not.toBeNull();
      expect(availability!.installerId).toBe('SQ_INST_001');
      expect(['available', 'busy', 'unavailable']).toContain(availability!.status);
      expect(availability!.weeklySchedule).toBeDefined();
      expect(availability!.weeklySchedule.length).toBeGreaterThan(0);
    });

    it('should return null for non-existent installer', async () => {
      const availability = await service.getInstallerAvailability('INVALID-ID');
      expect(availability).toBeNull();
    });

    it('should include booked jobs in availability', async () => {
      const availability = await service.getInstallerAvailability('SQ_INST_002');

      expect(availability).not.toBeNull();
      expect(availability!.bookedJobs).toBeDefined();
      expect(Array.isArray(availability!.bookedJobs)).toBe(true);
    });
  });

  describe('Job Assignment', () => {
    it('should successfully assign installer to job', async () => {
      const result = await service.assignInstallerToJob({
        jobId: 'JOB-TEST-001',
        installerId: 'SQ_INST_001',
        scheduledDate: '2024-09-15',
        estimatedHours: 8,
      });

      expect(result.success).toBe(true);
      expect(result.jobId).toBe('JOB-TEST-001');
      expect(result.installerId).toBe('SQ_INST_001');
      expect(result.assignmentId).toBeDefined();
      expect(result.scheduledDate).toBe('2024-09-15');
    });

    it('should fail for non-existent installer', async () => {
      const result = await service.assignInstallerToJob({
        jobId: 'JOB-TEST-001',
        installerId: 'INVALID-INSTALLER',
        scheduledDate: '2024-09-15',
        estimatedHours: 8,
      });

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('not found');
    });

    it('should log telemetry for assignments', async () => {
      await service.assignInstallerToJob({
        jobId: 'JOB-TEST-001',
        installerId: 'SQ_INST_001',
        scheduledDate: '2024-09-15',
        estimatedHours: 8,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Installer job assigned telemetry',
        expect.objectContaining({
          jobId: 'JOB-TEST-001',
          installerId: 'SQ_INST_001',
        })
      );
    });
  });

  describe('NetSuite Sales Order Linking', () => {
    it('should successfully link job to NetSuite SO', async () => {
      const result = await service.linkToNetSuiteSalesOrder({
        jobId: 'JOB-TEST-001',
        installerId: 'SQ_INST_001',
        netSuiteSalesOrderId: 'NS-SO-12345',
        projectValue: 15000,
        commissionRate: 0.12,
      });

      expect(result.success).toBe(true);
      expect(result.jobId).toBe('JOB-TEST-001');
      expect(result.netSuiteSalesOrderId).toBe('NS-SO-12345');
      expect(result.linkId).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });

    it('should fail for non-existent installer', async () => {
      const result = await service.linkToNetSuiteSalesOrder({
        jobId: 'JOB-TEST-001',
        installerId: 'INVALID-INSTALLER',
        netSuiteSalesOrderId: 'NS-SO-12345',
        projectValue: 15000,
        commissionRate: 0.12,
      });

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('not found');
    });

    it('should log telemetry for NetSuite linking', async () => {
      await service.linkToNetSuiteSalesOrder({
        jobId: 'JOB-TEST-001',
        installerId: 'SQ_INST_001',
        netSuiteSalesOrderId: 'NS-SO-12345',
        projectValue: 15000,
        commissionRate: 0.12,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'NetSuite SO linked telemetry',
        expect.objectContaining({
          jobId: 'JOB-TEST-001',
          netSuiteSalesOrderId: 'NS-SO-12345',
          projectValue: 15000,
          commissionRate: 0.12,
        })
      );
    });
  });

  describe('Installer Locations', () => {
    it('should return all installer locations', () => {
      const locations = service.getInstallerLocations();

      expect(locations).toBeDefined();
      expect(Array.isArray(locations)).toBe(true);
      expect(locations.length).toBeGreaterThan(0);

      // Each location should have required fields
      for (const loc of locations) {
        expect(loc.installerId).toBeDefined();
        expect(loc.name).toBeDefined();
        expect(loc.latitude).toBeDefined();
        expect(loc.longitude).toBeDefined();
        expect(loc.workingRadius).toBeDefined();
      }
    });
  });

  describe('Dashboard Metrics', () => {
    it('should return dashboard metrics', async () => {
      const metrics = await service.getDashboardMetrics();

      expect(metrics.summary).toBeDefined();
      expect(metrics.summary.activeInstallers).toBeGreaterThanOrEqual(0);
      expect(metrics.summary.pendingJobs).toBeGreaterThanOrEqual(0);
      expect(metrics.summary.avgRating).toBeGreaterThanOrEqual(0);
      expect(metrics.summary.avgRating).toBeLessThanOrEqual(5);

      expect(metrics.metrics).toBeDefined();
      expect(metrics.installersByRegion).toBeDefined();
      expect(metrics.topInstallers).toBeDefined();
      expect(metrics.pendingJobs).toBeDefined();
    });

    it('should group installers by region', async () => {
      const metrics = await service.getDashboardMetrics();

      // Should have at least some regions
      const regions = Object.keys(metrics.installersByRegion);
      expect(regions.length).toBeGreaterThan(0);

      // Each region should have valid data
      for (const region of regions) {
        const data = metrics.installersByRegion[region];
        expect(data.count).toBeGreaterThanOrEqual(0);
        expect(data.avgRating).toBeGreaterThanOrEqual(0);
        expect(data.utilizationRate).toBeGreaterThanOrEqual(0);
        expect(data.utilizationRate).toBeLessThanOrEqual(100);
      }
    });

    it('should return top installers sorted by completed projects', async () => {
      const metrics = await service.getDashboardMetrics();

      const topInstallers = metrics.topInstallers;
      expect(topInstallers.length).toBeLessThanOrEqual(5);

      // Should be sorted by jobsCompleted descending
      for (let i = 1; i < topInstallers.length; i++) {
        expect(topInstallers[i - 1].jobsCompleted)
          .toBeGreaterThanOrEqual(topInstallers[i].jobsCompleted);
      }
    });
  });
});
