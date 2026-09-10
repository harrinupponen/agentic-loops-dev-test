import { ROOT_CONTEXT, SpanKind, TraceFlags, trace } from '@opentelemetry/api';
import { SamplingDecision } from '@opentelemetry/sdk-trace-node';
import type { Context } from '@opentelemetry/api';
import type { Sampler } from '@opentelemetry/sdk-trace-node';
import { describe, expect, it } from 'vitest';
import { isTracedRoute } from '../../src/plugins/tracing.js';
import {
  createSampler,
  shutdownTracing,
  startedWithPreload,
  tracesEndpoint,
} from '../../src/telemetry.js';

// A trace id whose ratio hash is irrelevant here: every case below uses a ratio
// of exactly 0 or 1, where TraceIdRatioBasedSampler is deterministic.
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN_ID = '00f067aa0ba902b7';

function remoteParent(traceFlags: TraceFlags): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: PARENT_SPAN_ID,
    traceFlags,
    isRemote: true,
  });
}

function decide(sampler: Sampler, context: Context): SamplingDecision {
  return sampler.shouldSample(context, TRACE_ID, 'POST /api/todos', SpanKind.SERVER, {}, [])
    .decision;
}

describe('tracesEndpoint', () => {
  it('appends the signal path to a base URL', () => {
    expect(tracesEndpoint('http://localhost:4318')).toBe('http://localhost:4318/v1/traces');
  });

  it('does not double the slash when the base has a trailing one', () => {
    expect(tracesEndpoint('http://localhost:4318/')).toBe('http://localhost:4318/v1/traces');
    expect(tracesEndpoint('https://otlp.example.com/ingest/')).toBe(
      'https://otlp.example.com/ingest/v1/traces',
    );
  });
});

describe('createSampler', () => {
  it('samples every root span at ratio 1 and none at ratio 0', () => {
    expect(decide(createSampler(1), ROOT_CONTEXT)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decide(createSampler(0), ROOT_CONTEXT)).toBe(SamplingDecision.NOT_RECORD);
  });

  // The security property from ADR 0013: a caller on the public internet sets
  // `-01` on traceparent and cannot thereby raise our export volume, or a bill.
  it('ignores an inbound sampled flag: remote parents do not override the sampler', () => {
    expect(decide(createSampler(0), remoteParent(TraceFlags.SAMPLED))).toBe(
      SamplingDecision.NOT_RECORD,
    );
  });

  it('samples a remote parent that was not sampled when our own ratio says so', () => {
    expect(decide(createSampler(1), remoteParent(TraceFlags.NONE))).toBe(
      SamplingDecision.RECORD_AND_SAMPLED,
    );
  });
});

// The boot line's `pgInstrumented` is how a deploy is checked (see the spec's
// rollout), and it is false whenever the entrypoint change did not take.
describe('startedWithPreload', () => {
  it('recognises the entrypoint command, in both --import spellings', () => {
    expect(startedWithPreload(['--import', './dist/telemetry.js'])).toBe(true);
    expect(startedWithPreload(['--import=./dist/telemetry.js'])).toBe(true);
  });

  it('is false for a plain node dist/index.js, or a preload of something else', () => {
    expect(startedWithPreload([])).toBe(false);
    expect(startedWithPreload(['--enable-source-maps'])).toBe(false);
    expect(startedWithPreload(['--import', 'tsx'])).toBe(false);
  });
});

describe('shutdownTracing', () => {
  it('resolves quietly when tracing never started', async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});

describe('isTracedRoute', () => {
  it('traces API routes only', () => {
    expect(isTracedRoute('/api/todos')).toBe(true);
    expect(isTracedRoute('/api/todos/:id')).toBe(true);
    expect(isTracedRoute('/api/auth/login')).toBe(true);
  });

  it('leaves infrastructure and static routes alone', () => {
    expect(isTracedRoute('/healthz')).toBe(false);
    expect(isTracedRoute('/readyz')).toBe(false);
    expect(isTracedRoute('/metrics')).toBe(false);
    expect(isTracedRoute('/')).toBe(false);
    expect(isTracedRoute('/app/main.js')).toBe(false);
    // An unmatched route has no template at all, and a prefix that only looks
    // like the API prefix is not one.
    expect(isTracedRoute(undefined)).toBe(false);
    expect(isTracedRoute('/apidocs')).toBe(false);
  });
});
