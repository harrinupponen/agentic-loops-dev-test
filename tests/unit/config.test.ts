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

  it('defaults the email verification TTL to 24 hours and coerces a string', () => {
    expect(loadConfig(base).EMAIL_VERIFICATION_TTL_HOURS).toBe(24);
    expect(
      loadConfig({ ...base, EMAIL_VERIFICATION_TTL_HOURS: '48' }).EMAIL_VERIFICATION_TTL_HOURS,
    ).toBe(48);
  });

  it('rejects a zero or non-integer email verification TTL', () => {
    expect(() => loadConfig({ ...base, EMAIL_VERIFICATION_TTL_HOURS: '0' })).toThrow(
      /EMAIL_VERIFICATION_TTL_HOURS/,
    );
    expect(() => loadConfig({ ...base, EMAIL_VERIFICATION_TTL_HOURS: '1.5' })).toThrow(
      /EMAIL_VERIFICATION_TTL_HOURS/,
    );
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

  it('leaves tracing off by default', () => {
    const config = loadConfig(base);
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('');
    expect(config.OTEL_EXPORTER_OTLP_HEADERS).toBe('');
    expect(config.OTEL_SERVICE_NAME).toBe('agentic-todo');
    expect(config.TRACE_SAMPLE_RATIO).toBe(0.1);
  });

  // OTEL_EXPORTER_OTLP_HEADERS is a credential; plaintext OTLP to anywhere but
  // a sidecar puts it on the wire in clear (ADR 0007, ADR 0012).
  it('refuses a plaintext OTLP endpoint to a remote host in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        METRICS_TOKEN: 'm'.repeat(32),
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.com:4318',
      }),
    ).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
  });

  it('accepts a plaintext OTLP endpoint on loopback in production', () => {
    for (const endpoint of ['http://localhost:4318', 'http://127.0.0.1:4318']) {
      const config = loadConfig({
        ...base,
        NODE_ENV: 'production',
        METRICS_TOKEN: 'm'.repeat(32),
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      });
      expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(endpoint);
    }
  });

  it('accepts an https OTLP endpoint to a remote host in production', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      METRICS_TOKEN: 'm'.repeat(32),
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com',
    });
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://collector.example.com');
  });

  // A typo here means silence, and silence is the failure mode the whole
  // feature exists to remove — so it fails the boot in every NODE_ENV.
  it('refuses an unparseable OTLP endpoint in any environment', () => {
    for (const env of ['development', 'test', 'production'] as const) {
      expect(() =>
        loadConfig({
          ...base,
          NODE_ENV: env,
          METRICS_TOKEN: 'm'.repeat(32),
          OTEL_EXPORTER_OTLP_ENDPOINT: 'localhost:4318',
        }),
      ).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
    }
  });

  it('refuses OTLP headers with no endpoint to send them to', () => {
    expect(() =>
      loadConfig({ ...base, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer nope' }),
    ).toThrow(/OTEL_EXPORTER_OTLP_HEADERS/);
  });

  it('rejects a sample ratio outside 0 to 1', () => {
    expect(() => loadConfig({ ...base, TRACE_SAMPLE_RATIO: '1.5' })).toThrow(/TRACE_SAMPLE_RATIO/);
    expect(() => loadConfig({ ...base, TRACE_SAMPLE_RATIO: '-0.1' })).toThrow(/TRACE_SAMPLE_RATIO/);
    expect(loadConfig({ ...base, TRACE_SAMPLE_RATIO: '1' }).TRACE_SAMPLE_RATIO).toBe(1);
    expect(loadConfig({ ...base, TRACE_SAMPLE_RATIO: '0' }).TRACE_SAMPLE_RATIO).toBe(0);
  });

  // A typo in REDIS_URL would leave the limiter counting per instance forever,
  // which is exactly the state F-011 exists to make visible — so a set-but-wrong
  // value refuses the boot in every NODE_ENV (ADR 0018).
  it('refuses an unparseable REDIS_URL', () => {
    expect(() => loadConfig({ ...base, REDIS_URL: 'localhost:6379' })).toThrow(/REDIS_URL/);
  });

  it('refuses a REDIS_URL whose scheme is not redis: or rediss:', () => {
    expect(() => loadConfig({ ...base, REDIS_URL: 'postgres://localhost:5432/app' })).toThrow(
      /REDIS_URL/,
    );
    expect(loadConfig({ ...base, REDIS_URL: 'redis://localhost:6379' }).REDIS_URL).toBe(
      'redis://localhost:6379',
    );
    expect(loadConfig({ ...base, REDIS_URL: 'rediss://localhost:6379' }).REDIS_URL).toBe(
      'rediss://localhost:6379',
    );
  });

  it('rejects a REDIS_TIMEOUT_MS outside 1..1000', () => {
    expect(() => loadConfig({ ...base, REDIS_TIMEOUT_MS: '0' })).toThrow(/REDIS_TIMEOUT_MS/);
    expect(() => loadConfig({ ...base, REDIS_TIMEOUT_MS: '1001' })).toThrow(/REDIS_TIMEOUT_MS/);
    expect(loadConfig(base).REDIS_TIMEOUT_MS).toBe(50);
  });

  // The deliberate, narrow departure from ADR 0007: an empty REDIS_URL removes
  // no control, it leaves the per-instance limiter at exactly today's strength.
  it('accepts an empty REDIS_URL under NODE_ENV=production', () => {
    const config = loadConfig({ ...base, NODE_ENV: 'production', METRICS_TOKEN: 'm'.repeat(32) });
    expect(config.REDIS_URL).toBe('');
  });

  // The cache claims a capability that does not exist without a store, and the
  // failure it would otherwise produce is silence — so this is a boot failure in
  // every NODE_ENV, the same "set and wrong" rule REDIS_URL already carries.
  it('refuses TODO_LIST_CACHE_ENABLED=true with an empty REDIS_URL', () => {
    expect(() => loadConfig({ ...base, TODO_LIST_CACHE_ENABLED: 'true' })).toThrow(
      /TODO_LIST_CACHE_ENABLED/,
    );
    expect(
      loadConfig({ ...base, TODO_LIST_CACHE_ENABLED: 'true', REDIS_URL: 'redis://localhost:6379' })
        .TODO_LIST_CACHE_ENABLED,
    ).toBe(true);
  });

  it('rejects a TODO_LIST_CACHE_TTL_SECONDS outside 1..300', () => {
    expect(() => loadConfig({ ...base, TODO_LIST_CACHE_TTL_SECONDS: '0' })).toThrow(
      /TODO_LIST_CACHE_TTL_SECONDS/,
    );
    expect(() => loadConfig({ ...base, TODO_LIST_CACHE_TTL_SECONDS: '301' })).toThrow(
      /TODO_LIST_CACHE_TTL_SECONDS/,
    );
    expect(loadConfig(base).TODO_LIST_CACHE_TTL_SECONDS).toBe(30);
  });

  // Off is the default and an absent cache is not even a degraded state: it is
  // the current, tested behaviour of the endpoint (ADR 0021).
  it('accepts the cache defaults under NODE_ENV=production', () => {
    const config = loadConfig({ ...base, NODE_ENV: 'production', METRICS_TOKEN: 'm'.repeat(32) });
    expect(config.TODO_LIST_CACHE_ENABLED).toBe(false);
    expect(config.TODO_LIST_CACHE_TTL_SECONDS).toBe(30);
  });

  it('parses the origin allowlist', () => {
    const config = loadConfig({ ...base, ALLOWED_ORIGINS: 'https://a.com, https://b.com ,' });
    expect(allowedOrigins(config)).toEqual(['https://a.com', 'https://b.com']);
  });
});
