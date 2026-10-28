import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import type { DirectoryFailure, LoaderSnapshot } from '../../architecture/loader.ts';
import {
  ARCHITECTURE_MESSAGES,
  describeDirectoryFailure,
  describeRateLimitReset,
  partialTreeMessage,
} from '../../architecture/messages.ts';
import { ancestors, displayText } from '../../architecture/model.ts';
import type { TreeNode } from '../../architecture/store.ts';
import type { Metric } from '../../architecture/treemap.ts';
import { useDirectoryLoader } from '../../architecture/useDirectoryLoader.ts';
import { useRepositoryTree } from '../../architecture/useRepositoryTree.ts';
import { boundedFigure, formatBytes, formatCount } from '../../dashboard/format.ts';
import type { RepositoryTree } from '../../github/tree.ts';
import type { RepositoryItem } from '../../github/repositories.ts';
import { HandoffButton } from '../HandoffButton.tsx';
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
          <HandoffButton focusTarget={headingRef} onClick={retry}>
            Try again
          </HandoffButton>
        </div>
      )}

      {state.phase === 'ready' && (
        <TreeExplorer
          repo={repo}
          tree={state.tree}
          accessToken={accessToken}
          onUnauthorized={onUnauthorized}
          onRetry={retry}
          focusTarget={headingRef}
        />
      )}
    </section>
  );
}

/** Gives the explorer its loader, so the explorer itself only ever deals with a usable one. */
function TreeExplorer({
  repo,
  tree,
  accessToken,
  onUnauthorized,
  onRetry,
  focusTarget,
}: {
  readonly repo: RepositoryItem;
  readonly tree: RepositoryTree;
  readonly accessToken: string;
  readonly onUnauthorized: () => void;
  readonly onRetry: () => void;
  readonly focusTarget: RefObject<HTMLElement | null>;
}) {
  const loader = useDirectoryLoader({
    accessToken,
    owner: repo.owner,
    name: repo.name,
    tree,
    onUnauthorized,
  });

  if (!loader.usable) {
    return (
      <div role="alert" className="notice notice-error">
        <p>{ARCHITECTURE_MESSAGES.unusableTree}</p>
        <HandoffButton focusTarget={focusTarget} onClick={onRetry}>
          Try again
        </HandoffButton>
      </div>
    );
  }
  return (
    <LoadedExplorer
      repo={repo}
      tree={tree}
      snapshot={loader.snapshot}
      loadDirectory={loader.loadDirectory}
    />
  );
}

function LoadedExplorer({
  repo,
  tree,
  snapshot,
  loadDirectory,
}: {
  readonly repo: RepositoryItem;
  readonly tree: RepositoryTree;
  readonly snapshot: LoaderSnapshot;
  readonly loadDirectory: (directoryId: number) => Promise<unknown>;
}) {
  const model = snapshot.tree;
  const [focusId, setFocusId] = useState(0);
  // Folder ids belong to one loader. A new loader (another token, tree or repository) starts at
  // the root, never at an id that now means something else.
  const [forLoader, setForLoader] = useState(() => loadDirectory);
  if (forLoader !== loadDirectory) {
    setForLoader(() => loadDirectory);
    setFocusId(0);
  }
  const [metric, setMetric] = useState<Metric>('bytes');
  const [showAll, setShowAll] = useState(false);
  const metricName = useId();
  const contentsRef = useRef<HTMLHeadingElement>(null);
  const movedByUser = useRef(false);

  const directory = model.nodes[focusId] ?? model.root;
  const crumbs = ancestors(model, directory.id);
  // Folders GitHub cut off, and folders that were never listed and cannot be (no usable SHA).
  const { cutOffFolders, unloadableFolders } = useMemo(() => {
    let cutOff = 0;
    let unloadable = 0;
    for (const node of model.nodes) {
      if (node.kind !== 'directory') continue;
      if (node.truncated) cutOff += 1;
      if (node.status === 'unloaded' && !node.loadable) unloadable += 1;
    }
    return { cutOffFolders: cutOff, unloadableFolders: unloadable };
  }, [model.nodes]);
  const partial = model.totals.exact
    ? null
    : partialTreeMessage({
        // Only a repository GitHub could not list in one piece is read folder by folder.
        truncated: tree.mode === 'lazy',
        skipped: model.skipped,
        inconsistent: model.inconsistent,
        // Not yet loaded but loadable: the ones opening a folder can still bring in.
        unloadedDirectories: model.totals.unloadedDirectories - unloadableFolders,
        unloadableDirectories: unloadableFolders,
        cutOffFolders,
      });
  const exact = partial === null;
  const { totals } = model;
  const isEmpty = model.root.children.length === 0;
  const place = directory.path === '' ? repo.name : directory.path;

  // Only a folder nobody has listed (or whose last request failed) is requested. The loader
  // would refuse any other, but there is no reason to ask it.
  // After a 401 the loader refuses every request, so nothing is offered that would only fail.
  const sessionEnded = snapshot.unauthorized;
  const load = (node: TreeNode) => {
    if (sessionEnded) return;
    if (node.status === 'unloaded' || node.status === 'failed') void loadDirectory(node.id);
  };

  const open = (id: number) => {
    movedByUser.current = true;
    setFocusId(id);
    setShowAll(false);
    const node = model.nodes[id];
    if (node !== undefined) load(node);
  };
  const listed = directory.status === 'shallow' || directory.status === 'complete';
  const failure = snapshot.failures.get(directory.id);

  // The folder button that was clicked is replaced by the new folder's rows, so move focus to the
  // heading of the new listing instead of letting it fall back to the page.
  useEffect(() => {
    if (movedByUser.current) {
      movedByUser.current = false;
      contentsRef.current?.focus();
    }
  }, [focusId]);

  // Every count is a lower bound until the whole tree is listed (`totals.exact`). The total size
  // also stays one while a file has no reported size (`totals.bytesExact`).
  const stats: { label: string; value: string }[] = [
    { label: 'Files', value: boundedFigure(totals.files, formatCount, totals.exact) },
    { label: 'Folders', value: boundedFigure(totals.directories, formatCount, totals.exact) },
    { label: 'Total size', value: boundedFigure(totals.bytes, formatBytes, totals.bytesExact) },
    { label: 'Deepest level', value: boundedFigure(totals.maxDepth, formatCount, totals.exact) },
  ];
  if (totals.symlinks > 0) {
    stats.push({
      label: 'Symlinks',
      value: boundedFigure(totals.symlinks, formatCount, totals.exact),
    });
  }
  if (totals.submodules > 0) {
    stats.push({
      label: 'Submodules',
      value: boundedFigure(totals.submodules, formatCount, totals.exact),
    });
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

      {snapshot.blockedUntil !== null && (
        <p role="status" className="notice notice-warning">
          {describeRateLimitReset(snapshot.blockedUntil)}
        </p>
      )}

      {snapshot.unauthorized && (
        <p role="alert" className="notice notice-error">
          {ARCHITECTURE_MESSAGES.unauthorized}
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

            {listed && <Treemap directory={directory} metric={metric} onOpen={open} />}

            <h3 ref={contentsRef} tabIndex={-1} className="contents-heading">
              Contents of {place}
            </h3>
            {directory.truncated && (
              <p className="note">
                GitHub cut off this folder&apos;s listing because it is too large, so some of its
                entries are missing. They cannot be loaded, and asking again will not bring them
                back.
              </p>
            )}
            {listed ? (
              <DirectoryTable
                directory={directory}
                showAll={showAll}
                onShowAll={() => {
                  setShowAll(true);
                }}
                onOpen={open}
              />
            ) : (
              <FolderState
                directory={directory}
                failure={failure}
                canLoad={!sessionEnded}
                focusTarget={contentsRef}
                onLoad={() => {
                  load(directory);
                }}
              />
            )}
          </section>

          <ExtensionChart extensions={model.extensions} totalFiles={totals.files} />
        </>
      )}
    </>
  );
}

/** What stands in for the table of a folder whose contents have not arrived. */
function FolderState({
  directory,
  failure,
  canLoad,
  focusTarget,
  onLoad,
}: {
  readonly directory: TreeNode;
  readonly failure: DirectoryFailure | undefined;
  /** `false` once the session has ended: loading and retrying are no longer offered. */
  readonly canLoad: boolean;
  /** Where focus goes when the button that was used is replaced by the loading state. */
  readonly focusTarget: RefObject<HTMLElement | null>;
  readonly onLoad: () => void;
}) {
  if (directory.status === 'loading') {
    return (
      <p role="status" className="loading">
        {ARCHITECTURE_MESSAGES.folderLoading}
      </p>
    );
  }
  if (directory.status === 'failed') {
    return (
      <div role="alert" className="notice notice-error">
        <p>
          {failure === undefined
            ? ARCHITECTURE_MESSAGES.folderUnusable
            : describeDirectoryFailure(failure)}
        </p>
        {canLoad && (failure?.retryable ?? false) && (
          <HandoffButton focusTarget={focusTarget} onClick={onLoad}>
            Try again
          </HandoffButton>
        )}
      </div>
    );
  }
  if (!directory.loadable) return <p className="note">{ARCHITECTURE_MESSAGES.folderNoSha}</p>;
  return (
    <p className="note">
      {ARCHITECTURE_MESSAGES.folderNotLoaded}{' '}
      {canLoad && (
        <HandoffButton focusTarget={focusTarget} onClick={onLoad}>
          Load this folder
        </HandoffButton>
      )}
    </p>
  );
}
