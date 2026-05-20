import { BaseConnector } from '../core/BaseConnector';
import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
import type { AuthConfig, DataRecord, SystemInfo } from '../types';
import type { Logger } from '../utils/Logger';
import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';

@injectable()
export class ShopifyConnector extends BaseConnector implements IConnector {
    static readonly productionStatus = 'demo_only' as const;
    static readonly statusEvidence = 'Real Shopify Admin REST API scaffolding (X-Shopify-Access-Token, myshopify.com baseURL); shipped via DemoConnectorDecorator wrap — no production credential test on file';

    private shopName!: string;
    private accessToken!: string;
    private readonly apiVersion = '2024-01';

    constructor(
        systemId: string,
        @inject(TYPES.Logger) logger: Logger,
    ) {
        super('Shopify', systemId, logger);
    }

    async initialize(config: AuthConfig): Promise<void> {
        this.authConfig = config;
        const credentials = config.credentials as { shopName: string; accessToken: string };

        if (!credentials.shopName || !credentials.accessToken) {
            throw new Error('Shopify connector requires shopName and accessToken');
        }

        this.shopName = credentials.shopName;
        this.accessToken = credentials.accessToken;
        this.httpClient.defaults.baseURL = `https://${this.shopName}.myshopify.com/admin/api/${this.apiVersion}`;
        this.httpClient.defaults.headers.common['X-Shopify-Access-Token'] = this.accessToken;

        this.logger.info('Shopify connector initialized', { shopName: this.shopName });
    }

    async authenticate(): Promise<boolean> {
        if (this.isAuthenticating) return true;

        this.isAuthenticating = true;
        try {
            // Test the token by making a lightweight call
            await this.getSystemInfo();
            this.isAuthenticated = true;
            return true;
        } catch (error) {
            this.isAuthenticated = false;
            this.logger.error('Shopify authentication failed', error);
            throw error;
        } finally {
            this.isAuthenticating = false;
        }
    }

    async getSystemInfo(): Promise<SystemInfo> {
        try {
            await this.makeRequest<{ shop: { name: string; myshopify_domain: string; plan_name: string } }>({
                method: 'GET',
                url: '/shop.json',
            });

            return {
                name: 'Shopify',
                type: 'Shopify',
                version: this.apiVersion,
                capabilities: ['products', 'orders', 'customers', 'inventory'],
                rateLimits: {
                    requestsPerMinute: 40,
                    requestsPerHour: 2400,
                    requestsPerDay: 57600,
                },
                endpoints: {
                    baseUrl: this.httpClient.defaults.baseURL as string,
                    authUrl: `https://${this.shopName}.myshopify.com/admin/oauth/authorize`,
                    webhookUrl: `https://${this.shopName}.myshopify.com/admin/api/${this.apiVersion}/webhooks.json`,
                },
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to get Shopify system info: ${message}`, { cause: error });
        }
    }

    async create(entityType: string, data: DataRecord): Promise<DataRecord> {
        await this.ensureAuthenticated();
        const endpoint = this.getEndpoint(entityType);
        const payload = this.formatDataForShopify(data, entityType);

        try {
            const response = await this.makeRequest<Record<string, unknown>>({
                method: 'POST',
                url: `${endpoint}.json`,
                data: { [this.getSingularName(entityType)]: payload },
            });

            const responseData = response[this.getSingularName(entityType)] as Record<string, unknown>;
            return this.formatDataFromShopify(responseData, entityType);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to create ${entityType}: ${message}`, { cause: error });
        }
    }

    async read(entityType: string, id: string): Promise<DataRecord | null> {
        await this.ensureAuthenticated();
        const endpoint = this.getEndpoint(entityType);

        try {
            const response = await this.makeRequest<Record<string, unknown>>({
                method: 'GET',
                url: `${endpoint}/${id}.json`,
            });

            const responseData = response[this.getSingularName(entityType)] as Record<string, unknown>;
            return this.formatDataFromShopify(responseData, entityType);
        } catch (error: unknown) {
            // Handle 404
            if (error instanceof Error && error.message.includes('404')) {
                return null;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to read ${entityType} ${id}: ${message}`, { cause: error });
        }
    }

    async update(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord> {
        await this.ensureAuthenticated();
        const endpoint = this.getEndpoint(entityType);
        const payload = this.formatDataForShopify(data, entityType);

        try {
            const response = await this.makeRequest<Record<string, unknown>>({
                method: 'PUT',
                url: `${endpoint}/${id}.json`,
                data: { [this.getSingularName(entityType)]: { ...payload, id } },
            });

            const responseData = response[this.getSingularName(entityType)] as Record<string, unknown>;
            return this.formatDataFromShopify(responseData, entityType);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to update ${entityType} ${id}: ${message}`, { cause: error });
        }
    }

    async delete(entityType: string, id: string): Promise<boolean> {
        await this.ensureAuthenticated();
        const endpoint = this.getEndpoint(entityType);

        try {
            await this.makeRequest({
                method: 'DELETE',
                url: `${endpoint}/${id}.json`,
            });
            return true;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to delete ${entityType} ${id}: ${message}`, { cause: error });
        }
    }

    async list(entityType: string, options: ListOptions = {}): Promise<DataRecord[]> {
        await this.ensureAuthenticated();
        const endpoint = this.getEndpoint(entityType);
        const params = new URLSearchParams();

        if (options.limit) params.append('limit', options.limit.toString());
        // Shopify uses cursor-based pagination for some endpoints, but offset for others. 
        // For simplicity in this MVP, we'll stick to basic params or implement cursor later if needed.

        try {
            const response = await this.makeRequest<Record<string, unknown[]>>({
                method: 'GET',
                url: `${endpoint}.json`,
                params: params,
            });

            const items = response[entityType] || [];
            return items.map(item => this.formatDataFromShopify(item as Record<string, unknown>, entityType));
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to list ${entityType}: ${message}`, { cause: error });
        }
    }

    async search(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]> {
        // Shopify search is limited. We might need to use the GraphQL API for advanced search.
        // For MVP, we'll implement basic filtering if supported by REST API, or fetch all and filter (inefficient).
        // Or use the /search.json endpoint if available for the resource.

        // Fallback to list with filters for now
        return this.list(entityType, { filters: criteria.filters });
    }

    private getEndpoint(entityType: string): string {
        switch (entityType.toLowerCase()) {
            case 'products': return '/products';
            case 'orders': return '/orders';
            case 'customers': return '/customers';
            case 'inventory': return '/inventory_levels'; // Simplified
            default: throw new Error(`Unsupported entity type: ${entityType}`);
        }
    }

    private getSingularName(entityType: string): string {
        // Simple singularization
        if (entityType.endsWith('s')) return entityType.slice(0, -1);
        return entityType;
    }

    private formatDataForShopify(data: Partial<DataRecord>, entityType: string): Record<string, unknown> {
        // Basic mapping
        const fields = (data.fields || {}) as Record<string, unknown>;
        // Add specific transformations here
        return fields;
    }

    private formatDataFromShopify(data: Record<string, unknown>, entityType: string): DataRecord {
        const rawId = data.id;
        if (rawId === undefined || rawId === null || rawId === '') {
            throw new Error(`Shopify ${entityType} payload missing id`);
        }
        const id = String(rawId);
        const updated = data.updated_at;
        return {
            id,
            externalId: id,
            fields: data,
            metadata: {
                source: 'Shopify',
                lastModified: typeof updated === 'string' ? new Date(updated) : new Date(),
                version: this.apiVersion,
            },
        };
    }
}
