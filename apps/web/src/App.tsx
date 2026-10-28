import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_API_BASE_URL, fetchApiHealth } from './api.ts';
import { readAuthSettings } from './auth/config.ts';
import { useGitHubSession, type SessionDeps } from './auth/useGitHubSession.ts';
import { RepositoryDashboard } from './components/dashboard/RepositoryDashboard.tsx';

type ApiStatus =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ok'; readonly version: string }
  | { readonly kind: 'unreachable' };

export interface AppProps {
  /** Overrides for tests. In the real app everything comes from build-time env. */
  readonly auth?: Partial<SessionDeps>;
}

export function App({ auth }: AppProps = {}) {
  const [settings] = useState(() => auth?.settings ?? readAuthSettings(import.meta.env));
  const apiBaseUrl = settings.ok
    ? settings.settings.apiBaseUrl
    : (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL);

  const sessionDeps = useMemo<SessionDeps>(
    () => ({
      ...auth,
      settings,
      homeUrl: auth?.homeUrl ?? import.meta.env.BASE_URL,
    }),
    [auth, settings],
  );
  const { state, notice, connect, disconnect, expireSession } = useGitHubSession(sessionDeps);

  const [status, setStatus] = useState<ApiStatus>({ kind: 'checking' });

  useEffect(() => {
    const controller = new AbortController();

    fetchApiHealth(apiBaseUrl, controller.signal)
      .then((health) => setStatus({ kind: 'ok', version: health.version }))
      .catch(() => {
        if (!controller.signal.aborted) {
          setStatus({ kind: 'unreachable' });
        }
      });

    return () => controller.abort();
  }, [apiBaseUrl]);

  const signedIn = state.kind === 'signed_in';

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>GitHub Visual Universe</h1>
          <p className="tagline">
            A read-only, open-source visual explorer for your GitHub account.
          </p>
        </div>
        <div className="topbar-actions">
          <p className={`status status-${status.kind}`} role="status">
            {status.kind === 'checking' && 'Checking API…'}
            {status.kind === 'ok' && `API online (v${status.version})`}
            {status.kind === 'unreachable' &&
              'API unreachable. It may be waking up; try again shortly.'}
          </p>
          {signedIn && (
            <>
              <span className="chip chip-ok">Connected · read-only</span>
              <button type="button" onClick={() => void disconnect()}>
                Disconnect
              </button>
            </>
          )}
        </div>
      </header>

      <main className="content">
        {notice && (
          <div
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={`notice notice-${notice.tone}`}
          >
            {notice.text}
          </div>
        )}

        {!signedIn && (
          <section className="hero">
            <h2>Explore your GitHub universe</h2>
            <p>
              Connect your GitHub account to see an overview of every repository you can access,
              including private and organization repositories where the GitHub App is installed.
              This app only reads from GitHub and never changes anything.
            </p>

            {!settings.ok && <p className="note">Sign-in is not configured for this deployment.</p>}
            {settings.ok && state.kind === 'signed_out' && (
              <button type="button" className="primary" onClick={() => void connect()}>
                Connect GitHub
              </button>
            )}
            {state.kind === 'connecting' && <p role="status">Preparing sign-in…</p>}
            {state.kind === 'completing' && <p role="status">Completing sign-in…</p>}
          </section>
        )}

        {state.kind === 'signed_in' && (
          <RepositoryDashboard
            accessToken={state.token.accessToken}
            onUnauthorized={expireSession}
          />
        )}
      </main>

      <footer className="footer note">
        Read-only: nothing here creates, changes or deletes anything on GitHub. More visualizations
        are planned.
      </footer>
    </div>
  );
}
