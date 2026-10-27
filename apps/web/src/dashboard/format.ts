export interface DateFormatOptions {
  readonly locale?: string;
  readonly timeZone?: string;
}

/** A short calendar date such as "Oct 27, 2026", or `null` if the input is missing or invalid. */
export function formatDate(iso: string | null, options: DateFormatOptions = {}): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Intl.DateTimeFormat(options.locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(time);
}

export function formatCount(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatPercent(value: number): string {
  return value >= 10 || value === 0 ? `${String(Math.round(value))}%` : `${value.toFixed(1)}%`;
}
