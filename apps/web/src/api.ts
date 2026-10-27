import { healthResponseSchema, type HealthResponse } from '@gvu/shared';

export const DEFAULT_API_BASE_URL = 'http://localhost:8787';

/** Calls our own API's `/health` (not GitHub) and validates the response against the shared contract. */
export async function fetchApiHealth(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<HealthResponse> {
  const init: RequestInit = signal ? { signal } : {};
  const res = await fetch(new URL('/health', baseUrl), init);
  if (!res.ok) {
    throw new Error(`API responded with HTTP ${String(res.status)}`);
  }
  return healthResponseSchema.parse(await res.json());
}
