/** PKCE (RFC 7636, method S256) and OAuth `state` helpers. Pure functions over Web Crypto. */

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** 32 random bytes encode to 43 base64url characters, the minimum RFC 7636 length. */
export function generateCodeVerifier(): string {
  return randomBase64Url(32);
}

/** Unguessable value that binds the callback to the browser session that started the flow. */
export function generateState(): string {
  return randomBase64Url(32);
}

/** `BASE64URL(SHA256(ASCII(verifier)))`. */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
