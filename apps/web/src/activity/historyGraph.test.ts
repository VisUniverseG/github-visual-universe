import { describe, expect, it } from 'vitest';
import {
  buildHistoryGraph,
  MAX_GRAPH_LANES,
  OVERFLOW_LANE,
  truncateSubject,
  type GraphCommit,
} from './historyGraph';

/** A commit: its SHA, then its parents (`null` is an unreadable one). */
function c(sha: string, ...parents: (string | null)[]): GraphCommit {
  return { sha, parentShas: parents };
}

const lanesOf = (commits: readonly GraphCommit[]): number[] =>
  buildHistoryGraph(commits).nodes.map((node) => node.lane);

/** The same fixture used for several merge tests: M merges A and B, which both lead to R. */
const MERGE: readonly GraphCommit[] = [c('M', 'A', 'B'), c('A', 'R'), c('B', 'R'), c('R')];

describe('buildHistoryGraph', () => {
  it('lays out nothing for no commits', () => {
    const graph = buildHistoryGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.laneCount).toBe(0);
    expect(graph.openParents).toBe(0);
  });

  describe('linear history', () => {
    const graph = buildHistoryGraph([c('A', 'B'), c('B', 'C'), c('C')]);

    it('keeps every commit in lane 0 and joins each to the next', () => {
      expect(graph.nodes.map((node) => [node.row, node.lane, node.kind])).toEqual([
        [0, 0, 'commit'],
        [1, 0, 'commit'],
        [2, 0, 'root'],
      ]);
      expect(graph.edges).toEqual([
        {
          fromRow: 0,
          fromLane: 0,
          viaLane: 0,
          toRow: 1,
          toLane: 0,
          parentSha: 'B',
          mainline: true,
        },
        {
          fromRow: 1,
          fromLane: 0,
          viaLane: 0,
          toRow: 2,
          toLane: 0,
          parentSha: 'C',
          mainline: true,
        },
      ]);
      expect(graph.laneCount).toBe(1);
    });

    it('reports a root and nothing else unusual', () => {
      expect(graph).toMatchObject({
        merges: 0,
        roots: 1,
        unknownParents: 0,
        invalidParentLinks: 0,
        openParents: 0,
        openLinks: 0,
        droppedLinks: 0,
        overflowCommits: 0,
        outOfOrderLinks: 0,
        duplicates: 0,
      });
    });
  });

  describe('a parent that is not loaded', () => {
    it('leaves an open line, not a link to a commit that is not there', () => {
      const graph = buildHistoryGraph([c('A', 'B'), c('B', 'C')]);
      expect(graph.edges).toEqual([
        {
          fromRow: 0,
          fromLane: 0,
          viaLane: 0,
          toRow: 1,
          toLane: 0,
          parentSha: 'B',
          mainline: true,
        },
        {
          fromRow: 1,
          fromLane: 0,
          viaLane: 0,
          toRow: null,
          toLane: null,
          parentSha: 'C',
          mainline: true,
        },
      ]);
      expect(graph.openParents).toBe(1);
      expect(graph.openLinks).toBe(1);
      expect(graph.roots).toBe(0);
    });

    it('counts a parent reached from two commits once, as two open lines', () => {
      const graph = buildHistoryGraph([c('M', 'A', 'X'), c('A', 'X')]);
      expect(graph.openParents).toBe(1);
      expect(graph.openLinks).toBe(2);
    });
  });

  describe('merges', () => {
    const graph = buildHistoryGraph(MERGE);

    it('puts the second parent in a second lane and joins both back at the fork', () => {
      expect(graph.nodes.map((node) => [node.sha, node.lane, node.kind])).toEqual([
        ['M', 0, 'merge'],
        ['A', 0, 'commit'],
        ['B', 1, 'commit'],
        ['R', 0, 'root'],
      ]);
      expect(graph.laneCount).toBe(2);
      expect(graph.merges).toBe(1);
    });

    it('draws the mainline and the merged-in line as separate edges', () => {
      expect(graph.edges).toEqual(
        expect.arrayContaining([
          {
            fromRow: 0,
            fromLane: 0,
            viaLane: 0,
            toRow: 1,
            toLane: 0,
            parentSha: 'A',
            mainline: true,
          },
          {
            fromRow: 0,
            fromLane: 0,
            viaLane: 1,
            toRow: 2,
            toLane: 1,
            parentSha: 'B',
            mainline: false,
          },
          {
            fromRow: 1,
            fromLane: 0,
            viaLane: 0,
            toRow: 3,
            toLane: 0,
            parentSha: 'R',
            mainline: true,
          },
          {
            fromRow: 2,
            fromLane: 1,
            viaLane: 0,
            toRow: 3,
            toLane: 0,
            parentSha: 'R',
            mainline: true,
          },
        ]),
      );
      expect(graph.edges).toHaveLength(4);
    });

    it('lets two tips share the parent they both lead to', () => {
      const shared = buildHistoryGraph([c('X', 'R'), c('Y', 'R'), c('R')]);
      expect(shared.nodes.map((node) => node.lane)).toEqual([0, 1, 0]);
      expect(shared.edges).toHaveLength(2);
      expect(shared.edges.every((edge) => edge.toRow === 2 && edge.toLane === 0)).toBe(true);
    });

    it('reuses a lane once its line has ended', () => {
      const lanes = lanesOf([c('M', 'A', 'B'), c('A', 'R'), c('B', 'R'), c('R', 'S'), c('S')]);
      expect(lanes).toEqual([0, 0, 1, 0, 0]);
      const next = lanesOf([...MERGE, c('N')]);
      expect(next[4]).toBe(0);
    });

    it('treats an octopus merge (three parents) like any other merge', () => {
      const graph3 = buildHistoryGraph([c('M', 'A', 'B', 'C'), c('A'), c('B'), c('C')]);
      expect(graph3.merges).toBe(1);
      expect(graph3.nodes.map((node) => node.lane)).toEqual([0, 0, 1, 2]);
      expect(graph3.laneCount).toBe(3);
    });
  });

  describe('states that must not look alike', () => {
    const graph = buildHistoryGraph([
      { sha: 'U', parentShas: null },
      c('Root'),
      c('Bad', null),
      c('Open', 'Z'),
    ]);

    it('tells a root, unknown parents, an unreadable parent and an unloaded parent apart', () => {
      expect(graph.nodes.map((node) => [node.sha, node.kind, node.invalidParents])).toEqual([
        ['U', 'unknown', 0],
        ['Root', 'root', 0],
        ['Bad', 'commit', 1],
        ['Open', 'commit', 0],
      ]);
      expect(graph).toMatchObject({
        unknownParents: 1,
        roots: 1,
        invalidParentLinks: 1,
        openParents: 1,
      });
    });

    it('draws a line only for the parent that can be read and is not loaded', () => {
      expect(graph.edges).toEqual([
        {
          fromRow: 3,
          fromLane: 0,
          viaLane: 0,
          toRow: null,
          toLane: null,
          parentSha: 'Z',
          mainline: true,
        },
      ]);
    });

    it('keeps a readable parent next to an unreadable one', () => {
      const mixed = buildHistoryGraph([c('M', null, 'B'), c('B')]);
      expect(mixed.nodes[0]).toMatchObject({ kind: 'merge', invalidParents: 1 });
      expect(mixed.edges).toEqual([
        {
          fromRow: 0,
          fromLane: 0,
          viaLane: 0,
          toRow: 1,
          toLane: 0,
          parentSha: 'B',
          mainline: false,
        },
      ]);
    });
  });

  describe('data that does not follow the usual order', () => {
    it('does not draw a parent that is listed above its child', () => {
      const graph = buildHistoryGraph([c('P'), c('C', 'P')]);
      expect(graph.edges).toEqual([]);
      expect(graph.nodes[1]).toMatchObject({ outOfOrderParents: 1 });
      expect(graph.outOfOrderLinks).toBe(1);
      expect(graph.openParents).toBe(0);
    });

    it('stops at a commit that is its own parent', () => {
      const graph = buildHistoryGraph([c('A', 'A')]);
      expect(graph.edges).toEqual([]);
      expect(graph.outOfOrderLinks).toBe(1);
    });

    it('stops at a cycle', () => {
      const graph = buildHistoryGraph([c('A', 'B'), c('B', 'A')]);
      expect(graph.edges).toHaveLength(1);
      expect(graph.outOfOrderLinks).toBe(1);
    });

    it('draws a repeated commit without lines and counts it once as a copy', () => {
      const graph = buildHistoryGraph([c('A', 'R'), c('A', 'R'), c('R')]);
      expect(graph.nodes.map((node) => node.duplicate)).toEqual([false, true, false]);
      expect(graph.edges).toHaveLength(1);
      expect(graph.duplicates).toBe(1);
    });

    it('counts a repeated merge only once', () => {
      const graph = buildHistoryGraph([c('M', 'A', 'B'), c('M', 'A', 'B')]);
      expect(graph.merges).toBe(1);
      expect(graph.duplicates).toBe(1);
    });

    it('never puts a repeated commit on a lane that carries a line', () => {
      const graph = buildHistoryGraph([c('A', 'R'), c('A', 'R'), c('R')]);
      expect(graph.nodes[1]?.lane).not.toBe(0);
    });
  });

  describe(`more than ${String(MAX_GRAPH_LANES)} lanes`, () => {
    /** Tips whose parents are all different and not loaded: each holds one lane. */
    const tips = (count: number): GraphCommit[] =>
      Array.from({ length: count }, (_, index) => c(`t${String(index)}`, `p${String(index)}`));

    it('fills the lanes before it overflows', () => {
      const graph = buildHistoryGraph(tips(MAX_GRAPH_LANES));
      expect(graph.nodes.map((node) => node.lane)).toEqual(
        Array.from({ length: MAX_GRAPH_LANES }, (_, index) => index),
      );
      expect(graph.laneCount).toBe(MAX_GRAPH_LANES);
      expect(graph.overflowCommits).toBe(0);
      expect(graph.droppedLinks).toBe(0);
    });

    it('puts a commit with no free lane in the overflow column and counts its dropped link', () => {
      const graph = buildHistoryGraph([...tips(MAX_GRAPH_LANES + 1), c('p12')]);
      const overflowed = graph.nodes[MAX_GRAPH_LANES];
      expect(overflowed).toMatchObject({
        lane: OVERFLOW_LANE,
        overflow: true,
        droppedLinks: 1,
        linkHidden: false,
      });
      expect(graph.overflowCommits).toBe(2);
      expect(graph.droppedLinks).toBe(1);
      expect(graph.laneCount).toBe(MAX_GRAPH_LANES + 1);
      expect(graph.edges.every((edge) => edge.viaLane < MAX_GRAPH_LANES)).toBe(true);
    });

    it('says so on the commit whose incoming line was dropped', () => {
      const graph = buildHistoryGraph([...tips(MAX_GRAPH_LANES + 1), c('p12')]);
      expect(graph.nodes.at(-1)).toMatchObject({ sha: 'p12', linkHidden: true });
    });

    it('drops only the merge link that has no lane, and keeps the commit in its lane', () => {
      const graph = buildHistoryGraph([...tips(MAX_GRAPH_LANES - 1), c('M', 'm1', 'm2')]);
      expect(graph.nodes.at(-1)).toMatchObject({
        sha: 'M',
        lane: MAX_GRAPH_LANES - 1,
        kind: 'merge',
        overflow: false,
        droppedLinks: 1,
      });
      expect(graph.droppedLinks).toBe(1);
      expect(graph.edges.some((edge) => edge.parentSha === 'm2')).toBe(false);
      expect(graph.edges.some((edge) => edge.parentSha === 'm1')).toBe(true);
    });

    it('lets an overflow commit join a lane that already waits for its parent', () => {
      const graph = buildHistoryGraph([...tips(MAX_GRAPH_LANES), c('o', 'p3')]);
      expect(graph.nodes.at(-1)).toMatchObject({ lane: OVERFLOW_LANE, overflow: true });
      expect(graph.droppedLinks).toBe(0);
      expect(graph.edges).toContainEqual({
        fromRow: MAX_GRAPH_LANES,
        fromLane: OVERFLOW_LANE,
        viaLane: 3,
        toRow: null,
        toLane: null,
        parentSha: 'p3',
        mainline: true,
      });
    });
  });

  describe('loading older commits', () => {
    it('leaves the rows that were already laid out exactly where they were', () => {
      const full = buildHistoryGraph(MERGE);
      for (let count = 1; count < MERGE.length; count += 1) {
        const prefix = buildHistoryGraph(MERGE.slice(0, count));
        expect(prefix.nodes).toEqual(full.nodes.slice(0, count));
        // Edges that were already complete stay; the rest were open and are now joined up.
        for (const edge of prefix.edges.filter((candidate) => candidate.toRow !== null)) {
          expect(full.edges).toContainEqual(edge);
        }
      }
    });

    it('turns an open line into a joined one when the parent arrives', () => {
      const first = buildHistoryGraph([c('A', 'B')]);
      expect(first.edges[0]?.toRow).toBeNull();
      const second = buildHistoryGraph([c('A', 'B'), c('B')]);
      expect(second.edges[0]?.toRow).toBe(1);
      expect(second.openParents).toBe(0);
    });
  });

  describe('safety', () => {
    it('is deterministic and does not change its input', () => {
      const input: GraphCommit[] = MERGE.map((commit) => ({
        sha: commit.sha,
        parentShas: commit.parentShas === null ? null : Object.freeze([...commit.parentShas]),
      }));
      Object.freeze(input);
      for (const commit of input) Object.freeze(commit);
      const once = buildHistoryGraph(input);
      const twice = buildHistoryGraph(input);
      expect(twice).toEqual(once);
      expect(input.map((commit) => commit.sha)).toEqual(['M', 'A', 'B', 'R']);
    });

    it('handles a full 500-commit linear history in one lane', () => {
      const commits = Array.from({ length: 500 }, (_, index) =>
        c(`s${String(index)}`, `s${String(index + 1)}`),
      );
      const graph = buildHistoryGraph(commits);
      expect(graph.laneCount).toBe(1);
      expect(graph.edges).toHaveLength(500);
      expect(graph.openParents).toBe(1);
    });

    it('keeps its promises on tangled, partly invalid data', () => {
      // A small deterministic generator: parents point forwards, backwards, at themselves and at
      // commits that are not there.
      let state = 12345;
      const random = (limit: number): number => {
        state = (state * 48271) % 2147483647;
        return state % limit;
      };
      const total = 300;
      const commits: GraphCommit[] = Array.from({ length: total }, (_, index) => {
        const count = random(4);
        const parents: (string | null)[] = Array.from({ length: count }, () => {
          const pick = random(10);
          if (pick === 0) return null;
          if (pick === 1) return `gone${String(random(50))}`;
          return `n${String(Math.min(total - 1, index + 1 + random(6) - (random(8) === 0 ? 8 : 0)))}`;
        });
        return random(25) === 0
          ? { sha: `n${String(index)}`, parentShas: null }
          : c(`n${String(index)}`, ...parents);
      });
      const graph = buildHistoryGraph(commits);

      expect(graph.nodes).toHaveLength(total);
      expect(graph.laneCount).toBeLessThanOrEqual(OVERFLOW_LANE + 1);
      for (const node of graph.nodes) {
        expect(node.lane).toBeLessThanOrEqual(OVERFLOW_LANE);
        expect(node.overflow).toBe(node.lane === OVERFLOW_LANE);
      }
      for (const edge of graph.edges) {
        expect(edge.viaLane).toBeLessThan(MAX_GRAPH_LANES);
        if (edge.toRow !== null) expect(edge.toRow).toBeGreaterThan(edge.fromRow);
        // No commit sits on a lane that a line is running down.
        const last = edge.toRow ?? total;
        for (let row = edge.fromRow + 1; row < last; row += 1) {
          expect(graph.nodes[row]?.lane).not.toBe(edge.viaLane);
        }
      }
    });
  });
});

describe('truncateSubject', () => {
  it('leaves a short subject alone', () => {
    expect(truncateSubject('Fix the thing')).toBe('Fix the thing');
    expect(truncateSubject('a'.repeat(72))).toBe('a'.repeat(72));
  });

  it('cuts a long subject with an ellipsis', () => {
    expect(truncateSubject('a'.repeat(73))).toBe(`${'a'.repeat(72)}…`);
    expect(truncateSubject('abcdef', 3)).toBe('abc…');
  });

  it('never splits a surrogate pair', () => {
    const cut = truncateSubject('😀'.repeat(5), 3);
    expect(cut).toBe('😀😀😀…');
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('what became of each parent entry', () => {
  it('names one outcome per parent entry, in order', () => {
    // Row 2 lists, in order: an unreadable entry, a parent above it, a loaded parent below, an
    // unloaded parent.
    const graph = buildHistoryGraph([c('A'), c('B'), c('C', null, 'A', 'D', 'Z'), c('D')]);
    expect(graph.nodes[2]?.links).toEqual(['unreadable', 'above', 'drawn', 'drawn']);
  });

  it('marks a parent listed above its child, apart from every other state', () => {
    const graph = buildHistoryGraph([
      c('P'), // a root
      c('C', 'P'), // its parent is listed above it
      c('U', 'Gone'), // its parent is not loaded
      c('X', null), // its parent is unreadable
      c('R'), // a root
      { sha: 'N', parentShas: null }, // parents not stated
      c('P'), // a repeated copy
    ]);
    const above = (sha: string) => graph.nodes.find((node) => node.sha === sha);
    expect(above('C')).toMatchObject({ links: ['above'], outOfOrderParents: 1, kind: 'commit' });
    expect(above('U')).toMatchObject({ links: ['drawn'], outOfOrderParents: 0 });
    expect(above('X')).toMatchObject({ links: ['unreadable'], outOfOrderParents: 0 });
    expect(above('R')).toMatchObject({ links: [], outOfOrderParents: 0, kind: 'root' });
    expect(above('N')).toMatchObject({ links: [], outOfOrderParents: 0, kind: 'unknown' });
    expect(graph.nodes[6]).toMatchObject({ duplicate: true, links: [], outOfOrderParents: 0 });
    // Only the one commit is counted, and it has no line.
    expect(graph.outOfOrderLinks).toBe(1);
    expect(graph.edges.some((edge) => edge.fromRow === 1)).toBe(false);
  });

  it('treats a commit that is its own parent as listed above, with no line', () => {
    const graph = buildHistoryGraph([c('A', 'A')]);
    expect(graph.nodes[0]?.links).toEqual(['above']);
    expect(graph.edges).toEqual([]);
  });

  it('says dropped when no lane was free, never above', () => {
    const tips = Array.from({ length: MAX_GRAPH_LANES - 1 }, (_, index) =>
      c(`t${String(index)}`, `p${String(index)}`),
    );
    const graph = buildHistoryGraph([...tips, c('M', 'm1', 'm2')]);
    expect(graph.nodes.at(-1)?.links).toEqual(['drawn', 'dropped']);
  });

  it('gives a repeated copy no outcomes, because its parents are not examined', () => {
    const graph = buildHistoryGraph([c('A', 'R'), c('A', 'R', 'Q'), c('R')]);
    expect(graph.nodes[1]).toMatchObject({ duplicate: true, links: [] });
  });
});

/** A small deterministic generator (MINSTD), so every failure can be reproduced from its seed. */
function randomSource(seed: number): (limit: number) => number {
  let state = (seed % 2147483646) + 1;
  return (limit) => {
    state = (state * 48271) % 2147483647;
    return state % limit;
  };
}

interface Profile {
  readonly name: string;
  readonly total: number;
  /** Out of 10: how often a parent entry is a SHA that is never loaded. */
  readonly unloaded: number;
  /** Out of 10: how often a parent entry is unreadable. */
  readonly unreadable: number;
  /** Out of 10: how often a parent entry points at an earlier row (or its own). */
  readonly backwards: number;
  /** Out of 20: how often a row repeats a SHA that was already listed. */
  readonly repeats: number;
  /** The most parents of one commit. */
  readonly maxParents: number;
}

const PROFILES: readonly Profile[] = [
  {
    name: 'tangled',
    total: 300,
    unloaded: 1,
    unreadable: 1,
    backwards: 2,
    repeats: 0,
    maxParents: 3,
  },
  {
    name: 'with repeated SHAs',
    total: 300,
    unloaded: 1,
    unreadable: 1,
    backwards: 2,
    repeats: 3,
    maxParents: 3,
  },
  // Most parents are never loaded, so lines pile up and every lane is used.
  {
    name: 'saturated lanes',
    total: 300,
    unloaded: 7,
    unreadable: 1,
    backwards: 1,
    repeats: 1,
    maxParents: 3,
  },
  // Everything at once, with wide merges.
  {
    name: 'saturated, repeated and tangled',
    total: 400,
    unloaded: 5,
    unreadable: 1,
    backwards: 3,
    repeats: 4,
    maxParents: 5,
  },
];

function generate(profile: Profile, seed: number): GraphCommit[] {
  const random = randomSource(seed);
  return Array.from({ length: profile.total }, (_, index): GraphCommit => {
    const repeated = index > 0 && random(20) < profile.repeats;
    const sha = repeated ? `n${String(random(index))}` : `n${String(index)}`;
    if (random(30) === 0) return { sha, parentShas: null };
    const parents = Array.from({ length: random(profile.maxParents + 1) }, (): string | null => {
      if (random(10) < profile.unreadable) return null;
      if (random(10) < profile.unloaded) return `gone${String(random(1000))}`;
      if (index > 0 && random(10) < profile.backwards) return `n${String(random(index + 1))}`;
      return `n${String(Math.min(profile.total - 1, index + 1 + random(6)))}`;
    });
    return { sha, parentShas: parents };
  });
}

/** The first row each SHA is listed in, worked out from the input alone. */
function firstRows(commits: readonly GraphCommit[]): Map<string, number> {
  const rows = new Map<string, number>();
  commits.forEach((commit, row) => {
    if (!rows.has(commit.sha)) rows.set(commit.sha, row);
  });
  return rows;
}

/** Every closed edge points where its source commit says it does, and open edges point nowhere. */
function expectTruthfulEdges(
  commits: readonly GraphCommit[],
  graph: ReturnType<typeof buildHistoryGraph>,
) {
  const first = firstRows(commits);
  const rows = commits.length;
  expect(graph.nodes).toHaveLength(rows);

  for (const edge of graph.edges) {
    // The source: a real row, which is a first listing (a repeated copy has no lines), whose
    // commit names this parent, and the edge starts in the lane that commit was drawn in.
    expect(edge.fromRow).toBeGreaterThanOrEqual(0);
    expect(edge.fromRow).toBeLessThan(rows);
    const source = graph.nodes[edge.fromRow];
    const sourceCommit = commits[edge.fromRow];
    expect(source?.duplicate).toBe(false);
    expect(source?.sha).toBe(sourceCommit?.sha);
    expect(sourceCommit?.parentShas).toContain(edge.parentSha);
    expect(edge.fromLane).toBe(source?.lane);
    // The line runs down a lane that exists, never the overflow column.
    expect(edge.viaLane).toBeGreaterThanOrEqual(0);
    expect(edge.viaLane).toBeLessThan(MAX_GRAPH_LANES);
    // The mainline is exactly the first parent entry.
    const positions = (sourceCommit?.parentShas ?? []).flatMap((parent, index) =>
      parent === edge.parentSha ? [index] : [],
    );
    expect(positions.some((position) => (position === 0) === edge.mainline)).toBe(true);

    if (edge.toRow === null) {
      // An open line: its parent is not among the loaded commits at all, in any row.
      expect(edge.toLane).toBeNull();
      expect(first.has(edge.parentSha)).toBe(false);
    } else {
      // A closed line: downwards, to the first listing of exactly that SHA, in its own lane.
      expect(edge.toRow).toBeGreaterThan(edge.fromRow);
      expect(edge.toRow).toBeLessThan(rows);
      const target = graph.nodes[edge.toRow];
      expect(target?.sha).toBe(edge.parentSha);
      expect(first.get(edge.parentSha)).toBe(edge.toRow);
      expect(target?.duplicate).toBe(false);
      expect(edge.toLane).toBe(target?.lane);
    }
  }

  for (const node of graph.nodes) {
    // Lanes are in range, and only a commit with no lane at all is in the overflow column.
    expect(node.lane).toBeGreaterThanOrEqual(0);
    expect(node.lane).toBeLessThanOrEqual(OVERFLOW_LANE);
    expect(node.overflow).toBe(node.lane === OVERFLOW_LANE);
  }
  expect(graph.laneCount).toBeLessThanOrEqual(OVERFLOW_LANE + 1);

  // No commit sits on a lane that a line is running down.
  for (const edge of graph.edges) {
    const last = edge.toRow ?? rows;
    for (let row = edge.fromRow + 1; row < last; row += 1) {
      expect(graph.nodes[row]?.lane).not.toBe(edge.viaLane);
    }
  }
}

/** Every parent entry of every examined commit has exactly one outcome, and each is accounted for. */
function expectConservedLinks(
  commits: readonly GraphCommit[],
  graph: ReturnType<typeof buildHistoryGraph>,
) {
  const first = firstRows(commits);
  let entries = 0;
  let examined = 0;
  let notExamined = 0;
  let drawn = 0;
  let dropped = 0;
  let above = 0;
  let unreadable = 0;

  commits.forEach((commit, row) => {
    const node = graph.nodes[row];
    const parents = commit.parentShas ?? [];
    entries += parents.length;
    if (node === undefined) return;

    if (node.duplicate || commit.parentShas === null) {
      // A repeated copy, or parents that were not stated: nothing is examined or drawn from here.
      notExamined += node.duplicate ? parents.length : 0;
      expect(node.links).toEqual([]);
      expect(graph.edges.filter((edge) => edge.fromRow === row)).toEqual([]);
      return;
    }

    examined += parents.length;
    expect(node.links).toHaveLength(parents.length);
    const drawnShas: string[] = [];
    parents.forEach((parent, index) => {
      const outcome = node.links[index];
      if (parent === null) {
        expect(outcome).toBe('unreadable');
        unreadable += 1;
      } else if ((first.get(parent) ?? Infinity) <= row) {
        // Listed above this commit, or this commit itself.
        expect(outcome).toBe('above');
        above += 1;
      } else {
        expect(['drawn', 'dropped']).toContain(outcome);
        if (outcome === 'drawn') {
          drawnShas.push(parent);
          drawn += 1;
        } else {
          dropped += 1;
        }
      }
    });

    // The edges that leave this row are exactly its drawn entries: none missing, none extra.
    const leaving = graph.edges
      .filter((edge) => edge.fromRow === row)
      .map((edge) => edge.parentSha)
      .sort();
    expect(leaving).toEqual([...drawnShas].sort());
    // The per-commit counts say the same thing as the outcomes.
    expect(node.links.filter((outcome) => outcome === 'dropped')).toHaveLength(node.droppedLinks);
    expect(node.links.filter((outcome) => outcome === 'above')).toHaveLength(
      node.outOfOrderParents,
    );
    expect(node.links.filter((outcome) => outcome === 'unreadable')).toHaveLength(
      node.invalidParents,
    );
  });

  // The whole graph. Every parent entry is either in a repeated copy (not examined, and said so)
  // or has exactly one outcome: drawn, dropped, above or unreadable. Nothing is counted twice.
  expect(drawn + dropped + above + unreadable).toBe(examined);
  expect(examined + notExamined).toBe(entries);
  expect(graph.edges).toHaveLength(drawn);
  expect(graph.droppedLinks).toBe(dropped);
  expect(graph.outOfOrderLinks).toBe(above);
  expect(graph.invalidParentLinks).toBe(unreadable);
  expect(graph.edges.filter((edge) => edge.toRow === null)).toHaveLength(graph.openLinks);
  expect(
    new Set(graph.edges.filter((edge) => edge.toRow === null).map((edge) => edge.parentSha)).size,
  ).toBe(graph.openParents);
}

describe('invariants on generated histories', () => {
  const SEEDS = Array.from({ length: 25 }, (_, index) => index + 1);

  describe.each(PROFILES)('$name', (profile) => {
    const graphs = SEEDS.map((seed) => {
      const commits = generate(profile, seed);
      return { seed, commits, graph: buildHistoryGraph(commits) };
    });

    it('draws only edges that the source commit and the target commit agree on', () => {
      for (const { commits, graph } of graphs) expectTruthfulEdges(commits, graph);
    });

    it('accounts for every parent entry exactly once', () => {
      for (const { commits, graph } of graphs) expectConservedLinks(commits, graph);
    });

    it('is not vacuous: the generator really produces what the profile is about', () => {
      const sum = (pick: (graph: (typeof graphs)[number]['graph']) => number) =>
        graphs.reduce((total, { graph }) => total + pick(graph), 0);
      const closedEdges = sum((graph) => graph.edges.filter((edge) => edge.toRow !== null).length);
      expect(closedEdges).toBeGreaterThan(100);
      expect(sum((graph) => graph.merges)).toBeGreaterThan(0);
      expect(sum((graph) => graph.openLinks)).toBeGreaterThan(0);
      expect(sum((graph) => graph.outOfOrderLinks)).toBeGreaterThan(0);
      expect(sum((graph) => graph.invalidParentLinks)).toBeGreaterThan(0);
      expect(sum((graph) => graph.unknownParents)).toBeGreaterThan(0);
      if (profile.repeats > 0) expect(sum((graph) => graph.duplicates)).toBeGreaterThan(0);
      else expect(sum((graph) => graph.duplicates)).toBe(0);
      if (profile.name.startsWith('saturated')) {
        expect(sum((graph) => graph.droppedLinks)).toBeGreaterThan(0);
        expect(sum((graph) => graph.overflowCommits)).toBeGreaterThan(0);
        expect(graphs.every(({ graph }) => graph.laneCount === OVERFLOW_LANE + 1)).toBe(true);
      }
    });

    it('keeps every row, and every closed line, when older commits are appended', () => {
      for (const { commits, graph } of graphs.slice(0, 5)) {
        for (const count of [1, 7, 50, 150, commits.length - 1]) {
          const prefix = buildHistoryGraph(commits.slice(0, count));
          expect(prefix.nodes).toEqual(graph.nodes.slice(0, count));
          for (const edge of prefix.edges.filter((candidate) => candidate.toRow !== null)) {
            expect(graph.edges).toContainEqual(edge);
          }
        }
      }
    });
  });
});
