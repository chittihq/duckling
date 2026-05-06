import { Request, Response, NextFunction } from 'express';
import { verifyToken, extractTokenFromHeader } from '../utils/jwtUtils';
import config from '../config';

// Extend Express Request to include JWT user info
declare global {
  namespace Express {
    interface Request {
      user?: {
        username: string;
        jti?: string;
        authMethod?: 'jwt' | 'apiKey';
        apiKeyId?: string;
      };
    }
  }
}

/**
 * Middleware to verify JWT token
 * Sets req.user if token is valid
 */
export const verifyJWT = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  const token = extractTokenFromHeader(authHeader);

  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication token required',
      architecture: 'clickhouse'
    });
    return;
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
      architecture: 'clickhouse'
    });
    return;
  }

  // Attach user info to request
  req.user = { username: decoded.username, jti: decoded.jti, authMethod: 'jwt' };
  next();
};

/**
 * Middleware to check for JWT or API key authentication (stateless)
 * Supports two authentication methods: JWT and API key
 */
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required. Provide JWT token or API key.',
      architecture: 'clickhouse'
    });
    return;
  }

  const token = extractTokenFromHeader(authHeader);

  // Check if it's an API key
  if (config.auth.apiKey && token === config.auth.apiKey) {
    req.user = { username: 'api-key-user', authMethod: 'apiKey' };
    next();
    return;
  }

  // Try JWT verification
  const decoded = verifyToken(token);
  if (decoded) {
    req.user = { username: decoded.username, jti: decoded.jti, authMethod: 'jwt' };
    next();
    return;
  }

  // No valid authentication found
  res.status(401).json({
    error: 'Unauthorized',
    message: 'Invalid or expired token',
    architecture: 'clickhouse'
  });
};

/**
 * Check if request is authenticated via JWT or API key
 */
export const isAuthenticated = (req: Request): boolean => {
  // Check if user is already attached (JWT or API key verified)
  if (req.user) {
    return true;
  }

  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return false;
  }

  const token = extractTokenFromHeader(authHeader);

  // Check API key
  if (config.auth.apiKey && token === config.auth.apiKey) {
    return true;
  }

  // Check JWT
  const decoded = verifyToken(token);
  return !!decoded;
};
