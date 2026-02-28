import { describe, expect, it } from 'vitest';
import { DEFAULT_JWT_SECRET, getAuthSecurityIssues } from '../config';

describe('getAuthSecurityIssues', () => {
  it('reports default JWT secret', () => {
    const issues = getAuthSecurityIssues({
      adminUsername: 'admin',
      adminPassword: 'password',
      sessionSecret: '',
      apiKey: '',
      jwtSecret: DEFAULT_JWT_SECRET,
      jwtExpiresIn: '1h',
    });

    expect(issues).toContain('JWT_SECRET is using the insecure default value.');
  });

  it('reports empty admin credentials', () => {
    const issues = getAuthSecurityIssues({
      adminUsername: ' ',
      adminPassword: '',
      sessionSecret: '',
      apiKey: '',
      jwtSecret: 'secure-secret',
      jwtExpiresIn: '1h',
    });

    expect(issues).toContain('ADMIN_USERNAME and ADMIN_PASSWORD must both be set to non-empty values.');
  });

  it('returns no issues for secure auth config', () => {
    const issues = getAuthSecurityIssues({
      adminUsername: 'admin',
      adminPassword: 'strong-password',
      sessionSecret: '',
      apiKey: '',
      jwtSecret: 'secure-secret',
      jwtExpiresIn: '1h',
    });

    expect(issues).toEqual([]);
  });
});
