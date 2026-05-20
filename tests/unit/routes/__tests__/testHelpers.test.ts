import { 
  createMockRequest, 
  createMockResponse, 
  createMockLogger, 
  createMockNext,
  expectSuccess,
  expectError,
  expectValidation 
} from './testHelpers';

describe('Test Helpers', () => {
  describe('createMockRequest', () => {
    it('should create a basic mock request', () => {
      const req = createMockRequest();
      
      expect(req.body).toEqual({});
      expect(req.params).toEqual({});
      expect(req.query).toEqual({});
      expect(req.headers).toEqual({});
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/');
    });

    it('should create mock request with overrides', () => {
      const req = createMockRequest({
        method: 'POST',
        body: { name: 'test' },
        params: { id: '123' },
      });
      
      expect(req.method).toBe('POST');
      expect(req.body).toEqual({ name: 'test' });
      expect(req.params).toEqual({ id: '123' });
    });
  });

  describe('createMockResponse', () => {
    it('should create a basic mock response', () => {
      const res = createMockResponse();
      
      expect(typeof res.status).toBe('function');
      expect(typeof res.json).toBe('function');
      expect(typeof res.send).toBe('function');
      expect(typeof res.setHeader).toBe('function');
      expect(typeof res.end).toBe('function');
    });

    it('should chain status and json calls', () => {
      const res = createMockResponse();
      
      res.status(200).json({ success: true });
      
      expect(res.statusCode).toBe(200);
      expect(res.data).toEqual({ success: true });
    });

    it('should handle setHeader', () => {
      const res = createMockResponse();
      
      res.setHeader('Content-Type', 'application/json');
      
      expect(res.headers?.['Content-Type']).toBe('application/json');
    });
  });

  describe('createMockLogger', () => {
    it('should create a mock logger with all methods', () => {
      const logger = createMockLogger();
      
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.child).toBe('function');
    });

    it('should create child loggers', () => {
      const logger = createMockLogger();
      const child = logger.child({ context: 'test' });
      
      expect(child).toBeDefined();
      expect(typeof child.info).toBe('function');
    });
  });

  describe('createMockNext', () => {
    it('should create a next function', () => {
      const next = createMockNext();
      
      expect(typeof next).toBe('function');
      expect(jest.isMockFunction(next)).toBe(true);
    });
  });

  describe('expectSuccess', () => {
    it('should validate successful response', () => {
      const res = createMockResponse();
      res.status(200).json({ data: 'test' });
      
      expectSuccess(res, { data: 'test' });
      
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ data: 'test' });
    });

    it('should validate successful response without data check', () => {
      const res = createMockResponse();
      res.status(200).json({ success: true });
      
      expectSuccess(res);
      
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('expectError', () => {
    it('should validate error response', () => {
      const res = createMockResponse();
      res.status(400).json({ error: 'Bad request' });
      
      expectError(res, 400, 'Bad request');
      
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should validate error response without message check', () => {
      const res = createMockResponse();
      res.status(500).json({ error: 'Internal error' });
      
      expectError(res, 500);
      
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('expectValidation', () => {
    it('should validate validation error', () => {
      const res = createMockResponse();
      res.status(400).json({ error: 'Invalid name field' });
      
      expectValidation(res, 'name');
      
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});