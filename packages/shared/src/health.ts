import { z } from 'zod';

/** Identifier the API reports about itself. */
export const SERVICE_NAME = 'gvu-api' as const;

/** Contract of `GET /health`. Shared so the web app can validate what the API returns. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal(SERVICE_NAME),
  version: z.string().min(1),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
