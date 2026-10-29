/**
 * Lays out the history graph of the Activity view: which column ("lane") each loaded commit sits
 * in, and the lines that join a commit to its parents. Pure and synchronous: it reads only the
 * commits it is given, makes no request, and never looks at dates.
 *
 * The commits arrive in GitHub's order (newest first). The layout is one pass from the top, so:
 *  - it is `O(commits x lanes)` and cannot loop, whatever the data says;
 *  - rows already laid out never move when older commits are appended, so loading another page
 *    only adds rows (and connects lines that used to end in "not loaded");
 *  - GitHub's order is by commit date and is not guaranteed to put every parent below its child,
 *    so nothing here assumes it: a parent that is already listed above is reported, not drawn.
 *
 * A lane is a column that is waiting for one particular commit (a parent that has not been listed
 * yet). When that commit's row arrives, every line waiting for it ends there. Each commit then
 * opens lines to its parents: the first parent (the mainline) continues in the commit's own lane,
 * and any further parent of a merge joins a lane that already waits for it, or takes the lowest
 * free lane.
 *
 * Every special case is a distinct, counted state (see {@link GraphNode} and
 * {@link HistoryGraph}), so nothing is drawn that the data does not support:
 *  - a root commit (GitHub listed no parents) ends its lane;
 *  - a commit whose parents GitHub did not say (`null`) has no lines leaving it;
 *  - a parent that could not be read has no line, and is counted;
 *  - a parent that is not among the loaded commits leaves an open (dashed) line;
 *  - a parent that is listed above its child is not drawn (a line would run upwards); the child is
 *    marked and the Parents column says "listed above";
 *  - when all {@link MAX_GRAPH_LANES} lanes are in use, further links are dropped and counted, and
 *    a commit with no lane at all is shown in one extra overflow column.
 */

/** The most lanes drawn side by side. */
export const MAX_GRAPH_LANES = 12;
/** The extra column for a commit that found no free lane. It never carries a line of its own. */
export const OVERFLOW_LANE = MAX_GRAPH_LANES;

/** What the layout needs from a commit. */
export interface GraphCommit {
  readonly sha: string;
  /** In GitHub's order; `null` entries are parents that could not be read. `null`: not stated. */
  readonly parentShas: readonly (string | null)[] | null;
}

/**
 * - `commit`: one parent.
 * - `merge`: two or more parents.
 * - `root`: GitHub listed no parents.
 * - `unknown`: GitHub did not say what the parents are, so no line leaves it.
 */
export type GraphNodeKind = 'commit' | 'merge' | 'root' | 'unknown';

/**
 * What became of one parent entry of a commit. Every entry of a commit that is examined has exactly
 * one outcome, so nothing is counted twice and nothing is lost:
 * - `drawn`: a line was opened to it (it ends at the parent's row, or stays open when the parent is
 *   not loaded);
 * - `dropped`: every lane was in use, so no line was drawn;
 * - `above`: the parent is listed above this commit (or is this commit), so a line would run
 *   upwards: it is not drawn;
 * - `unreadable`: GitHub's entry could not be read, so there is nothing to draw.
 */
export type ParentLinkOutcome = 'drawn' | 'dropped' | 'above' | 'unreadable';

export interface GraphNode {
  readonly row: number;
  readonly sha: string;
  /** `0` to {@link MAX_GRAPH_LANES} `- 1`, or {@link OVERFLOW_LANE}. */
  readonly lane: number;
  readonly kind: GraphNodeKind;
  /**
   * One outcome per parent entry, in GitHub's order. Empty when the parents are not examined: a
   * root commit, a commit whose parents were not stated, and a repeated copy of a SHA (`duplicate`).
   */
  readonly links: readonly ParentLinkOutcome[];
  /** Parent entries that could not be read (they leave no line). */
  readonly invalidParents: number;
  /** Parent links not drawn because every lane was in use. */
  readonly droppedLinks: number;
  /** Parents that are already listed above this commit (or the commit itself): not drawn. */
  readonly outOfOrderParents: number;
  /** The same SHA was already listed above; this copy is drawn without any line. */
  readonly duplicate: boolean;
  /** No lane was free for this commit, so it is in the overflow column. */
  readonly overflow: boolean;
  /** A line that would have led here was dropped for lack of a lane. */
  readonly linkHidden: boolean;
}

export interface GraphEdge {
  readonly fromRow: number;
  readonly fromLane: number;
  /** The lane the line runs down in between the two rows. */
  readonly viaLane: number;
  /** The parent's row, or `null` when the parent is not among the loaded commits (an open end). */
  readonly toRow: number | null;
  readonly toLane: number | null;
  readonly parentSha: string;
  /** The first parent: the mainline. */
  readonly mainline: boolean;
}

export interface HistoryGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Columns to draw, including the overflow column when it is used. At least 1 for any commit. */
  readonly laneCount: number;
  /** Commits (copies aside) with two or more parents. */
  readonly merges: number;
  readonly roots: number;
  /** Commits whose parents GitHub did not state. */
  readonly unknownParents: number;
  /** Parent entries that could not be read, over all commits. */
  readonly invalidParentLinks: number;
  /** Distinct parent SHAs that lead to commits that are not loaded (open lines). */
  readonly openParents: number;
  /** Open lines (a parent can be reached from several commits). */
  readonly openLinks: number;
  /** Links not drawn because every lane was in use. */
  readonly droppedLinks: number;
  /** Commits placed in the overflow column. */
  readonly overflowCommits: number;
  /** Parent links to commits listed above their child. */
  readonly outOfOrderLinks: number;
  /** Extra copies of a SHA that was already listed. */
  readonly duplicates: number;
}

interface Origin {
  readonly row: number;
  readonly lane: number;
  readonly mainline: boolean;
}

interface Lane {
  readonly sha: string;
  readonly origins: Origin[];
}

function kindOf(parents: GraphCommit['parentShas']): GraphNodeKind {
  if (parents === null) return 'unknown';
  if (parents.length === 0) return 'root';
  return parents.length >= 2 ? 'merge' : 'commit';
}

export function buildHistoryGraph(commits: readonly GraphCommit[]): HistoryGraph {
  const lanes: (Lane | null)[] = Array.from({ length: MAX_GRAPH_LANES }, () => null);
  const seen = new Set<string>();
  /** SHAs whose incoming line was dropped, so that the commit can say so when it arrives. */
  const droppedFor = new Set<string>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let highestLane = -1;

  let merges = 0;
  let roots = 0;
  let unknownParents = 0;
  let invalidParentLinks = 0;
  let droppedLinks = 0;
  let overflowCommits = 0;
  let outOfOrderLinks = 0;
  let duplicates = 0;

  const lowestFree = (): number => lanes.findIndex((lane) => lane === null);
  const use = (lane: number): void => {
    if (lane > highestLane) highestLane = lane;
  };

  commits.forEach((commit, row) => {
    const duplicate = seen.has(commit.sha);
    seen.add(commit.sha);

    // The lanes that were waiting for this commit end here. (A repeated SHA is never waited for:
    // no line is opened to a SHA that was already listed.)
    const waiting: number[] = [];
    lanes.forEach((lane, index) => {
      if (lane !== null && lane.sha === commit.sha) waiting.push(index);
    });

    let nodeLane: number;
    let overflow = false;
    if (waiting.length > 0) {
      nodeLane = Math.min(...waiting);
    } else {
      const free = lowestFree();
      if (free === -1) {
        nodeLane = OVERFLOW_LANE;
        overflow = true;
      } else {
        nodeLane = free;
      }
    }
    use(nodeLane);

    for (const index of waiting) {
      const lane = lanes[index];
      if (lane === undefined || lane === null) continue;
      for (const origin of lane.origins) {
        edges.push({
          fromRow: origin.row,
          fromLane: origin.lane,
          viaLane: index,
          toRow: row,
          toLane: nodeLane,
          parentSha: commit.sha,
          mainline: origin.mainline,
        });
      }
      lanes[index] = null;
    }
    if (overflow) overflowCommits += 1;
    if (duplicate) duplicates += 1;

    const parents = commit.parentShas;
    const kind = kindOf(parents);
    let invalidParents = 0;
    let dropped = 0;
    let outOfOrder = 0;
    const links: ParentLinkOutcome[] = [];

    if (!duplicate && parents !== null) {
      parents.forEach((parent, position) => {
        if (parent === null) {
          invalidParents += 1;
          links.push('unreadable');
          return;
        }
        // Already listed above (or this very commit): a line to it would run upwards.
        if (seen.has(parent)) {
          outOfOrder += 1;
          links.push('above');
          return;
        }
        const mainline = position === 0;
        const origin: Origin = { row, lane: nodeLane, mainline };

        const existing = lanes.findIndex((lane) => lane !== null && lane.sha === parent);
        if (existing !== -1) {
          lanes[existing]?.origins.push(origin);
          links.push('drawn');
          return;
        }
        // The first parent carries on in the commit's own lane, if it has one.
        const target = mainline && !overflow ? nodeLane : lowestFree();
        if (target === -1 || lanes[target] !== null) {
          dropped += 1;
          droppedFor.add(parent);
          links.push('dropped');
          return;
        }
        lanes[target] = { sha: parent, origins: [origin] };
        links.push('drawn');
        use(target);
      });
    }

    if (!duplicate) {
      if (kind === 'merge') merges += 1;
      else if (kind === 'root') roots += 1;
      else if (kind === 'unknown') unknownParents += 1;
    }
    invalidParentLinks += invalidParents;
    droppedLinks += dropped;
    outOfOrderLinks += outOfOrder;

    nodes.push({
      row,
      sha: commit.sha,
      lane: nodeLane,
      kind,
      links,
      invalidParents,
      droppedLinks: dropped,
      outOfOrderParents: outOfOrder,
      duplicate,
      overflow,
      linkHidden: droppedFor.has(commit.sha),
    });
  });

  // Lanes still waiting at the end lead to commits that are not loaded: open lines.
  let openParents = 0;
  let openLinks = 0;
  lanes.forEach((lane, index) => {
    if (lane === null) return;
    openParents += 1;
    for (const origin of lane.origins) {
      openLinks += 1;
      edges.push({
        fromRow: origin.row,
        fromLane: origin.lane,
        viaLane: index,
        toRow: null,
        toLane: null,
        parentSha: lane.sha,
        mainline: origin.mainline,
      });
    }
  });

  return {
    nodes,
    edges,
    laneCount: highestLane + 1,
    merges,
    roots,
    unknownParents,
    invalidParentLinks,
    openParents,
    openLinks,
    droppedLinks,
    overflowCommits,
    outOfOrderLinks,
    duplicates,
  };
}

/** The most characters of a subject drawn beside a commit. */
export const GRAPH_SUBJECT_CHARS = 72;

/** Cuts at a code-point boundary, so a surrogate pair is never split. */
export function truncateSubject(subject: string, max: number = GRAPH_SUBJECT_CHARS): string {
  const points = Array.from(subject);
  return points.length <= max ? subject : `${points.slice(0, max).join('')}…`;
}
