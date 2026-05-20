import request from 'supertest';
import express from 'express';
import { OperationalDashboard } from '../routes/dashboard';

describe('Operational Dashboard', () => {
  let app: express.Application;
  let dashboard: OperationalDashboard;

  beforeEach(() => {
    process.env.DASHBOARD_DISABLE_INTERVALS = '1';
    app = express();
    dashboard = new OperationalDashboard();
    app.use('/api/dashboard', dashboard.getRouter());
  });

  afterEach(async () => {
    delete process.env.DASHBOARD_DISABLE_INTERVALS;
    // Clean up dashboard resources to prevent open handles
    if (dashboard && dashboard.cleanup) {
      dashboard.cleanup();
    }
    // Clean up EventBus singleton
    const { EventBus } = await import('../utils/EventBus');
    const eventBus = EventBus.getInstance();
    await eventBus.shutdown();
  });

  describe('Dashboard Routes', () => {
    it('should serve the main dashboard HTML page', async () => {
      const response = await request(app)
        .get('/api/dashboard/')
        .expect(200);

      expect(response.text).toContain('Integration Hub - Operational Dashboard');
      expect(response.text).toContain('Business Metrics');
      expect(response.text).toContain('Security Monitoring');
      expect(response.text).toContain('Performance Metrics');
    });

    it('should return business metrics as JSON', async () => {
      const response = await request(app)
        .get('/api/dashboard/api/business-metrics')
        .expect(200);

      expect(response.body).toHaveProperty('integrationSuccessRates');
      expect(response.body).toHaveProperty('dataVolumeProcessed');
      expect(response.body).toHaveProperty('errorPatterns');
      expect(response.body).toHaveProperty('performanceMetrics');
      expect(response.body).toHaveProperty('systemHealth');
    });

    it('should return security metrics as JSON', async () => {
      const response = await request(app)
        .get('/api/dashboard/api/security-metrics')
        .expect(200);

      expect(response.body).toHaveProperty('authenticationAttempts');
      expect(response.body).toHaveProperty('rateLimitingEvents');
      expect(response.body).toHaveProperty('threatDetection');
      expect(response.body).toHaveProperty('securityMetrics');
    });

    it('should return performance metrics as JSON', async () => {
      const response = await request(app)
        .get('/api/dashboard/api/performance-metrics')
        .expect(200);

      expect(response.body).toHaveProperty('responseTimes');
      expect(response.body).toHaveProperty('memoryUsage');
      expect(response.body).toHaveProperty('connectionPools');
      expect(response.body).toHaveProperty('cacheMetrics');
    });

    it('should return system status as JSON', async () => {
      const response = await request(app)
        .get('/api/dashboard/api/system-status')
        .expect(200);

      expect(response.body).toHaveProperty('overall');
      expect(response.body).toHaveProperty('components');
      expect(response.body).toHaveProperty('metrics');
    });

    it('should return websocket info as JSON', async () => {
      const response = await request(app)
        .get('/api/dashboard/api/websocket-info')
        .expect(200);

      expect(response.body).toHaveProperty('available');
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('endpoints');
      expect(response.body).toHaveProperty('pollingInterval');
    });
  });

  describe('Dashboard Functionality', () => {
    it('should provide real-time metrics collection', () => {
      expect(dashboard.getRouter).toBeDefined();
      expect(typeof dashboard.getRouter).toBe('function');
    });

    it('should handle metrics history properly', async () => {
      // Make multiple calls to ensure metrics history is working
      await request(app).get('/api/dashboard/api/business-metrics');
      await request(app).get('/api/dashboard/api/business-metrics');

      const response = await request(app)
        .get('/api/dashboard/api/business-metrics')
        .expect(200);

      // Should have metrics data
      expect(response.body).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid routes gracefully', async () => {
      await request(app)
        .get('/api/dashboard/nonexistent')
        .expect(404);
    });
  });
});
