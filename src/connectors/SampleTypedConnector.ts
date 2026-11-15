import { injectable } from 'inversify';
import { MockConnectorBase } from './MockConnectorBase';
import type { Customer, Order, Product, EntityTypeMap, BaseEntity } from '../types/entities';
import type { SystemInfo } from '../types';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import type { CircuitBreakerOptions } from '../utils/CircuitBreaker';

/**
 * Sample entity map for demonstration
 */
interface SampleEntityMap extends Record<string, BaseEntity> {
  customer: Customer;
  order: Order;
  product: Product;
}

/**
 * Sample typed connector demonstrating the new type-safe MockConnectorBase
 */
@injectable()
export class SampleTypedConnector extends MockConnectorBase<SampleEntityMap> {
  static readonly productionStatus = 'demo_only' as const;
  static readonly statusEvidence = 'Template/scaffold demonstrating type-safe MockConnectorBase pattern; in-process mock CRUD against fictitious api.sample.com; not wired to any real system';

  constructor(
    logger: Logger,
    authService: AuthService,
    circuitBreakerOptions?: Partial<CircuitBreakerOptions>,
  ) {
    super('Sample', 'sample-typed', logger, authService, circuitBreakerOptions);
  }

  protected getDefaultBaseUrl(): string {
    return 'https://api.sample.com';
  }

  protected async seedData(): Promise<void> {
    // Type-safe seed data creation
    await this.create('customer', {
      name: 'Acme Corporation',
      email: 'contact@acme.com',
      phone: '+1-555-0123',
      status: 'active',
      customerType: 'business',
      creditLimit: 50000,
      address: {
        street: '123 Business Ave',
        city: 'New York',
        state: 'NY',
        zipCode: '10001',
        country: 'USA',
      },
    });

    await this.create('product', {
      name: 'Premium Widget',
      description: 'High-quality widget for enterprise use',
      sku: 'WIDGET-001',
      price: 99.99,
      currency: 'USD',
      category: 'Widgets',
      status: 'active',
      inventory: {
        quantity: 100,
        reserved: 10,
        available: 90,
      },
    });

    await this.create('order', {
      customerId: 'customer-1',
      orderNumber: 'ORD-001',
      status: 'pending',
      orderDate: new Date(),
      totalAmount: 199.98,
      currency: 'USD',
      items: [
        {
          id: 'item-1',
          productId: 'product-1',
          productName: 'Premium Widget',
          quantity: 2,
          unitPrice: 99.99,
          totalPrice: 199.98,
          sku: 'WIDGET-001',
        },
      ],
    });

    this.logger.info('Sample typed connector seeded with demo data');
  }

  async getSystemInfo(): Promise<SystemInfo> {
    return {
      name: 'Sample Typed System',
      version: '1.0.0',
      type: 'Sample',
      capabilities: ['read', 'write', 'bulk_operations', 'webhooks'],
      rateLimits: {
        requestsPerMinute: 100,
        requestsPerHour: 1000,
        requestsPerDay: 10000,
      },
      endpoints: {
        baseUrl: this.baseUrl,
        authUrl: `${this.baseUrl}/auth`,
        webhookUrl: `${this.baseUrl}/webhooks`,
      },
    };
  }

  /**
   * Type-safe method to get customers with specific filters
   */
  async getActiveCustomers(): Promise<Customer[]> {
    const customers = await this.list('customer');
    return customers.filter(customer => customer.status === 'active') as unknown as Customer[];
  }

  /**
   * Type-safe method to get orders for a specific customer
   */
  async getCustomerOrders(customerId: string): Promise<Order[]> {
    const orders = await this.list('order');
    return orders.filter(order => order.customerId === customerId) as unknown as Order[];
  }

  /**
   * Type-safe method to update product inventory
   */
  async updateProductInventory(
    productId: string,
    inventory: { quantity: number; reserved: number; available: number }
  ): Promise<Product> {
    return await this.update('product', productId, { inventory }) as unknown as Product;
  }
}

export default SampleTypedConnector;