import { useEffect, useState } from 'react';
import { DEFAULT_API_BASE_URL, fetchApiHealth } from './api.ts';

type ApiStatus =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ok'; readonly version: string }
  | { readonly kind: 'unreachable' };

export function App() {
  const [status, setStatus] = useState<ApiStatus>({ kind: 'checking' });

  useEffect(() => {
    const controller = new AbortController();
    const baseUrl = import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL;

    fetchApiHealth(baseUrl, controller.signal)
      .then((health) => setStatus({ kind: 'ok', version: health.version }))
      .catch(() => {
        if (!controller.signal.aborted) {
          setStatus({ kind: 'unreachable' });
        }
      });

    return () => controller.abort();
  }, []);

  return (
    <main className="app">
      <h1>GitHub Visual Universe</h1>
      <p>A read-only, open-source visual explorer for your GitHub account.</p>
      <p className="status" role="status">
        {status.kind === 'checking' && 'Checking API…'}
        {status.kind === 'ok' && `API online (v${status.version})`}
        {status.kind === 'unreachable' &&
          'API unreachable. It may be waking up; try again shortly.'}
      </p>
      <p className="note">
        Foundation scaffold: sign-in and visualizations are not implemented yet.
      </p>
    </main>
  );
}
