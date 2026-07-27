import { describe, expect, it } from 'vitest';

import { parseApiEnv } from './api-env';

const validEnv = {
  DATABASE_URL: 'postgresql://whauto:whauto@localhost:5433/whauto_dev',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
};

describe('parseApiEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = parseApiEnv(validEnv);

    expect(env.API_PORT).toBe(4000);
    expect(env.CORS_ORIGIN).toBe('http://localhost:3000');
    expect(env.NODE_ENV).toBe('development');
    expect(env.JWT_ACCESS_EXPIRES_IN).toBe('15m');
    expect(env.REFRESH_TOKEN_EXPIRES_IN_DAYS).toBe(7);
    expect(env.COOKIE_NAME).toBe('whauto_refresh');
    expect(env.COOKIE_SAME_SITE).toBe('strict');
    expect(env.COOKIE_DOMAIN).toBeUndefined();
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.AUTH_EXPOSE_TEST_TOKENS).toBe(false);
    expect(env.AUTH_RATE_LIMIT_LOGIN_MAX).toBe(5);
    expect(env.AUTH_RATE_LIMIT_LOGIN_WINDOW_SECONDS).toBe(60);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() =>
      parseApiEnv({ REDIS_URL: validEnv.REDIS_URL, JWT_ACCESS_SECRET: validEnv.JWT_ACCESS_SECRET }),
    ).toThrow();
  });

  it('throws when JWT_ACCESS_SECRET is missing', () => {
    expect(() =>
      parseApiEnv({ DATABASE_URL: validEnv.DATABASE_URL, REDIS_URL: validEnv.REDIS_URL }),
    ).toThrow();
  });

  it('throws when JWT_ACCESS_SECRET is too short', () => {
    expect(() => parseApiEnv({ ...validEnv, JWT_ACCESS_SECRET: 'too-short' })).toThrow();
  });

  it('coerces API_PORT from a string', () => {
    const env = parseApiEnv({ ...validEnv, API_PORT: '4100' });

    expect(env.API_PORT).toBe(4100);
  });

  it('parses COOKIE_SECURE strictly from the literal string "true"', () => {
    expect(parseApiEnv({ ...validEnv, COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
    expect(parseApiEnv({ ...validEnv, COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
  });

  it('rejects an invalid COOKIE_SECURE value instead of silently coercing it', () => {
    expect(() => parseApiEnv({ ...validEnv, COOKIE_SECURE: 'yes' })).toThrow();
  });
});
