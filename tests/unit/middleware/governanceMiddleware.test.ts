import type { Request, Response } from 'express';
import { createGovernanceMiddleware } from '../../../src/middleware/governanceMiddleware';

describe('createGovernanceMiddleware', () => {
  it('includes the request path in governance input for route parameter coverage', async () => {
    let inspectedInput: unknown;
    const middleware = createGovernanceMiddleware({
      governanceService: {
        validateInput: jest.fn(async (input: unknown) => {
          inspectedInput = input;
          return {
            approved: true,
            flags: [],
            riskLevel: 'low',
            complianceChecks: [],
          };
        }),
      } as any,
      logger: {
        warn: jest.fn(),
        error: jest.fn(),
      } as any,
    });

    const req = {
      method: 'GET',
      body: {},
      query: {},
      headers: {},
      originalUrl: '/api/ai/proxy/natural-language/documentation/123-45-6789',
      path: '/natural-language/documentation/123-45-6789',
    } as Request;
    const res = {} as Response;
    const next = jest.fn();

    await middleware(req, res, next);

    expect(inspectedInput).toMatchObject({
      path: '/natural-language/documentation/123-45-6789',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
