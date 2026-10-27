/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_BASE_PATH?: string;
  /** Public identifier of the GitHub App (not a secret). */
  readonly VITE_GITHUB_APP_CLIENT_ID?: string;
  /** Exact OAuth callback URI registered on the GitHub App. */
  readonly VITE_AUTH_REDIRECT_URI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
