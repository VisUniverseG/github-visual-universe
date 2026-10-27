import type { GitHubTreeEntry } from '@gvu/shared';
import { describe, expect, it } from 'vitest';
import { ancestors, buildArchitecture, displayText, extensionOf } from './model.ts';

const tree = (path: string) => ({ path, type: 'tree' as const, mode: '040000' });
const file = (path: string, size?: number): GitHubTreeEntry => ({
  path,
  type: 'blob',
  mode: '100644',
  ...(size === undefined ? {} : { size }),
});

describe('buildArchitecture', () => {
  const entries: GitHubTreeEntry[] = [
    file('README.md', 100),
    tree('src'),
    file('src/index.ts', 300),
    tree('src/util'),
    file('src/util/math.ts', 50),
    file('src/util/Strings.TS', 25),
    tree('docs'),
    file('docs/guide.md', 1000),
    tree('empty'),
  ];

  it('builds the hierarchy and rolls sizes and counts up through every level', () => {
    const model = buildArchitecture(entries);
    const byPath = (path: string) => model.nodes.find((n) => n.path === path);

    expect(model.totals).toMatchObject({
      files: 5,
      directories: 4,
      bytes: 1475,
      symlinks: 0,
      submodules: 0,
      filesWithoutSize: 0,
      maxDepth: 3,
    });
    expect(byPath('src')).toMatchObject({ bytes: 375, fileCount: 3, directoryCount: 1 });
    expect(byPath('src/util')).toMatchObject({ bytes: 75, fileCount: 2, directoryCount: 0 });
    expect(byPath('empty')).toMatchObject({ bytes: 0, fileCount: 0, kind: 'directory' });
    expect(model.root).toMatchObject({ bytes: 1475, fileCount: 5, directoryCount: 4, depth: 0 });
    expect(model.inconsistent).toBe(0);
  });

  it('lists directories first, then names in natural order, whatever order GitHub used', () => {
    const model = buildArchitecture([
      file('b10.txt', 1),
      file('b2.txt', 1),
      file('a.txt', 1),
      tree('zdir'),
      tree('adir'),
    ]);
    expect(model.root.children.map((n) => n.name)).toEqual([
      'adir',
      'zdir',
      'a.txt',
      'b2.txt',
      'b10.txt',
    ]);
  });

  it('creates parent directories the listing did not mention', () => {
    const model = buildArchitecture([file('a/b/c.txt', 5)]);
    expect(model.nodes.map((n) => n.path)).toEqual(['', 'a', 'a/b', 'a/b/c.txt']);
    expect(model.totals).toMatchObject({ files: 1, directories: 2, bytes: 5, maxDepth: 3 });
  });

  it('accepts a directory entry that arrives after its children', () => {
    const model = buildArchitecture([file('a/x.txt', 1), tree('a')]);
    expect(model.totals.directories).toBe(1);
    expect(model.inconsistent).toBe(0);
  });

  it('keeps submodules and symlinks as separate leaves, never as files or directories', () => {
    const model = buildArchitecture([
      file('real.txt', 10),
      { path: 'link', type: 'blob', mode: '120000', size: 8 },
      { path: 'vendor/lib', type: 'commit', mode: '160000' },
    ]);
    const kinds = Object.fromEntries(model.nodes.map((n) => [n.path, n.kind]));
    expect(kinds).toMatchObject({
      'real.txt': 'file',
      link: 'symlink',
      'vendor/lib': 'submodule',
      vendor: 'directory',
    });
    expect(model.totals).toMatchObject({ files: 1, symlinks: 1, submodules: 1, bytes: 18 });
    // Submodules have no children and no size.
    expect(model.nodes.find((n) => n.path === 'vendor/lib')).toMatchObject({
      bytes: null,
      children: [],
      fileCount: 0,
    });
  });

  it('counts files with no reported size without inventing bytes for them', () => {
    const model = buildArchitecture([file('a.txt'), file('b.txt', 7)]);
    expect(model.totals).toMatchObject({ files: 2, bytes: 7, filesWithoutSize: 1 });
    expect(model.nodes.find((n) => n.path === 'a.txt')?.bytes).toBeNull();
  });

  it('tallies files by extension, case-insensitively, most files first', () => {
    const model = buildArchitecture(entries);
    expect(model.extensions).toEqual([
      { extension: 'ts', files: 3, bytes: 375 },
      { extension: 'md', files: 2, bytes: 1100 },
    ]);
  });

  it('reports "no extension" as null, including dotfiles', () => {
    const model = buildArchitecture([file('Makefile', 1), file('.gitignore', 1), file('x.', 1)]);
    expect(model.extensions).toEqual([{ extension: null, files: 3, bytes: 3 }]);
  });

  it('handles an empty tree', () => {
    const model = buildArchitecture([]);
    expect(model.totals).toEqual({
      files: 0,
      directories: 0,
      symlinks: 0,
      submodules: 0,
      bytes: 0,
      filesWithoutSize: 0,
      maxDepth: 0,
    });
    expect(model.root.children).toEqual([]);
  });
});

describe('buildArchitecture with hostile or contradictory data', () => {
  it('skips and counts entries with empty path parts', () => {
    const model = buildArchitecture([
      file('/abs.txt', 1),
      file('a//b.txt', 1),
      file('trailing/', 1),
      file('ok.txt', 1),
    ]);
    expect(model.inconsistent).toBe(3);
    expect(model.totals.files).toBe(1);
  });

  it('skips and counts a file used as a directory, and duplicates', () => {
    const model = buildArchitecture([
      file('a', 1),
      file('a/b.txt', 1),
      file('dup.txt', 1),
      file('dup.txt', 1),
      { path: 'a', type: 'tree', mode: '040000' },
    ]);
    expect(model.inconsistent).toBe(3);
    expect(model.totals).toMatchObject({ files: 2, directories: 0 });
  });

  it('treats "." and ".." as plain names: paths are never resolved', () => {
    const model = buildArchitecture([file('../../etc/passwd', 5), file('./x', 1)]);
    expect(model.nodes.map((n) => n.path)).toEqual([
      '',
      '..',
      '../..',
      '../../etc',
      '../../etc/passwd',
      '.',
      './x',
    ]);
    expect(model.root.children.map((n) => n.name)).toEqual(['.', '..']);
  });

  it('makes control and bidirectional-override characters visible and harmless', () => {
    const model = buildArchitecture([file('evil\u202Etxt.exe', 1), file('nul\u0000byte', 1)]);
    const names = model.root.children.map((n) => n.name);
    expect(names).toContain('evil\uFFFDtxt.exe');
    expect(names).toContain('nul\uFFFDbyte');
    for (const name of names) {
      for (const char of name) {
        const code = char.codePointAt(0) ?? 0;
        expect(code > 0x1f && (code < 0x202a || code > 0x202e)).toBe(true);
      }
    }
  });

  it('keeps two raw paths that sanitize to the same text as two separate entries', () => {
    const model = buildArchitecture([file('a\u0001b', 1), file('a\u0002b', 2)]);
    expect(model.root.children).toHaveLength(2);
    expect(model.totals.files).toBe(2);
  });

  it('caps very long names', () => {
    const model = buildArchitecture([file(`${'x'.repeat(3000)}.txt`, 1)]);
    expect(model.root.children[0]?.name.length).toBeLessThanOrEqual(200);
  });

  it('does not overflow the stack on an extremely deep path', () => {
    const deep = Array.from({ length: 5000 }, (_unused, index) => `d${String(index)}`).join('/');
    const model = buildArchitecture([file(`${deep}/leaf.txt`, 9)]);
    expect(model.totals).toMatchObject({ files: 1, directories: 5000, bytes: 9, maxDepth: 5001 });
    expect(model.root.bytes).toBe(9);
  });

  it('builds a 100,000-entry tree with exact totals', () => {
    const many: GitHubTreeEntry[] = [];
    for (let dir = 0; dir < 1000; dir += 1) {
      many.push(tree(`pkg${String(dir)}`));
      for (let index = 0; index < 99; index += 1) {
        many.push(file(`pkg${String(dir)}/f${String(index)}.ts`, 10));
      }
    }
    const model = buildArchitecture(many);
    expect(model.totals).toMatchObject({
      files: 99_000,
      directories: 1000,
      bytes: 990_000,
      maxDepth: 2,
    });
    expect(model.root.children).toHaveLength(1000);
  });
});

describe('helpers', () => {
  it('ancestors returns the path from the root, inclusive', () => {
    const model = buildArchitecture([file('a/b/c.txt', 1)]);
    const leaf = model.nodes.find((n) => n.path === 'a/b/c.txt');
    expect(ancestors(model, leaf?.id ?? -1).map((n) => n.name)).toEqual(['', 'a', 'b', 'c.txt']);
    expect(ancestors(model, 999)).toEqual([]);
  });

  it('extensionOf ignores dotfiles, trailing dots and implausibly long suffixes', () => {
    expect(extensionOf('archive.tar.GZ')).toBe('gz');
    expect(extensionOf('.env')).toBeNull();
    expect(extensionOf('file.')).toBeNull();
    expect(extensionOf('notes.this-is-way-too-long-to-be-real')).toBeNull();
  });

  it('displayText leaves ordinary text, including non-Latin names, untouched', () => {
    expect(displayText('src/ファイル.ts')).toBe('src/ファイル.ts');
  });
});
