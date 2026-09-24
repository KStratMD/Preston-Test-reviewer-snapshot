import { Router } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { ConnectorCredentialRouter } from './ConnectorCredentialRouter';

/**
 * Factory function to create connector credential router
 *
 * Retrieves ConnectorCredentialRouter from DI container and returns Express router
 */
export async function createConnectorCredentialRouter(): Promise<Router> {
  const credentialRouter = container.get<ConnectorCredentialRouter>(ConnectorCredentialRouter);
  return credentialRouter.router;
}
