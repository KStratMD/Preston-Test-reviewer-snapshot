import type { Request, Response } from 'express';
import type { Logger } from '../../utils/Logger';

export interface MockRequest extends Partial<Request> {
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string | string[]>;
  method?: string;
  url?: string;
  path?: string;
}

export interface MockResponse extends Partial<Response> {
  statusCode?: number;
  data?: unknown;
  headers?: Record<string, string>;
}

export const createMockRequest = (overrides: MockRequest = {}): Request => {
  const req: MockRequest = {
    body: {},
    params: {},
    query: {},
    headers: {},
    method: 'GET',
    url: '/',
    path: '/',
    ...overrides,
  };
  return req as Request;
};

export const createMockResponse = (): Response => {
  const res: MockResponse = {
    statusCode: 200,
    data: null,
    headers: {},
  };
  
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  });
  
  res.json = jest.fn((data: unknown) => {
    res.data = data;
    return res as Response;
  });

  res.send = jest.fn((data: unknown) => {
    res.data = data;
    return res as Response;
  });
  
  res.setHeader = jest.fn((name: string, value: string) => {
    res.headers![name] = value;
    return res as Response;
  });

  const redirectMock = jest.fn((arg1: string | number, arg2?: string | number) => {
    let status: number | undefined;
    let url: string | undefined;

    if (typeof arg1 === 'number') {
      status = arg1;
      if (typeof arg2 === 'string') {
        url = arg2;
      }
    } else if (typeof arg1 === 'string') {
      url = arg1;
      if (typeof arg2 === 'number') {
        status = arg2;
      }
    }

    res.statusCode = status ?? res.statusCode ?? 302;
    if (url) {
      res.headers!['Location'] = url;
    }

    return res as Response;
  });

  res.redirect = redirectMock as unknown as Response['redirect'];
  
  res.end = jest.fn(() => res as Response);
  
  return res as Response;
};

export const createMockLogger = (): Logger => {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => createMockLogger()),
  } as unknown as Logger;
};

export const createMockNext = () => jest.fn();

export const expectSuccess = (res: Response, expectedData?: unknown, statusCode = 200) => {
  expect(res.status).toHaveBeenCalledWith(statusCode);
  if (expectedData !== undefined) {
    expect(res.json).toHaveBeenCalledWith(expectedData);
  }
};

export const expectError = (res: Response, statusCode: number, errorMessage?: string) => {
  expect(res.status).toHaveBeenCalledWith(statusCode);
  if (errorMessage) {
    const responseData = (res.json as jest.Mock).mock.calls[0]?.[0];
    expect(responseData?.error || responseData?.message).toContain(errorMessage);
  }
};

export const expectValidation = (res: Response, fieldName?: string) => {
  expectError(res, 400);
  if (fieldName) {
    const responseData = (res.json as jest.Mock).mock.calls[0]?.[0];
    expect(responseData?.error || responseData?.message).toContain(fieldName);
  }
};