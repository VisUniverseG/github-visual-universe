import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHistoryGraph, MAX_GRAPH_LANES } from '../../activity/historyGraph.ts';
import type { CommitItem, PageNext } from '../../github/activity.ts';
import { HistoryGraph } from './HistoryGraph.tsx';

afterEach(cleanup);

/** A readable, distinct 40-digit SHA for `n` (1 to 99): its first seven digits are `0101010`. */
const sha = (n: number): string => String(n).padStart(2, '0').repeat(20);
const short = (n: number): string => sha(n).slice(0, 7);

function item(
  n: number,
  parents: readonly (number | null)[] | null,
  subject = `Subject ${String(n)}`,
): CommitItem {
  return {
    sha: sha(n),
    subject,
    authorName: null,
    authorLogin: null,
    date: null,
    parentCount: parents === null ? null : parents.length,
    parentShas:
      parents === null ? null : parents.map((parent) => (parent === null ? null : sha(parent))),
  };
}

const END: PageNext = { kind: 'end' };
const MORE: PageNext = { kind: 'more', cursor: { nextUrl: 'https://api.github.com/x', page: 2 } };

function draw(commits: readonly CommitItem[], next: PageNext | null = END) {
  const graph = buildHistoryGraph(commits);
  const view = render(<HistoryGraph graph={graph} commits={commits} next={next} />);
  return { graph, ...view };
}

/** M(1) merges A(2) and B(3), which both lead to R(4). */
const MERGE = [item(1, [2, 3]), item(2, [4]), item(3, [4]), item(4, [])];

describe('HistoryGraph', () => {
  it('draws nothing for no commits', () => {
    const { container } = draw([]);
    expect(container.firstChild).toBeNull();
  });

  it('is one labelled image, with a scrollable region that the keyboard can reach', () => {
    draw(MERGE);
    const image = screen.getByRole('img');
    expect(image.getAttribute('aria-label')).toContain('History graph of 4 loaded commits');
    expect(image.getAttribute('aria-label')).not.toMatch(/only the commits that have been loaded/i);
    const region = screen.getByRole('region', { name: 'Scrollable history graph' });
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.contains(image)).toBe(true);
    // The key's pictures are decoration, not further images.
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('draws a node per commit, with a distinct shape for a merge and for a root', () => {
    const { container } = draw(MERGE);
    expect(container.querySelectorAll('svg.graph-svg .graph-node')).toHaveLength(4);
    expect(container.querySelectorAll('svg.graph-svg polygon.graph-node')).toHaveLength(1);
    expect(container.querySelectorAll('svg.graph-svg rect.graph-node')).toHaveLength(1);
    expect(container.querySelectorAll('svg.graph-svg circle.graph-node')).toHaveLength(2);
    // The merge is a diamond: four points.
    const diamond = container.querySelector('svg.graph-svg polygon.graph-node');
    expect(diamond?.getAttribute('points')?.split(' ').length).toBe(8);
  });

  it('draws a line for each link between loaded commits, and none for an open end', () => {
    const { container, graph } = draw(MERGE);
    expect(container.querySelectorAll('svg.graph-svg path.graph-edge')).toHaveLength(
      graph.edges.length,
    );
    expect(graph.edges).toHaveLength(4);
    expect(container.querySelector('svg.graph-svg .graph-edge-open')).toBeNull();
    expect(container.querySelector('svg.graph-svg .graph-end')).toBeNull();
    expect(container.querySelector('svg.graph-svg .graph-notes')).toBeNull();
  });

  it('draws the merged-in line apart from the mainline', () => {
    const { container } = draw(MERGE);
    expect(container.querySelectorAll('svg.graph-svg path.graph-edge-merged')).toHaveLength(1);
  });

  it('puts a short SHA and the subject in one label per commit, as text', () => {
    const { container } = draw(MERGE);
    const labels = [...container.querySelectorAll('text.graph-label')].map((label) =>
      [...label.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(''),
    );
    expect(labels).toEqual([
      `${short(1)} Subject 1`,
      `${short(2)} Subject 2`,
      `${short(3)} Subject 3`,
      `${short(4)} Subject 4`,
    ]);
  });

  it('says so for a commit with no message', () => {
    const { container } = draw([item(1, [], '')]);
    expect(container.querySelector('text.graph-label-muted')?.textContent).toContain(
      `${short(1)} (no message)`,
    );
  });

  it('renders an untrusted subject as text, never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const { container } = draw([item(1, [], hostile)]);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('text.graph-label')?.textContent).toContain(hostile);
  });

  it('cuts a long subject at a code-point boundary and keeps the whole one in the tooltip', () => {
    const long = '😀'.repeat(80);
    const { container } = draw([item(1, [], long)]);
    const label = container.querySelector('text.graph-label');
    const shown = [...(label?.childNodes ?? [])].find((node) => node.nodeType === Node.TEXT_NODE);
    expect(shown?.textContent).toBe(`${short(1)} ${'😀'.repeat(72)}…`);
    expect(label?.querySelector('title')?.textContent).toContain(long);
  });

  it('uses no inline style anywhere, which the Content Security Policy would block', () => {
    const { container } = draw(MERGE);
    expect(container.querySelector('[style]')).toBeNull();
    expect(container.querySelector('style')).toBeNull();
  });

  it('has no control to operate and no link', () => {
    const { container } = draw(MERGE);
    expect(container.querySelector('button, a, input, select, textarea')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  describe('a parent that is not loaded', () => {
    const commits = [item(1, [2]), item(2, [3])];

    it('ends the line open and dashed, with a mark and a tooltip', () => {
      const { container } = draw(commits, MORE);
      expect(container.querySelectorAll('svg.graph-svg path.graph-edge-open')).toHaveLength(1);
      expect(container.querySelectorAll('svg.graph-svg circle.graph-end')).toHaveLength(1);
      expect(container.querySelector('svg.graph-svg path.graph-edge-open title')?.textContent).toBe(
        `Parent ${short(3)} is not among the loaded commits`,
      );
    });

    it('explains the dashed line, differently while more can be loaded', () => {
      draw(commits, MORE);
      expect(
        screen.getByText(/not loaded yet\. They join up as older commits are loaded\./),
      ).toBeTruthy();
    });

    it('explains it differently once nothing more will be loaded', () => {
      draw(commits, END);
      expect(screen.getByText(/not among the loaded commits\./)).toBeTruthy();
      expect(screen.queryByText(/join up/)).toBeNull();
    });
  });

  describe('a parent listed above its child', () => {
    // 1 is a root; 2 lists 1, which is above it; 3 lists 9, which is not loaded.
    const commits = [item(1, []), item(2, [1]), item(3, [9])];

    it('is marked with an arrow and an outline, and draws no line to the parent', () => {
      const { container, graph } = draw(commits, END);
      expect(graph.edges.filter((edge) => edge.fromRow === 1)).toEqual([]);
      expect(container.querySelectorAll('svg.graph-svg path.graph-above-mark')).toHaveLength(1);
      expect(container.querySelectorAll('svg.graph-svg .graph-node-above')).toHaveLength(1);
    });

    it('is not confused with a root, a parent that is not loaded, or an unreadable parent', () => {
      const { container } = draw([...commits, item(4, [null]), item(5, null)], END);
      const plot = container.querySelector('svg.graph-svg');
      // Only commit 2 has the arrow; the root, the unloaded parent and the unreadable one do not.
      expect(plot?.querySelectorAll('path.graph-above-mark')).toHaveLength(1);
      expect(plot?.querySelectorAll('rect.graph-node:not(.graph-node-above)')).toHaveLength(1);
      expect(plot?.querySelectorAll('path.graph-edge-open')).toHaveLength(1);
      expect(plot?.querySelectorAll('.graph-node-invalid')).toHaveLength(1);
      expect(plot?.querySelectorAll('.graph-node-above.graph-node-invalid')).toHaveLength(0);
    });

    it('is not marked for a repeated copy, whose parents are not examined', () => {
      const { container } = draw([item(1, []), item(2, [1]), item(2, [1])], END);
      const plot = container.querySelector('svg.graph-svg');
      expect(plot?.querySelectorAll('path.graph-above-mark')).toHaveLength(1);
      expect(plot?.querySelectorAll('.graph-node-hollow')).toHaveLength(1);
    });

    it('says what the arrow means in the tooltip, the notes and the key', () => {
      const { container } = draw(commits, END);
      const titles = [...container.querySelectorAll('text.graph-label title')].map(
        (title) => title.textContent,
      );
      expect(titles[1]).toContain('1 parent is listed above it, so no line is drawn to it');
      expect(
        screen.getByText(/listed above its child .* The commit is marked with an up arrow\./),
      ).toBeTruthy();
      expect(screen.getByText('Parent listed above (not drawn)')).toBeTruthy();
    });
  });

  describe('states that are not a missing parent', () => {
    it('draws no open line for a root, unknown parents or an unreadable parent', () => {
      const { container } = draw([item(1, null), item(2, []), item(3, [null])]);
      expect(container.querySelector('svg.graph-svg .graph-edge')).toBeNull();
      expect(container.querySelector('svg.graph-svg .graph-end')).toBeNull();
      // Unknown parents: a triangle. Root: a square. Unreadable parent: flagged.
      expect(container.querySelectorAll('svg.graph-svg polygon.graph-node')).toHaveLength(1);
      expect(container.querySelectorAll('svg.graph-svg rect.graph-node')).toHaveLength(1);
      expect(container.querySelectorAll('svg.graph-svg .graph-node-invalid')).toHaveLength(1);
    });

    it('says what each state means', () => {
      draw([item(1, null), item(2, [null])]);
      const notes = screen.getAllByRole('listitem').map((node) => node.textContent);
      expect(notes).toContain(
        'GitHub did not say what the parents of 1 commit is, so no line leaves it.',
      );
      expect(notes).toContain('1 parent entry could not be read and has no line.');
    });

    it('describes each node in its tooltip', () => {
      const { container } = draw([item(1, null), item(2, []), item(3, [null]), item(4, [5, 6])]);
      const titles = [...container.querySelectorAll('text.graph-label title')].map(
        (title) => title.textContent,
      );
      expect(titles[0]).toContain('GitHub did not say what its parents are');
      expect(titles[1]).toContain('Root commit (no parents)');
      expect(titles[2]).toContain('1 parent could not be read');
      expect(titles[3]).toContain('Merge commit');
    });
  });

  describe(`more than ${String(MAX_GRAPH_LANES)} lanes`, () => {
    const tips = Array.from({ length: MAX_GRAPH_LANES + 1 }, (_, index) =>
      item(index + 1, [index + 50]),
    );

    it('shows the commit with no lane in a hollow, grey extra column, and says so', () => {
      const { container, graph } = draw(tips);
      expect(graph.overflowCommits).toBe(1);
      expect(
        container.querySelectorAll('svg.graph-svg .graph-node-hollow.graph-lane-overflow'),
      ).toHaveLength(1);
      expect(container.querySelector('svg.graph-svg .graph-node-hidden')).not.toBeNull();
      expect(
        screen.getByText(/in the extra column on the right because no lane was free/),
      ).toBeTruthy();
      expect(screen.getByText(/The Parents column still lists every link\./)).toBeTruthy();
    });

    it('stays inside its own scroll area and keeps every commit', () => {
      const { container } = draw(tips);
      expect(container.querySelectorAll('text.graph-label')).toHaveLength(MAX_GRAPH_LANES + 1);
      const region = screen.getByRole('region', { name: 'Scrollable history graph' });
      expect(within(region).getAllByRole('img')).toHaveLength(1);
    });
  });

  describe('a repeated commit', () => {
    it('is drawn hollow and without lines, and is mentioned', () => {
      const { container } = draw([item(1, [2]), item(1, [2]), item(2, [])]);
      expect(container.querySelectorAll('svg.graph-svg .graph-node-hollow')).toHaveLength(1);
      expect(container.querySelectorAll('svg.graph-svg path.graph-edge')).toHaveLength(1);
      expect(
        screen.getByText('1 commit is listed twice. The second copy is drawn without lines.'),
      ).toBeTruthy();
    });
  });

  it('draws 500 commits', () => {
    const commits = Array.from({ length: 500 }, (_, index) => ({
      ...item(1, [1]),
      sha: (index + 1).toString(16).padStart(40, '0'),
      subject: `Subject ${String(index + 1)}`,
      parentCount: 1,
      parentShas: [(index + 2).toString(16).padStart(40, '0')],
    }));
    const { container } = draw(commits, { kind: 'capped' });
    expect(container.querySelectorAll('text.graph-label')).toHaveLength(500);
    expect(container.querySelectorAll('svg.graph-svg .graph-node')).toHaveLength(500);
    expect(container.querySelectorAll('svg.graph-svg path.graph-edge-open')).toHaveLength(1);
    expect(screen.getByText(/beyond the loading limit/)).toBeTruthy();
  });
});
