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
 * SuiteCentralConnector is a mock connector that stores data in memory. It
 * demonstrates the standard connector structure including CRUD operations,
 * basic search, optional webhook registration and change tracking.
 */
@injectable()
export class SuiteCentralConnector extends MockConnectorBase {
  static readonly productionStatus = 'demo_only' as const;
  static readonly statusEvidence = 'In-process MockConnectorBase backed by JSON fixtures (customers/vendors/products/orders); demo path only — production NetSuite-native variant lives in SuiteCentralProductionConnector.ts';

  constructor(
    @unmanaged() systemType = 'SuiteCentral',
    @unmanaged() systemId = 'suitecentral',
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.AuthService) authService: AuthService,
    @unmanaged() circuitBreakerOptions?: Partial<CircuitBreakerOptions>,
  ) {
    super(systemType, systemId, logger, authService, circuitBreakerOptions);
  }

  protected getDefaultBaseUrl(): string {
    return 'https://api.suitecentral.mock';
  }

  protected async seedData(): Promise<void> {
    try {
      // Clear existing data
      this.dataStore.clear();
      const customers = customerFixtures.suiteCentral;
      const vendors = vendorFixtures.suiteCentral;
      const products = productFixtures.suiteCentral;
      const orders = orderFixtures.suiteCentral;

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

      this.logger.info('SuiteCentral realistic business data seeded', {
        customers: customers.length,
        vendors: vendors.length,
        products: products.length,
        orders: orders.length,
      });
    } catch (error) {
      this.logger.warn('Failed to seed SuiteCentral business data', { error: (error as Error).message });
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    await this.ensureAuthenticated();
    return {
      name: 'SuiteCentral Mock',
      type: 'SuiteCentral',
      version: '1.0',
      capabilities: ['customers', 'vendors', 'orders', 'bulk_operations', 'mock_endpoints'],
      rateLimits: {
        requestsPerMinute: 1000,
        requestsPerHour: 60000,
        requestsPerDay: 1000000,
      },
      endpoints: {
        baseUrl: this.httpClient.defaults.baseURL || this.baseUrl,
        authUrl: `${this.baseUrl}/auth`,
        webhookUrl: `${this.baseUrl}/webhooks`,
      },
    };
  }
}

export default SuiteCentralConnector;
