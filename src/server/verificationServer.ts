import express from 'express';
import http from 'node:http';
import { verificationOnlyGate } from './verificationGate';
import type { DatabaseService } from '../database/DatabaseService';

export async function startVerificationServer(database: DatabaseService, port: number): Promise<{ server: http.Server; close: () => Promise<void> }> {
  const app = express();
  app.use(verificationOnlyGate);
  const healthy = { status: 'healthy' as const };
  app.get('/health', (_req, res) => res.status(200).json(healthy));
  app.get(['/health/ready', '/ready'], (_req, res) => res.status(200).json({ status: 'ready' }));
  app.get('/health/live', (_req, res) => res.status(200).json({ status: 'live' }));
  const server = await new Promise<http.Server>((resolve, reject) => {
    const listener = app.listen(port, () => resolve(listener));
    listener.once('error', reject);
  });
  return {
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await database.shutdown();
    },
  };
}
