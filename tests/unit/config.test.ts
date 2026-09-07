import { describe, expect, it } from 'vitest';
import { allowedOrigins, loadConfig } from '../../src/config.js';

const base = {
  DATABASE_URL: 'postgres://localhost:5432/app',
  COOKIE_SECRET: 'a'.repeat(32),
};

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(base);
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.SESSION_TTL_HOURS).toBe(168);
  });

  it('rejects a short cookie secret', () => {
    expect(() => loadConfig({ ...base, COOKIE_SECRET: 'too-short' })).toThrow(/COOKIE_SECRET/);
  });

  it('rejects a missing database url', () => {
    expect(() => loadConfig({ COOKIE_SECRET: 'a'.repeat(32) })).toThrow(/DATABASE_URL/);
  });

  it('treats the string "false" as false', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
  });

  it('refuses the example cookie secret in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        COOKIE_SECRET: 'replace-me-with-at-least-32-characters-of-entropy',
      }),
    ).toThrow(/refusing to boot/);
  });

  it('leaves METRICS_TOKEN empty outside production', () => {
    expect(loadConfig(base).METRICS_TOKEN).toBe('');
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).METRICS_TOKEN).toBe('');
  });

  it('refuses to boot in production without a metrics token', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/METRICS_TOKEN/);
  });

  it('refuses the example metrics token in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        METRICS_TOKEN: 'replace-me-with-openssl-rand-base64-48-output',
      }),
    ).toThrow(/METRICS_TOKEN/);
  });

  it('refuses a short metrics token in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', METRICS_TOKEN: 'too-short' }),
    ).toThrow(/METRICS_TOKEN/);
  });

  it('accepts a strong metrics token in production', () => {
    const config = loadConfig({ ...base, NODE_ENV: 'production', METRICS_TOKEN: 'm'.repeat(32) });
    expect(config.METRICS_TOKEN).toBe('m'.repeat(32));
  });

  it('parses the origin allowlist', () => {
    const config = loadConfig({ ...base, ALLOWED_ORIGINS: 'https://a.com, https://b.com ,' });
    expect(allowedOrigins(config)).toEqual(['https://a.com', 'https://b.com']);
  });
});
