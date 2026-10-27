import { SafetyError } from '../lib/safety.mjs';

const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** Validates `owner/name` strictly so fixtures can never inject path segments. */
export function parseRepo(value, envName) {
  if (!REPO_PATTERN.test(value) || value.includes('..')) {
    throw new SafetyError(`${envName} must look like "owner/name"`);
  }
  const [owner, name] = value.split('/');
  return { owner, name, key: value.toLowerCase() };
}

export const repoPath = (repo) => `/repos/${repo.owner}/${repo.name}`;

export function headerPresence(headers, names) {
  return Object.fromEntries(names.map((name) => [name, headers.has(name)]));
}

export function hasNextPage(headers) {
  return /rel="next"/.test(headers.get('link') ?? '');
}

/** Follows `Link: rel="next"` for up to `maxPages` pages. Returns items only, never raw bodies. */
export async function getAllPages(client, path, { key = null, maxPages = 5 } = {}) {
  const items = [];
  const separator = path.includes('?') ? '&' : '?';
  let status = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await client.get(`${path}${separator}per_page=100&page=${page}`);
    status = res.status;
    const batch = key ? res.json?.[key] : res.json;
    if (res.status !== 200 || !Array.isArray(batch)) {
      return { items, status, truncated: false };
    }
    items.push(...batch);
    if (!hasNextPage(res.headers)) return { items, status, truncated: false };
    if (page === maxPages) return { items, status, truncated: true };
  }
  return { items, status, truncated: false };
}

/** GitHub documents `YYYY-MM-DD HH:MM:SS UTC` for the PAT variant; parsing is best-effort. */
export function hoursUntil(headerValue, now = Date.now()) {
  if (!headerValue) return null;
  const normalised = headerValue
    .trim()
    .replace(' UTC', 'Z')
    .replace(' ', 'T')
    .replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2');
  const time = Date.parse(normalised);
  if (Number.isNaN(time)) return null;
  return Math.round(((time - now) / 3_600_000) * 10) / 10;
}

export const lower = (value) => String(value).toLowerCase();

/** Compact status summary for a set of probes: { name: status }. */
export function summariseStatuses(results) {
  return Object.fromEntries(results.map(({ name, status }) => [name, status]));
}
