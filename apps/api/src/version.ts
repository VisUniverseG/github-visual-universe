import { readFileSync } from 'node:fs';

/** Reads this package's version. `../package.json` resolves from both `src/` and `dist/`. */
export function readVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof parsed.version === 'string'
  ) {
    return parsed.version;
  }
  return '0.0.0';
}
