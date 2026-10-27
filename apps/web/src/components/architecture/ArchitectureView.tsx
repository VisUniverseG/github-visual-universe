import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ARCHITECTURE_MESSAGES, partialTreeMessage } from '../../architecture/messages.ts';
import { ancestors, buildArchitecture, displayText } from '../../architecture/model.ts';
import type { Metric } from '../../architecture/treemap.ts';
import { useRepositoryTree } from '../../architecture/useRepositoryTree.ts';
import { formatBytes, formatCount } from '../../dashboard/format.ts';
import type { RepositoryTree } from '../../github/tree.ts';
import type { RepositoryItem } from '../../github/repositories.ts';
import { DirectoryTable } from './DirectoryTable.tsx';
import { ExtensionChart } from './ExtensionChart.tsx';
import { Treemap } from './Treemap.tsx';

interface Props {
  readonly repo: RepositoryItem;
  readonly accessToken: string;
  /** Called when GitHub rejects the token (401). Must be referentially stable. */
  readonly onUnauthorized: () => void;
  readonly onBack: () => void;
}

/** Architecture of one repository: its default branch's file tree, read-only. */
export function ArchitectureView({ repo, accessToken, onUnauthorized, onBack }: Props) {
  const { state, retry } = useRepositoryTree(
    accessToken,
    repo.owner,
    repo.name,
    repo.defaultBranch,
    onUnauthorized,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Land on the new view: keyboard and screen-reader users start at its heading.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section aria-labelledby="architecture-heading" className="architecture">
      <div className="architecture-head">
        <button type="button" onClick={onBack}>
          ← Back to repositories
        </button>
        <h2 id="architecture-heading" ref={headingRef} tabIndex={-1}>
          {repo.fullName} · Architecture
        </h2>
      </div>

      {state.phase === 'loading' && (
        <p role="status" className="loading">
          Loading file tree…
        </p>
      )}

      {state.phase === 'error' && (
        <div role="alert" className="notice notice-error">
          <p>{state.errorText}</p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </div>
      )}

      {state.phase === 'ready' && <TreeExplorer repo={repo} tree={state.tree} />}
    </section>
  );
}

function TreeExplorer({
  repo,
  tree,
}: {
  readonly repo: RepositoryItem;
  readonly tree: RepositoryTree;
}) {
  const model = useMemo(() => buildArchitecture(tree.entries), [tree.entries]);
  const [focusId, setFocusId] = useState(0);
  const [metric, setMetric] = useState<Metric>('bytes');
  const [showAll, setShowAll] = useState(false);
  const metricName = useId();
  const contentsRef = useRef<HTMLHeadingElement>(null);
  const movedByUser = useRef(false);

  const directory = model.nodes[focusId] ?? model.root;
  const crumbs = ancestors(model, directory.id);
  const partial = partialTreeMessage({
    truncated: tree.truncated,
    skipped: tree.skipped,
    inconsistent: model.inconsistent,
  });
  const exact = partial === null;
  const { totals } = model;
  const isEmpty = model.root.children.length === 0;
  const place = directory.path === '' ? repo.name : directory.path;

  const open = (id: number) => {
    movedByUser.current = true;
    setFocusId(id);
    setShowAll(false);
  };

  // The folder button that was clicked is replaced by the new folder's rows, so move focus to the
  // heading of the new listing instead of letting it fall back to the page.
  useEffect(() => {
    if (movedByUser.current) {
      movedByUser.current = false;
      contentsRef.current?.focus();
    }
  }, [focusId]);

  const stats: { label: string; value: string }[] = [
    { label: 'Files', value: formatCount(totals.files) },
    { label: 'Folders', value: formatCount(totals.directories) },
    { label: 'Total size', value: formatBytes(totals.bytes) },
    { label: 'Deepest level', value: formatCount(totals.maxDepth) },
  ];
  if (totals.symlinks > 0) stats.push({ label: 'Symlinks', value: formatCount(totals.symlinks) });
  if (totals.submodules > 0) {
    stats.push({ label: 'Submodules', value: formatCount(totals.submodules) });
  }

  return (
    <>
      <p className="note">
        Snapshot of branch <strong>{displayText(tree.branch)}</strong> at commit{' '}
        <code>{tree.commitSha.slice(0, 7)}</code>. Only file and folder names and sizes are read:
        never file contents.
      </p>

      {partial !== null && (
        <p role="status" className="notice notice-warning">
          {partial}
        </p>
      )}

      {isEmpty ? (
        // "No files" is only a fact when nothing was cut off or unreadable.
        exact && <p className="note empty">{ARCHITECTURE_MESSAGES.noFiles}</p>
      ) : (
        <>
          <section aria-labelledby="architecture-summary-heading" className="panel">
            <div className="panel-head">
              <h2 id="architecture-summary-heading">Summary</h2>
              <span className={`chip ${exact ? 'chip-ok' : 'chip-warn'}`}>
                {exact
                  ? `Complete · ${formatCount(totals.files)} ${totals.files === 1 ? 'file' : 'files'}`
                  : `Partial · ${formatCount(totals.files)} ${totals.files === 1 ? 'file' : 'files'} counted`}
              </span>
            </div>
            <dl className="stats">
              {stats.map((stat) => (
                <div key={stat.label} className="stat">
                  <dt>{stat.label}</dt>
                  <dd>{stat.value}</dd>
                </div>
              ))}
            </dl>
            {totals.filesWithoutSize > 0 && (
              <p className="note">
                {formatCount(totals.filesWithoutSize)}{' '}
                {totals.filesWithoutSize === 1 ? 'file has' : 'files have'} no size from GitHub and{' '}
                {totals.filesWithoutSize === 1 ? 'adds' : 'add'} nothing to the total size.
              </p>
            )}
          </section>

          <section aria-labelledby="structure-heading" className="panel">
            <div className="panel-head">
              <h2 id="structure-heading">Structure</h2>
              <fieldset className="metric">
                <legend>Size tiles by</legend>
                <label>
                  <input
                    type="radio"
                    name={metricName}
                    checked={metric === 'bytes'}
                    onChange={() => {
                      setMetric('bytes');
                    }}
                  />{' '}
                  Bytes
                </label>
                <label>
                  <input
                    type="radio"
                    name={metricName}
                    checked={metric === 'files'}
                    onChange={() => {
                      setMetric('files');
                    }}
                  />{' '}
                  File count
                </label>
              </fieldset>
            </div>

            <nav aria-label="Breadcrumb">
              <ol className="crumbs">
                {crumbs.map((node, index) => (
                  <li key={node.id}>
                    {index === crumbs.length - 1 ? (
                      <span aria-current="page">{node.id === 0 ? repo.name : node.name}</span>
                    ) : (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          open(node.id);
                        }}
                      >
                        {node.id === 0 ? repo.name : node.name}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </nav>

            <Treemap directory={directory} metric={metric} onOpen={open} />

            <h3 ref={contentsRef} tabIndex={-1} className="contents-heading">
              Contents of {place}
            </h3>
            <DirectoryTable
              directory={directory}
              showAll={showAll}
              onShowAll={() => {
                setShowAll(true);
              }}
              onOpen={open}
            />
          </section>

          <ExtensionChart extensions={model.extensions} totalFiles={totals.files} />
        </>
      )}
    </>
  );
}
