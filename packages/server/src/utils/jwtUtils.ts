import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import config from '../config';
import logger from '../logger';

export interface JwtPayload {
  username: string;
  jti?: string;
  iat?: number;
  exp?: number;
}

/**
 * Generate a JWT token for a user
 */
export function generateToken(username: string): string {
  try {
    const payload: JwtPayload = { username, jti: randomUUID() };
    const token = jwt.sign(
      payload,
      config.auth.jwtSecret,
      { expiresIn: config.auth.jwtExpiresIn } as jwt.SignOptions
    );
    return token;
  } catch (error) {
    logger.error('Failed to generate JWT token:', error);
    throw new Error('Failed to generate authentication token');
  }
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret) as JwtPayload;
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      logger.warn('JWT token expired');
    } else if (error instanceof jwt.JsonWebTokenError) {
      logger.warn('Invalid JWT token');
    } else {
      logger.error('JWT verification failed:', error);
    }
    return null;
  }
}

/**
 * Extract JWT token from Authorization header
 * Supports: "Bearer <token>" format
 */
export function extractTokenFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  // Support "Bearer <token>" format
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Support raw token (without "Bearer " prefix)
  return authHeader;
}

/**
 * Refresh a JWT token (generate new token with same payload)
 */
export function refreshToken(token: string): string | null {
  const decoded = verifyToken(token);
  if (!decoded) {
    return null;
  }

  return generateToken(decoded.username);
}
