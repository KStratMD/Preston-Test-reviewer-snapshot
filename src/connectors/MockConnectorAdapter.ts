/**
 * Mock Connector Adapter
 *
 * Enables testing of "planned" connectors using realistic fixture data.
 * Proves the abstraction layer works - swapping fixture → real API is mechanical.
 *
 * This is a lightweight mock connector that doesn't require dependency injection
 * or full BaseConnector infrastructure. It's designed for testing and demos.
 */

import { loadFixture, getAvailableFixtures, SystemId, EntityType } from './fixtures';
import { logger } from '../utils/Logger';

export class MockConnectorAdapter {
  private systemId: SystemId;
  private fixtures = new Map<EntityType, unknown[]>();
  private initialized = false;

  constructor(systemId: SystemId) {
    this.systemId = systemId;
  }

  /**
   * Initialize connector by pre-loading all available fixtures
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const availableTypes = await getAvailableFixtures(this.systemId);

    for (const entityType of availableTypes) {
      const data = await loadFixture(entityType, this.systemId);
      this.fixtures.set(entityType, data);
    }

    this.initialized = true;
    logger.info(`MockConnectorAdapter initialized for ${this.systemId}:`, {
      fixturesLoaded: availableTypes.length,
      types: availableTypes
    });
  }

  /**
   * List customers from fixture data
   */
  async listCustomers(): Promise<unknown[]> {
    await this.ensureInitialized();
    return this.fixtures.get('customers') || [];
  }

  /**
   * Get single customer by ID
   */
  async getCustomer(id: string): Promise<unknown | null> {
    const customers = await this.listCustomers();
    return customers.find((c: unknown) =>
      (c as any).id === id || (c as any).Id === id || (c as any).customer_id === id
    ) || null;
  }

  /**
   * Create customer (mock - returns data with generated ID)
   */
  async createCustomer(data: unknown): Promise<unknown> {
    await this.ensureInitialized();
    this.validateRequiredFields(data, ['email'], 'customer');

    return {
      id: this.generateMockId(),
      ...(data as any),
      _mock: true,
      _created: new Date().toISOString()
    };
  }

  /**
   * List products from fixture data
   */
  async listProducts(): Promise<unknown[]> {
    await this.ensureInitialized();
    return this.fixtures.get('products') || [];
  }

  /**
   * List orders from fixture data
   */
  async listOrders(): Promise<unknown[]> {
    await this.ensureInitialized();
    return this.fixtures.get('orders') || [];
  }

  /**
   * Get single order by ID
   */
  async getOrder(id: string): Promise<unknown | null> {
    const orders = await this.listOrders();
    return orders.find((o: unknown) =>
      (o as any).id === id || (o as any).Id === id || String((o as any).order_number) === id || (o as any).order_number === parseInt(id)
    ) || null;
  }

  /**
   * List vendors from fixture data
   */
  async listVendors(): Promise<unknown[]> {
    await this.ensureInitialized();
    return this.fixtures.get('vendors') || [];
  }

  /**
   * List invoices from fixture data
   */
  async listInvoices(): Promise<unknown[]> {
    await this.ensureInitialized();
    return this.fixtures.get('invoices') || [];
  }

  /**
   * List inventory from fixture data
   */
  async listInventory(): Promise<unknown[]> {
    await this.ensureInitialized();
    return this.fixtures.get('inventory') || [];
  }

  /**
   * Test connection (succeeds only if fixture data is properly loaded)
   */
  async testConnection(): Promise<{ success: boolean; message: string; details?: unknown }> {
    try {
      await this.ensureInitialized();

      const fixtureCount = Array.from(this.fixtures.values())
        .reduce((sum, arr) => sum + arr.length, 0);

      // Fail if no fixtures were loaded
      if (this.fixtures.size === 0 || fixtureCount === 0) {
        return {
          success: false,
          message: `Mock connector for ${this.systemId} failed: No fixture data available`,
          details: {
            systemId: this.systemId,
            fixturesLoaded: 0,
            totalRecords: 0,
            error: 'No fixture data found. Fixture files may be missing or corrupted.',
            connectionType: 'demo',
            note: 'Demo mode requires fixture data files'
          }
        };
      }

      return {
        success: true,
        message: `Mock connector for ${this.systemId} connected successfully`,
        details: {
          systemId: this.systemId,
          fixturesLoaded: this.fixtures.size,
          totalRecords: fixtureCount,
          availableTypes: Array.from(this.fixtures.keys()),
          connectionType: 'demo',
          note: 'Using fixture data - no real API credentials required'
        }
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        message: `Mock connector for ${this.systemId} failed: ${err.message}`,
        details: {
          systemId: this.systemId,
          error: err.message,
          connectionType: 'demo'
        }
      };
    }
  }

  /**
   * Get connector metadata
   */
  getMetadata(): unknown {
    return {
      systemId: this.systemId,
      type: 'mock',
      status: 'planned',
      dataSource: 'fixtures',
      availableOperations: [
        'listCustomers',
        'getCustomer',
        'createCustomer',
        'listProducts',
        'listOrders',
        'getOrder',
        'listVendors',
        'listInvoices',
        'listInventory',
        'testConnection'
      ],
      note: 'Mock connector using realistic fixture data. Swap to real API by implementing authentication and API calls.'
    };
  }

  // Private helpers

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private validateRequiredFields(data: unknown, requiredFields: string[], entityType: string): void {
    const missing = requiredFields.filter(field => !(data as Record<string, unknown>)[field]);

    if (missing.length > 0) {
      throw new Error(
        `Missing required field${missing.length > 1 ? 's' : ''} for ${entityType}: ${missing.join(', ')}`
      );
    }
  }

  private generateMockId(): string {
    return `MOCK_${this.systemId.toUpperCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
  }
}
