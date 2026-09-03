/**
 * The browser's only way to reach the API. Deliberately free of DOM references
 * so the node-environment unit project can import it without jsdom.
 */

export interface ApiRequest {
  method?: string;
  body?: unknown;
  /** Merged after the defaults, so the caller wins. The only way to send an Idempotency-Key. */
  headers?: Record<string, string>;
}

/** Every non-2xx outcome, including transport failures, arrives as one of these. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

/** Shown for anything the server did not describe in the documented error shape. */
export const GENERIC_FAILURE = 'Something went wrong. Please try again.';

const TIMEOUT_MS = 10_000;

interface ErrorBody {
  error: { code: string; message: string };
  requestId?: string;
}

function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const error: unknown = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  return (
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

export async function apiFetch<T>(path: string, request: ApiRequest = {}): Promise<T> {
  const hasBody = request.body !== undefined;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (hasBody) headers['content-type'] = 'application/json';
  Object.assign(headers, request.headers);

  const response = await fetch(path, {
    method: request.method ?? 'GET',
    headers,
    // Stated rather than assumed: the session cookie must ride along, and it
    // must never be sent anywhere but this origin.
    credentials: 'same-origin',
    // Anything that can hang gets a timeout (AGENTS.md), browsers included.
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
  }).catch(() => {
    throw new ApiFailure(0, 'network', 'Cannot reach the server. Please try again.');
  });

  if (response.status === 204) return undefined as T;

  const payload: unknown = await (response.json() as Promise<unknown>).catch(() => undefined);

  if (response.ok) return payload as T;

  if (isErrorBody(payload)) {
    const requestId = (payload as { requestId?: unknown }).requestId;
    throw new ApiFailure(
      response.status,
      payload.error.code,
      payload.error.message,
      typeof requestId === 'string' ? requestId : undefined,
    );
  }

  // A proxy's HTML 502 or a truncated response: never surface a parse error and
  // never echo the body back at the user.
  throw new ApiFailure(response.status, 'unknown', GENERIC_FAILURE);
}
