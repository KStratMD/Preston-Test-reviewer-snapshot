import request from 'supertest';
import { App } from '../../src/app';

async function main() {
  const app = new App({ lightweight: true });
  const server = app.getExpressApp();

  try {
    const res = await request(server).post('/api/suitecentral/sync').send({});
    if (!res.body) throw new Error('No body returned');
    if (typeof res.body.processingMs !== 'number') throw new Error('processingMs missing or not a number');
    if (typeof res.body.processingTime !== 'string') throw new Error('processingTime missing or not a string');
    console.log('Unit test passed: processing fields present');
    await app.shutdown();
    process.exit(0);
  } catch (err) {
    console.error('Unit test failed:', err);
    try { await app.shutdown(); } catch (_) {}
    process.exit(1);
  }
}

void main();
