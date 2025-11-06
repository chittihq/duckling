import { Request, Response, NextFunction } from 'express';

declare module 'express-session' {
  interface SessionData {
    isAuthenticated?: boolean;
    username?: string;
  }
}

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (req.session && req.session.isAuthenticated) {
    next();
  } else {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required',
      architecture: 'sequential-appender'
    });
  }
};

export const isAuthenticated = (req: Request): boolean => {
  return !!(req.session && req.session.isAuthenticated);
};
