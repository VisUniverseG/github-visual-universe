import { z } from 'zod';

// Contracts of the auth broker (`apps/api`) as seen by the web app.
//
// The broker only ever returns the access token and its lifetime. The refresh token that
// GitHub also returns is discarded by the broker and is deliberately not part of any schema.

/** Characters allowed in an authorization code and in an RFC 7636 PKCE code verifier. */
const UNRESERVED = /^[A-Za-z0-9._~-]+$/;

/** `POST /auth/token` request body. */
export const tokenExchangeRequestSchema = z.strictObject({
  code: z.string().min(1).max(512).regex(UNRESERVED),
  // RFC 7636: 43 to 128 unreserved characters.
  code_verifier: z.string().min(43).max(128).regex(UNRESERVED),
  redirect_uri: z.string().min(1).max(2048),
});
export type TokenExchangeRequest = z.infer<typeof tokenExchangeRequestSchema>;

/** `POST /auth/token` success body. */
export const tokenExchangeResponseSchema = z.strictObject({
  access_token: z.string().min(1),
  // Seconds. The GitHub App must have user-token expiration enabled.
  expires_in: z.number().int().positive(),
});
export type TokenExchangeResponse = z.infer<typeof tokenExchangeResponseSchema>;

/** `POST /auth/revoke` request body. */
export const revokeRequestSchema = z.strictObject({
  access_token: z.string().min(1).max(512),
});
export type RevokeRequest = z.infer<typeof revokeRequestSchema>;

/** `POST /auth/revoke` success body. Only sent when GitHub itself confirmed the revocation. */
export const revokeResponseSchema = z.strictObject({
  revoked: z.literal(true),
});
export type RevokeResponse = z.infer<typeof revokeResponseSchema>;

/** Every error the broker can return. Deliberately generic: no upstream detail leaks. */
export const AUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_redirect_uri',
  'invalid_grant',
  'origin_not_allowed',
  'unsupported_media_type',
  'payload_too_large',
  'auth_not_configured',
  'upstream_error',
  'revocation_not_confirmed',
  'not_found',
  'internal_error',
] as const;

export const authErrorCodeSchema = z.enum(AUTH_ERROR_CODES);
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;

export const authErrorSchema = z.strictObject({ error: authErrorCodeSchema });
export type AuthError = z.infer<typeof authErrorSchema>;
