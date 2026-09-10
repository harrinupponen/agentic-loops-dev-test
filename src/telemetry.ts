import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type Sampler,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import client from 'prom-client';

/**
 * Tracing setup, loaded two ways and started once.
 *
 * `node --import ./dist/telemetry.js dist/index.js` evaluates this module before
 * the application's module graph, which is the only moment at which
 * `@opentelemetry/instrumentation-pg` can patch `pg`. `src/index.ts` then
 * imports the same specifier for `shutdownTracing()`; ESM keys modules by
 * resolved URL, so that is this same instance and not a second start.
 *
 * With `OTEL_EXPORTER_OTLP_ENDPOINT` empty — the value in every deployed
 * environment, see docs/adr/0012-traces-without-a-backend.md — nothing is
 * constructed, no provider is registered, and `trace.getTracer()` keeps handing
 * back the API's no-op implementation.
 */

export interface TracingStatus {
  tracing: 'enabled' | 'disabled';
  sampleRatio: number;
  /**
   * Whether the `--import` preload evaluated this module early enough to patch
   * `pg`. False means the entrypoint change did not take, which is the one
   * misconfiguration that silently halves this feature's value — and the line
   * to read on a deploy, while tracing itself is still disabled everywhere.
   */
  pgInstrumented: boolean;
}

/**
 * Wraps the exporter's result callback so a collector that has started
 * rejecting batches is visible somewhere other than stderr. Registered onto the
 * application registry by `src/plugins/metrics.ts`: the preload runs long
 * before that registry exists, hence `registers: []` here.
 */
export const spansExported = new client.Counter({
  name: 'trace_spans_exported_total',
  help: 'Spans handed to the OTLP exporter, by outcome',
  labelNames: ['outcome'],
  registers: [],
});

const FLUSH_TIMEOUT_MS = 2_000;

let provider: NodeTracerProvider | undefined;
let status: TracingStatus = { tracing: 'disabled', sampleRatio: 0, pgInstrumented: false };
let started = false;

/** The OTLP/HTTP traces signal path, appended to the configured base URL. */
export function tracesEndpoint(base: string): string {
  return `${base.replace(/\/+$/, '')}/v1/traces`;
}

/**
 * Head sampling at `ratio`, applied to root spans and to remote parents alike.
 * An inbound `traceparent` therefore contributes its trace id and nothing else:
 * a caller on the public internet cannot raise our export volume — or a future
 * bill — by setting the sampled flag (ADR 0013).
 */
export function createSampler(ratio: number): Sampler {
  const ratioSampler = new TraceIdRatioBasedSampler(ratio);
  return new ParentBasedSampler({
    root: ratioSampler,
    remoteParentSampled: ratioSampler,
    remoteParentNotSampled: ratioSampler,
    // Local parents are our own spans: a `pg` query inside a sampled request
    // stays with its trace, and one inside an unsampled request stays out.
  });
}

class CountingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      const outcome = result.code === ExportResultCode.SUCCESS ? 'succeeded' : 'failed';
      spansExported.inc({ outcome }, spans.length);
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** `k=v,k2=v2`. The values are credentials, so nothing here is ever logged. */
function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key && value) headers[key] = value;
  }
  return headers;
}

/**
 * True when this process was started with the preload. The path is matched
 * literally rather than read from an environment variable — a module path from
 * the environment is an arbitrary-code-load primitive for anyone who can set
 * env on the application.
 */
export function startedWithPreload(argv: string[] = process.execArgv): boolean {
  return argv.some(
    (arg, index) =>
      (arg === '--import' && (argv[index + 1] ?? '').includes('telemetry')) ||
      (arg.startsWith('--import=') && arg.includes('telemetry')),
  );
}

/**
 * Idempotent: a second call returns the first call's outcome untouched, so
 * `node dist/index.js` without the preload still serves — with server spans but
 * no Postgres spans, which the boot line reports as `pgInstrumented: false`.
 *
 * Never throws. A malformed endpoint leaves tracing off here and is refused by
 * `loadConfig` moments later, in the process that can report it properly.
 */
export function startTracing(env: NodeJS.ProcessEnv = process.env): TracingStatus {
  if (started) return status;
  started = true;
  status = { ...status, pgInstrumented: startedWithPreload() };

  const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim();
  if (!endpoint) return status;

  const ratio = Number(env.TRACE_SAMPLE_RATIO ?? '0.1');
  const sampleRatio = Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 0.1;

  try {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

    const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS ?? '');
    const exporter = new CountingSpanExporter(
      new OTLPTraceExporter({
        url: tracesEndpoint(endpoint),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      }),
    );

    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? 'agentic-todo',
      }),
      sampler: createSampler(sampleRatio),
      spanProcessors: [
        // Bounded and drop-on-full: a dead collector costs memory and spans,
        // never backpressure into request handling.
        new BatchSpanProcessor(exporter, { maxQueueSize: 2048, maxExportBatchSize: 512 }),
      ],
    });
    provider.register();

    registerInstrumentations({
      instrumentations: [
        new PgInstrumentation({
          // Parameterised SQL only: `insert into "todos" ... values ($1, $2)`,
          // never the title.
          enhancedDatabaseReporting: false,
          // No orphan spans from migrations or from /readyz's `select 1`.
          requireParentSpan: true,
        }),
      ],
    });

    status = { tracing: 'enabled', sampleRatio, pgInstrumented: startedWithPreload() };
  } catch (err) {
    diag.error('tracing failed to start', err);
    provider = undefined;
    status = { tracing: 'disabled', sampleRatio: 0, pgInstrumented: status.pgInstrumented };
  }

  return status;
}

/** What the boot line reports; also how tests assert the inert configuration. */
export function tracingStatus(): TracingStatus {
  return status;
}

/**
 * Flushes whatever is queued, capped so a hostile collector cannot hold the
 * process open inside SHUTDOWN_GRACE_MS. A failed flush is logged and dropped:
 * losing spans is never a reason to fail an exit.
 */
export async function shutdownTracing(): Promise<void> {
  const current = provider;
  if (!current) return;
  provider = undefined;

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      current.shutdown(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } catch (err) {
    diag.error('tracing shutdown failed', err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Self-starting: this is the whole point of the `--import` target.
startTracing();
