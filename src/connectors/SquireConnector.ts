import { injectable, inject, unmanaged } from 'inversify';
import { MockConnectorBase } from './MockConnectorBase';
import type { SystemInfo } from '../types';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import type { CircuitBreakerOptions } from '../utils/CircuitBreaker';
import { TYPES } from '../inversify/types';
import customerFixtures from './fixtures/customers.json';
import vendorFixtures from './fixtures/vendors.json';
import productFixtures from './fixtures/products.json';
import orderFixtures from './fixtures/orders.json';

/**
 * SquireConnector is a lightweight mock connector that keeps data in memory.
 * It mirrors the behavior of a real connector with CRUD operations, search,
 * change tracking and webhook registration.
 */
@injectable()
export class SquireConnector extends MockConnectorBase {
  static readonly productionStatus = 'demo_only' as const;
  static readonly statusEvidence = 'In-process MockConnectorBase backed by JSON fixtures (customers/vendors/products/orders); no real HTTP path';

  constructor(
    @unmanaged() systemType = 'Squire',
    @unmanaged() systemId = 'squire',
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.AuthService) authService: AuthService,
    @unmanaged() circuitBreakerOptions?: Partial<CircuitBreakerOptions>,
  ) {
    super(systemType, systemId, logger, authService, circuitBreakerOptions);
  }

  protected getDefaultBaseUrl(): string {
    return 'https://api.squire.mock';
  }

  protected async seedData(): Promise<void> {
    try {
      // Clear existing data
      this.dataStore.clear();
      const customers = customerFixtures.squire;
      const vendors = vendorFixtures.squire;
      const products = productFixtures.squire;
      const orders = orderFixtures.squire;

      const customerStore = this.getEntityStore('customer');
      customers.forEach(customer => {
        customerStore.set(customer.id, customer as any);
      });

      const contactStore = this.getEntityStore('contact');
      vendors.forEach(vendor => {
        contactStore.set(vendor.id, vendor as any);
      });

      const productStore = this.getEntityStore('product');
      products.forEach(product => {
        productStore.set(product.id, product as any);
      });

      const orderStore = this.getEntityStore('order');
      orders.forEach(order => {
        orderStore.set(order.id, order as any);
      });

      this.logger.info('Squire realistic business data seeded', {
        customers: customers.length,
        vendors: vendors.length,
        products: products.length,
        orders: orders.length,
      });
    } catch (error) {
      this.logger.warn('Failed to seed Squire business data', { error: (error as Error).message });
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    await this.ensureAuthenticated();
    return {
      name: 'Squire Mock',
      type: 'Squire',
      version: '1.0',
      capabilities: ['customers', 'vendors', 'orders', 'bulk_operations', 'mock_endpoints'],
      rateLimits: {
        requestsPerMinute: 1000,
        requestsPerHour: 60000,
        requestsPerDay: 100000,
      },
      endpoints: {
        baseUrl: this.httpClient.defaults.baseURL || this.baseUrl,
        authUrl: this.baseUrl,
        webhookUrl: `${this.baseUrl}/webhooks`,
      },
    };
  }
}

export default SquireConnector;
