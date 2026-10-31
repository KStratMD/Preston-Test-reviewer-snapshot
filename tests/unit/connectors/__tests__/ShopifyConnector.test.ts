import { ShopifyConnector } from '../../../../src/connectors/ShopifyConnector';
import { Logger } from '../../../../src/utils/Logger';
import { AuthConfig } from '../../../../src/types';
import { jest } from '@jest/globals';

// Mock dependencies
const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
} as unknown as Logger;

// Mock axios
const mockAxiosInstance = {
    defaults: {
        baseURL: '',
        headers: {
            common: {},
        },
    },
    interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
    },
    request: jest.fn(),
};

jest.mock('axios', () => ({
    create: jest.fn(() => mockAxiosInstance),
    isAxiosError: jest.fn(() => false),
}));

describe('ShopifyConnector', () => {
    let connector: ShopifyConnector;
    const config: AuthConfig = {
        type: 'oauth2',
        credentials: {
            shopName: 'test-shop',
            accessToken: 'test-token',
        },
    };

    beforeEach(() => {
        jest.clearAllMocks();
        connector = new ShopifyConnector('test-shopify', mockLogger);
    });

    describe('initialize', () => {
        it('should initialize with valid config', async () => {
            await connector.initialize(config);

            expect(mockAxiosInstance.defaults.baseURL).toBe('https://test-shop.myshopify.com/admin/api/2024-01');
            expect((mockAxiosInstance.defaults.headers.common as any)['X-Shopify-Access-Token']).toBe('test-token');
            expect(mockLogger.info).toHaveBeenCalledWith('Shopify connector initialized', { shopName: 'test-shop' });
        });

        it('should throw error if shopName is missing', async () => {
            const invalidConfig = { ...config, credentials: { accessToken: 'token' } };
            await expect(connector.initialize(invalidConfig)).rejects.toThrow('Shopify connector requires shopName and accessToken');
        });
    });

    describe('getSystemInfo', () => {
        beforeEach(async () => {
            await connector.initialize(config);
        });

        it('should return system info', async () => {
            const mockResponse = {
                data: {
                    shop: {
                        name: 'Test Shop',
                        myshopify_domain: 'test-shop.myshopify.com',
                        plan_name: 'basic',
                    },
                },
            };
            (mockAxiosInstance.request as any).mockResolvedValue(mockResponse);

            const info = await connector.getSystemInfo();

            expect(info.name).toBe('Shopify');
            expect(info.type).toBe('Shopify');
            expect(info.capabilities).toContain('products');
            expect(info.rateLimits.requestsPerMinute).toBe(40);
            expect(info.endpoints.authUrl).toContain('oauth/authorize');
            expect(mockAxiosInstance.request).toHaveBeenCalledWith(expect.objectContaining({
                method: 'GET',
                url: '/shop.json',
            }));
        });
    });

    describe('create', () => {
        beforeEach(async () => {
            await connector.initialize(config);
            // Mock authentication check
            (mockAxiosInstance.request as any).mockResolvedValueOnce({ data: { shop: {} } }); // For authenticate()
        });

        it('should create a product', async () => {
            const productData = {
                fields: {
                    title: 'New Product',
                    body_html: '<strong>Good product</strong>',
                },
            };

            const mockResponse = {
                data: {
                    product: {
                        id: 12345,
                        title: 'New Product',
                        updated_at: '2024-01-01T00:00:00Z',
                    },
                },
            };

            // First call is authenticate (mocked in beforeEach), second is create
            (mockAxiosInstance.request as any).mockResolvedValueOnce(mockResponse);

            const result = await connector.create('products', productData);

            expect(result.id).toBe('12345');
            expect((result as any).metadata.source).toBe('Shopify');
            expect(mockAxiosInstance.request).toHaveBeenCalledWith(expect.objectContaining({
                method: 'POST',
                url: '/products.json',
                data: { product: productData.fields },
            }));
        });
    });
});
