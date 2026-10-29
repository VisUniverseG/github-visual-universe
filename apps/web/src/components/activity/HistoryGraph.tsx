import {
  MAX_GRAPH_LANES,
  truncateSubject,
  type GraphEdge,
  type GraphNode,
  type GraphNodeKind,
  type HistoryGraph as Graph,
} from '../../activity/historyGraph.ts';
import { historyGraphLabel, historyGraphNotes } from '../../activity/messages.ts';
import { formatCount } from '../../dashboard/format.ts';
import type { CommitItem, PageNext } from '../../github/activity.ts';

const ROW = 24;
const LANE = 16;
const LEFT = 14;
const TOP = 6;
const RADIUS = 5;
/** Room for the longest label: a short SHA and a subject, at 12px. */
const LABEL_WIDTH = 620;
const LANE_COLOURS = 6;

const x = (lane: number): number => LEFT + lane * LANE;
const y = (row: number): number => TOP + row * ROW + ROW / 2;
const point = (px: number, py: number): string => `${String(px)} ${String(py)}`;

function laneClass(lane: number): string {
  return lane >= MAX_GRAPH_LANES
    ? 'graph-lane-overflow'
    : `graph-lane-${String(lane % LANE_COLOURS)}`;
}

function edgePath(edge: GraphEdge, rows: number, endY: number): string {
  const start = point(x(edge.fromLane), y(edge.fromRow));
  const via = x(edge.viaLane);
  if (edge.toRow === null || edge.toLane === null) {
    // An open line runs down its lane to the bottom: its parent is not loaded.
    const first = edge.fromRow + 1;
    return first >= rows
      ? `M${start} L${point(via, endY)}`
      : `M${start} L${point(via, y(first))} L${point(via, endY)}`;
  }
  const end = point(x(edge.toLane), y(edge.toRow));
  if (edge.toRow - edge.fromRow === 1) return `M${start} L${end}`;
  return `M${start} L${point(via, y(edge.fromRow + 1))} L${point(via, y(edge.toRow - 1))} L${end}`;
}

function Shape({
  kind,
  cx,
  cy,
  className,
}: {
  readonly kind: GraphNodeKind;
  readonly cx: number;
  readonly cy: number;
  readonly className: string;
}) {
  const reach = RADIUS + 1;
  switch (kind) {
    case 'merge':
      return (
        <polygon
          className={className}
          points={[
            point(cx, cy - reach - 1),
            point(cx + reach + 1, cy),
            point(cx, cy + reach + 1),
            point(cx - reach - 1, cy),
          ].join(' ')}
        />
      );
    case 'root':
      return (
        <rect
          className={className}
          x={cx - RADIUS}
          y={cy - RADIUS}
          width={RADIUS * 2}
          height={RADIUS * 2}
        />
      );
    case 'unknown':
      return (
        <polygon
          className={className}
          points={[
            point(cx - reach, cy - RADIUS),
            point(cx + reach, cy - RADIUS),
            point(cx, cy + reach),
          ].join(' ')}
        />
      );
    default:
      return <circle className={className} cx={cx} cy={cy} r={RADIUS} />;
  }
}

/**
 * A small up arrow beside a commit that lists a parent above itself. That parent is not drawn (a
 * line would run upwards), and a shape, not only a colour, says so.
 */
function AboveMark({ cx, cy }: { readonly cx: number; readonly cy: number }) {
  const px = cx + 9;
  return (
    <path
      className="graph-above-mark"
      d={`M${point(px, cy + 3)} L${point(px, cy - 3)} M${point(px - 2.5, cy - 0.5)} L${point(px, cy - 3)} L${point(px + 2.5, cy - 0.5)}`}
    />
  );
}

function parentsText(node: GraphNode): string {
  switch (node.kind) {
    case 'merge':
      return 'Merge commit';
    case 'root':
      return 'Root commit (no parents)';
    case 'unknown':
      return 'GitHub did not say what its parents are';
    default:
      return 'Commit';
  }
}

/** The tooltip of one node: its state in words. The text equivalent is the table. */
function nodeTitle(node: GraphNode, commit: CommitItem): string {
  const facts = [parentsText(node)];
  if (node.invalidParents > 0) {
    facts.push(
      `${formatCount(node.invalidParents)} ${node.invalidParents === 1 ? 'parent' : 'parents'} could not be read`,
    );
  }
  if (node.droppedLinks > 0) {
    facts.push(
      `${formatCount(node.droppedLinks)} ${node.droppedLinks === 1 ? 'link is' : 'links are'} not drawn (no free lane)`,
    );
  }
  if (node.linkHidden) facts.push('a line leading here is not drawn (no free lane)');
  if (node.outOfOrderParents > 0) {
    facts.push(
      `${formatCount(node.outOfOrderParents)} ${node.outOfOrderParents === 1 ? 'parent is' : 'parents are'} listed above it, so no line is drawn to ${node.outOfOrderParents === 1 ? 'it' : 'them'}`,
    );
  }
  if (node.overflow) facts.push('shown in the extra column (no free lane)');
  if (node.duplicate) facts.push('listed twice; this copy has no lines');
  const subject = commit.subject === '' ? '(no message)' : commit.subject;
  return `${commit.sha.slice(0, 7)} ${subject}. ${facts.join('; ')}.`;
}

function nodeClass(node: GraphNode): string {
  const parts = ['graph-node', laneClass(node.lane)];
  if (node.overflow || node.duplicate) parts.push('graph-node-hollow');
  if (node.invalidParents > 0) parts.push('graph-node-invalid');
  else if (node.droppedLinks > 0 || node.linkHidden) parts.push('graph-node-hidden');
  else if (node.outOfOrderParents > 0) parts.push('graph-node-above');
  return parts.join(' ');
}

function Legend() {
  const cy = 8;
  const cx = 8;
  const items: readonly {
    kind: GraphNodeKind;
    hollow?: boolean;
    above?: boolean;
    text: string;
  }[] = [
    { kind: 'commit', text: 'Commit' },
    { kind: 'merge', text: 'Merge' },
    { kind: 'root', text: 'Root (no parents)' },
    { kind: 'unknown', text: 'Parents not stated' },
    { kind: 'commit', hollow: true, text: 'No free lane, or listed twice' },
    { kind: 'commit', above: true, text: 'Parent listed above (not drawn)' },
  ];
  return (
    <ul className="graph-legend" aria-label="Key to the graph">
      {items.map((item) => (
        <li key={item.text}>
          <svg width={22} height={16} viewBox="0 0 22 16" aria-hidden="true" focusable="false">
            <Shape
              kind={item.kind}
              cx={cx}
              cy={cy}
              className={`graph-node graph-lane-0${item.hollow === true ? ' graph-node-hollow' : ''}${item.above === true ? ' graph-node-above' : ''}`}
            />
            {item.above === true && <AboveMark cx={cx} cy={cy} />}
          </svg>
          {item.text}
        </li>
      ))}
      <li>
        <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path className="graph-edge graph-edge-open graph-lane-0" d="M8 0 L8 16" />
        </svg>
        Parent not loaded
      </li>
    </ul>
  );
}

interface Props {
  readonly graph: Graph;
  /** The loaded commits the graph was laid out from, in the same order. */
  readonly commits: readonly CommitItem[];
  readonly next: PageNext | null;
}

/**
 * The parent links of the loaded commits on the default branch: linear history and merges as
 * connected lanes. It is a drawing of what is loaded, laid out by {@link buildHistoryGraph}, with
 * SVG attributes and CSS classes only (the CSP forbids inline `style`). Subjects are untrusted
 * text and are rendered as text nodes. The exposed name is one image; the Parents column of the
 * commit table lists the same links and is the keyboard and screen-reader route.
 */
export function HistoryGraph({ graph, commits, next }: Props) {
  const rows = graph.nodes.length;
  if (rows === 0) return null;

  const labelX = x(graph.laneCount) + 6;
  const hasOpen = graph.openLinks > 0;
  const bodyEnd = TOP + rows * ROW;
  const endY = bodyEnd + (hasOpen ? 8 : 0);
  const height = bodyEnd + (hasOpen ? 18 : 6);
  const width = labelX + LABEL_WIDTH;
  const notes = historyGraphNotes(graph, next);

  return (
    <>
      <div
        className="graph-scroll"
        role="region"
        aria-label="Scrollable history graph"
        tabIndex={0}
      >
        <svg
          className="graph-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          role="img"
          aria-label={historyGraphLabel(graph)}
        >
          {graph.edges.map((edge, index) => {
            const open = edge.toRow === null;
            const classes = [
              'graph-edge',
              laneClass(edge.viaLane),
              edge.mainline ? '' : 'graph-edge-merged',
              open ? 'graph-edge-open' : '',
            ]
              .filter((name) => name !== '')
              .join(' ');
            return (
              <g key={`e${String(index)}`}>
                <path className={classes} d={edgePath(edge, rows, endY)}>
                  {open && (
                    <title>{`Parent ${edge.parentSha.slice(0, 7)} is not among the loaded commits`}</title>
                  )}
                </path>
                {open && (
                  <circle
                    className={`graph-end ${laneClass(edge.viaLane)}`}
                    cx={x(edge.viaLane)}
                    cy={endY}
                    r={3}
                  />
                )}
              </g>
            );
          })}
          {graph.nodes.map((node) => {
            const commit = commits[node.row];
            if (commit === undefined) return null;
            return (
              <g key={`n${String(node.row)}`}>
                <Shape
                  kind={node.kind}
                  cx={x(node.lane)}
                  cy={y(node.row)}
                  className={nodeClass(node)}
                />
                {node.outOfOrderParents > 0 && <AboveMark cx={x(node.lane)} cy={y(node.row)} />}
              </g>
            );
          })}
          {graph.nodes.map((node) => {
            const commit = commits[node.row];
            if (commit === undefined) return null;
            const text =
              commit.subject === ''
                ? `${commit.sha.slice(0, 7)} (no message)`
                : `${commit.sha.slice(0, 7)} ${truncateSubject(commit.subject)}`;
            return (
              <text
                key={`t${String(node.row)}`}
                className={commit.subject === '' ? 'graph-label graph-label-muted' : 'graph-label'}
                x={labelX}
                y={y(node.row) + 4}
              >
                {text}
                <title>{nodeTitle(node, commit)}</title>
              </text>
            );
          })}
        </svg>
      </div>
      <Legend />
      {notes.length > 0 && (
        <ul className="graph-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </>
  );
}
