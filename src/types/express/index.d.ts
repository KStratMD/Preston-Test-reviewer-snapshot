import 'express';

declare global {
  namespace Express {
    interface User {
      id?: number;
      [key: string]: unknown;
    }

    interface Request {
      user?: User;
    }
  }
}

export {};
