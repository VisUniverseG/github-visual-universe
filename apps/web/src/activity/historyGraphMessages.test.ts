import { describe, expect, it } from 'vitest';
import { buildHistoryGraph, MAX_GRAPH_LANES, type GraphCommit } from './historyGraph';
import { historyGraphLabel, historyGraphNotes } from './messages';

const c = (sha: string, ...parents: (string | null)[]): GraphCommit => ({
  sha,
  parentShas: parents,
});

const END = { kind: 'end' } as const;
const MORE = { kind: 'more', cursor: { nextUrl: 'https://api.github.com/x', page: 2 } } as const;
const CAPPED = { kind: 'capped' } as const;

describe('historyGraphLabel', () => {
  it('names the graph and points to the text equivalent', () => {
    const label = historyGraphLabel(buildHistoryGraph([c('M', 'A', 'B'), c('A'), c('B')]));
    expect(label).toContain('3 loaded commits');
    expect(label).toContain('2 lanes');
    expect(label).toContain('1 merge commit');
    expect(label).toContain('Parents column');
  });

  it('is singular for one commit and omits merges when there are none', () => {
    const label = historyGraphLabel(buildHistoryGraph([c('A')]));
    expect(label).toContain('1 loaded commit on');
    expect(label).toContain('1 lane.');
    expect(label).not.toContain('merge');
  });

  it('does not claim to be the timeline', () => {
    expect(historyGraphLabel(buildHistoryGraph([c('A')]))).not.toMatch(
      /only the commits that have been loaded/i,
    );
  });
});

describe('historyGraphNotes', () => {
  it('has nothing to say about a clean, complete history', () => {
    expect(historyGraphNotes(buildHistoryGraph([c('A', 'B'), c('B')]), END)).toEqual([]);
  });

  it('explains open lines differently while more can be loaded, at the cap, and at the end', () => {
    const graph = buildHistoryGraph([c('A', 'B')]);
    const [more] = historyGraphNotes(graph, MORE);
    const [capped] = historyGraphNotes(graph, CAPPED);
    const [end] = historyGraphNotes(graph, END);
    expect(more).toBe(
      '1 dashed line leads to parent commits that are not loaded yet. They join up as older commits are loaded.',
    );
    expect(capped).toContain('beyond the loading limit');
    expect(end).toBe(
      '1 dashed line leads to parent commits that are not among the loaded commits.',
    );
    expect(historyGraphNotes(graph, null)).toEqual([end]);
  });

  it('pluralises open lines', () => {
    const graph = buildHistoryGraph([c('A', 'X'), c('B', 'Y')]);
    expect(historyGraphNotes(graph, MORE)[0]).toMatch(/^2 dashed lines lead to /);
  });

  it('reports dropped links and overflow commits, and points to the Parents column', () => {
    const tips: GraphCommit[] = Array.from({ length: MAX_GRAPH_LANES + 1 }, (_, index) =>
      c(`t${String(index)}`, `p${String(index)}`),
    );
    const notes = historyGraphNotes(buildHistoryGraph(tips), END);
    const note = notes.find((text) => text.includes('lanes were needed'));
    expect(note).toBe(
      '1 link is not drawn because more than 12 lanes were needed, and 1 commit is in the extra column on the right because no lane was free. The Parents column still lists every link.',
    );
  });

  it('reports unknown parents, unreadable parents, out-of-order links and copies', () => {
    const graph = buildHistoryGraph([
      { sha: 'U', parentShas: null },
      c('Bad', null),
      c('P'),
      c('C', 'P'),
      c('D'),
      c('D'),
    ]);
    expect(historyGraphNotes(graph, END)).toEqual([
      'GitHub did not say what the parents of 1 commit is, so no line leaves it.',
      '1 parent entry could not be read and has no line.',
      '1 link leads to a commit listed above its child (commit dates can be out of order), so it is not drawn. The commit is marked with an up arrow.',
      '1 commit is listed twice. The second copy is drawn without lines.',
    ]);
  });
});
