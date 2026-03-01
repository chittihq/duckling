import { describe, expect, it } from 'vitest';
import { DEFAULT_JWT_SECRET, getAuthSecurityIssues } from '../config';

const secureAuth = (overrides: Record<string, string> = {}) => ({
  adminUsername: 'admin',
  adminPassword: 'strong-password',
  sessionSecret: '',
  apiKey: '',
  jwtSecret: 'secure-secret',
  jwtExpiresIn: '1h',
  ...overrides,
});

describe('getAuthSecurityIssues', () => {
  it('reports default JWT secret', () => {
    const issues = getAuthSecurityIssues(secureAuth({ jwtSecret: DEFAULT_JWT_SECRET }));
    expect(issues).toContain('JWT_SECRET is using the insecure default value.');
  });

  it('reports empty admin credentials', () => {
    const issues = getAuthSecurityIssues(secureAuth({ adminUsername: ' ', adminPassword: '' }));
    expect(issues).toContain('ADMIN_USERNAME and ADMIN_PASSWORD must both be set to non-empty values.');
  });

  it('reports missing admin password when username is set', () => {
    const issues = getAuthSecurityIssues(secureAuth({ adminPassword: '' }));
    expect(issues).toContain('ADMIN_USERNAME and ADMIN_PASSWORD must both be set to non-empty values.');
  });

  it('reports missing admin username when password is set', () => {
    const issues = getAuthSecurityIssues(secureAuth({ adminUsername: ' ' }));
    expect(issues).toContain('ADMIN_USERNAME and ADMIN_PASSWORD must both be set to non-empty values.');
  });
  it('returns no issues for secure auth config', () => {
    expect(getAuthSecurityIssues(secureAuth())).toEqual([]);
  });
});
