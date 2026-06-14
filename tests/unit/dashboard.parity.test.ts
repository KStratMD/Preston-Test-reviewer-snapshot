// This test uses real timers because it initializes the full app which uses setInterval
jest.useRealTimers();

import request from 'supertest';
import http from 'http';
import { createApp } from './index';

// Basic shape validators (lightweight, avoid adding zod dependency already present though)
function expectNumber(n: any){ expect(typeof n).toBe('number'); }
function expectString(s: any){ expect(typeof s).toBe('string'); }

const endpoints = [
  { path: '/api/dashboard/api/summary', validate: (body:any)=>{
      expectNumber(body.activeIntegrations); expectNumber(body.recordsProcessed); expectNumber(body.avgResponse); }
  },
  { path: '/api/dashboard/api/recent-activity', validate: (body:any)=>{
      expect(Array.isArray(body.items)).toBe(true); }
  },
  { path: '/api/dashboard/api/ai-metrics', validate: (body:any)=>{
      expectString(body.provider); expectNumber(body.avgLatencyMs); expectNumber(body.mappingAccuracy); }
  },
  { path: '/api/dashboard/api/queues', validate: (body:any)=>{ expect(Array.isArray(body.queues)).toBe(true); } },
  { path: '/api/dashboard/api/traces', validate: (body:any)=>{ expect(Array.isArray(body.spans)).toBe(true); } },
  { path: '/api/dashboard/api/credentials', validate: (body:any)=>{ expect(Array.isArray(body.providers)).toBe(true); } },
  { path: '/api/dashboard/api/metrics-json', validate: (body:any)=>{ expect(Array.isArray(body.metrics)).toBe(true); } },
  { path: '/api/dashboard/api/export', validate: (body:any)=>{ expect(body.summary).toBeDefined(); expect(Array.isArray(body.recentActivity)).toBe(true); } },
];

// Helper to spin server with optional env overrides
async function startServer(env: Record<string,string|undefined>){
  process.env.DISABLE_REDIS = env.DISABLE_REDIS;
  process.env.ENABLE_DASHBOARD_TEST = '1';
  process.env.DASHBOARD_DISABLE_INTERVALS = '1';
  process.env.JWT_SECRET = 'test-secret';
  const serverInstance = await createApp();
  const app = serverInstance.getExpressApp();
  const server = http.createServer(app);
  await new Promise<void>(resolve=>server.listen(0, ()=>resolve()));
  const address = server.address();
  if(typeof address !== 'object' || !address) throw new Error('No address');
  const base = `http://127.0.0.1:${address.port}`;
  return { server, base, app: serverInstance };
}

async function runSuite(disableRedis: boolean){
  const { server, base, app } = await startServer({ DISABLE_REDIS: disableRedis? '1': undefined });
  try {
    for (const ep of endpoints){
      const res = await request(base).get(ep.path).expect(200);
      ep.validate(res.body);
    }
  } finally {
    await new Promise(res=>server.close(res));
    if (app.application.securityMiddleware && typeof app.application.securityMiddleware.cleanup === 'function') {
      app.application.securityMiddleware.cleanup();
    }
  }
}

describe('Dashboard parity endpoints', () => {
  it('no-redis mode', async () => { await runSuite(true); });
  it('default mode', async () => { await runSuite(false); });
});
