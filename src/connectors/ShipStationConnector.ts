import { BaseConnector } from '../core/BaseConnector';
import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
import type { AuthConfig, DataRecord, SystemInfo } from '../types';
import type { Logger } from '../utils/Logger';
import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { OutboundGovernanceService } from '../services/governance/OutboundGovernanceService';

/**
 * ShipStation 3PL Connector
 *
 * Integrates with ShipStation's shipping and fulfillment platform.
 * Supports orders, shipments, carriers, warehouses, products, and tracking.
 *
 * API Documentation: https://www.shipstation.com/docs/api/
 *
 * Created: January 8, 2026 (Phase 2 - SuiteCentral Parity)
 * Updated: February 7, 2026 (Phase 8 - Demo code extracted to DemoConnectorDecorator)
 */

// ShipStation Entity Types
export interface ShipStationOrder {
  orderId: number;
  orderNumber: string;
  orderKey?: string;
  orderDate: string;
  createDate: string;
  modifyDate: string;
  orderStatus: 'awaiting_payment' | 'awaiting_shipment' | 'pending_fulfillment' | 'shipped' | 'on_hold' | 'cancelled';
  customerId?: number;
  customerEmail?: string;
  billTo: ShipStationAddress;
  shipTo: ShipStationAddress;
  items: ShipStationOrderItem[];
  orderTotal: number;
  amountPaid: number;
  taxAmount: number;
  shippingAmount: number;
  customerNotes?: string;
  internalNotes?: string;
  gift: boolean;
  carrierCode?: string;
  serviceCode?: string;
  shipDate?: string;
  weight: ShipStationWeight;
  externallyFulfilled: boolean;
}

export interface ShipStationAddress {
  name: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
  residential?: boolean;
}

export interface ShipStationOrderItem {
  orderItemId?: number;
  sku?: string;
  name: string;
  quantity: number;
  unitPrice: number;
  weight?: ShipStationWeight;
  adjustment: boolean;
}

export interface ShipStationWeight {
  value: number;
  units: 'pounds' | 'ounces' | 'grams';
}

export interface ShipStationShipment {
  shipmentId: number;
  orderId: number;
  orderNumber: string;
  createDate: string;
  shipDate: string;
  shipmentCost: number;
  insuranceCost: number;
  trackingNumber: string;
  isReturnLabel: boolean;
  carrierCode: string;
  serviceCode: string;
  packageCode: string;
  voided: boolean;
  voidDate?: string;
  marketplaceNotified: boolean;
  shipTo: ShipStationAddress;
  weight: ShipStationWeight;
}

export interface ShipStationCarrier {
  name: string;
  code: string;
  accountNumber?: string;
  requiresFundedAccount: boolean;
  balance?: number;
  primary?: boolean;
}

export interface ShipStationWarehouse {
  warehouseId: number;
  warehouseName: string;
  originAddress: ShipStationAddress;
  createDate: string;
  isDefault: boolean;
}

export interface ShipStationProduct {
  productId: number;
  sku: string;
  name: string;
  price: number;
  weightOz?: number;
  createDate: string;
  modifyDate: string;
  active: boolean;
  warehouseLocation?: string;
}

export interface ShipStationRate {
  serviceName: string;
  serviceCode: string;
  shipmentCost: number;
  otherCost: number;
}

export interface ShipStationTrackingEvent {
  occurredAt: string;
  description: string;
  cityLocality?: string;
  stateProvince?: string;
  countryCode?: string;
}

export interface ShipStationRateRequest {
  carrierCode: string;
  serviceCode?: string;
  packageCode?: string;
  fromPostalCode: string;
  toState?: string;
  toCountry: string;
  toPostalCode: string;
  toCity?: string;
  weight: ShipStationWeight;
  dimensions?: { length: number; width: number; height: number; units: string };
  confirmation?: string;
  residential?: boolean;
}

@injectable()
export class ShipStationConnector extends BaseConnector implements IConnector {
  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'Real ShipStation v2 REST API calls (orders, shipments, warehouses) with API-key + secret auth';
  static readonly proofCard = 'docs/review/proof-cards/shipstation-connector.md';

  private apiKey = '';
  private apiSecret = '';
  private readonly apiVersion = '2.0';
  private readonly outboundGovernance: OutboundGovernanceService;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    outboundGovernance: OutboundGovernanceService,
  ) {
    super('ShipStation', 'shipstation', logger);
    if (!outboundGovernance) {
      throw new Error('OutboundGovernanceService is required for production connector outbound protection');
    }
    this.outboundGovernance = outboundGovernance;
  }

  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;

    const credentials = config.credentials as { apiKey: string; apiSecret: string };
    if (!credentials.apiKey || !credentials.apiSecret) {
      throw new Error('ShipStation connector requires apiKey and apiSecret');
    }

    this.apiKey = credentials.apiKey;
    this.apiSecret = credentials.apiSecret;
    this.httpClient.defaults.baseURL = 'https://ssapi.shipstation.com';
    this.httpClient.defaults.headers.common['Authorization'] =
      `Basic ${Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64')}`;

    this.logger.info('ShipStation connector initialized');
  }

  async authenticate(): Promise<boolean> {
    if (this.isAuthenticating) return true;

    this.isAuthenticating = true;
    try {
      await this.getSystemInfo();
      this.isAuthenticated = true;
      return true;
    } catch (error) {
      this.isAuthenticated = false;
      this.logger.error('ShipStation authentication failed', error);
      throw error;
    } finally {
      this.isAuthenticating = false;
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    try {
      await this.makeRequest<unknown[]>({
        method: 'GET',
        url: '/carriers',
      });

      return {
        name: 'ShipStation',
        type: 'ShipStation',
        version: this.apiVersion,
        capabilities: ['orders', 'shipments', 'carriers', 'warehouses', 'products', 'rates'],
        rateLimits: {
          requestsPerMinute: 40,
          requestsPerHour: 2400,
          requestsPerDay: 57600,
        },
        endpoints: {
          baseUrl: this.httpClient.defaults.baseURL as string,
          authUrl: 'https://ssapi.shipstation.com/auth',
          webhookUrl: 'https://ssapi.shipstation.com/webhooks',
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get ShipStation system info: ${message}`, { cause: error });
    }
  }

  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    await this.ensureAuthenticated();

    const guardedData = await this.validateOutboundWrite(this.outboundGovernance, 'create', entityType, data);

    try {
      const response = await this.makeRequest<Record<string, unknown>>({
        method: 'POST',
        url: this.getEndpoint(entityType),
        data: guardedData,
      });
      return response as DataRecord;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create ${entityType}: ${message}`, { cause: error });
    }
  }

  async read(entityType: string, id: string): Promise<DataRecord | null> {
    await this.ensureAuthenticated();

    try {
      const response = await this.makeRequest<Record<string, unknown>>({
        method: 'GET',
        url: `${this.getEndpoint(entityType)}/${id}`,
      });
      return response as DataRecord;
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async update(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord> {
    await this.ensureAuthenticated();

    const guardedData = await this.validateOutboundWrite(this.outboundGovernance, 'update', entityType, data, { resourceId: id });

    try {
      const response = await this.makeRequest<Record<string, unknown>>({
        method: 'PUT',
        url: `${this.getEndpoint(entityType)}/${id}`,
        data: guardedData,
      });
      return response as DataRecord;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to update ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async delete(entityType: string, id: string): Promise<boolean> {
    await this.ensureAuthenticated();

    await this.validateOutboundWrite(this.outboundGovernance, 'delete', entityType, { id }, { resourceId: id });

    try {
      await this.makeRequest({
        method: 'DELETE',
        url: `${this.getEndpoint(entityType)}/${id}`,
      });
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async list(entityType: string, options: ListOptions = {}): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    const params = new URLSearchParams();
    if (options.limit) params.append('pageSize', options.limit.toString());
    if (options.offset) params.append('page', Math.floor((options.offset || 0) / (options.limit || 50) + 1).toString());

    try {
      const response = await this.makeRequest<{ [key: string]: unknown[] }>({
        method: 'GET',
        url: this.getEndpoint(entityType),
        params,
      });
      return (response[entityType] || []) as DataRecord[];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list ${entityType}: ${message}`, { cause: error });
    }
  }

  async search(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]> {
    return this.list(entityType, { filters: criteria.filters });
  }

  private getEndpoint(entityType: string): string {
    switch (entityType.toLowerCase()) {
      case 'orders': return '/orders';
      case 'shipments': return '/shipments';
      case 'carriers': return '/carriers';
      case 'warehouses': return '/warehouses';
      case 'products': return '/products';
      default: throw new Error(`Unknown entity type: ${entityType}`);
    }
  }

  // ShipStation-specific methods

  async getOrderByNumber(orderNumber: string): Promise<ShipStationOrder | null> {
    const response = await this.makeRequest<{ orders: ShipStationOrder[] }>({
      method: 'GET',
      url: `/orders?orderNumber=${encodeURIComponent(orderNumber)}`,
    });
    return response.orders?.length > 0 ? response.orders[0] : null;
  }

  async getShippingRates(request: ShipStationRateRequest): Promise<ShipStationRate[]> {
    const response = await this.makeRequest<ShipStationRate[]>({
      method: 'POST',
      url: '/shipments/getrates',
      data: request,
    });
    return Array.isArray(response) ? response : [];
  }

  async getTrackingInfo(_carrierCode: string, trackingNumber: string): Promise<ShipStationTrackingEvent[]> {
    const response = await this.makeRequest<{ events: ShipStationTrackingEvent[] }>({
      method: 'GET',
      url: `/shipments/track?carrierCode=${_carrierCode}&trackingNumber=${trackingNumber}`,
    });
    return response.events || [];
  }

  async markOrderShipped(orderId: number, shipmentInfo: {
    carrierCode: string;
    serviceCode?: string;
    trackingNumber?: string;
    shipDate?: string;
    notifyCustomer?: boolean;
  }): Promise<ShipStationOrder> {
    // PR 3B: route the custom-method payload through validateOutboundWrite so
    // the HITL approval queue catches it (the standard create/update/delete
    // paths already do; markOrderShipped + voidLabel were the inventory-
    // documented bypass). The payload is mostly logistics ids, but the gate
    // is uniform across all outbound writes — see
    // [[project-pr-3b-route-audit-inventory]] for the ShipStation callout.
    const guardedData = await this.validateOutboundWrite(
      this.outboundGovernance,
      'update',
      'order',
      { orderId, ...shipmentInfo },
      { resourceId: String(orderId) },
    );
    const response = await this.makeRequest<ShipStationOrder>({
      method: 'POST',
      url: '/orders/markasshipped',
      data: guardedData,
    });
    return response;
  }

  async voidLabel(shipmentId: number): Promise<boolean> {
    // PR 3B: see markOrderShipped — same outbound-write gate closure.
    // Capture the validateOutboundWrite return value (defensive — currently
    // identical to the input since the payload is just a numeric id, but
    // if governance ever introduces a normalization or redaction transform
    // we want it threaded through to the wire payload, NOT silently dropped
    // by reusing the original input). Copilot R1.
    const guardedData = await this.validateOutboundWrite(
      this.outboundGovernance,
      'delete',
      'shipment',
      { shipmentId },
      { resourceId: String(shipmentId) },
    );
    const response = await this.makeRequest<{ approved: boolean }>({
      method: 'POST',
      url: '/shipments/voidlabel',
      data: guardedData,
    });
    return response?.approved === true;
  }
}
