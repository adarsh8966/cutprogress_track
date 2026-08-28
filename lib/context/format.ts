/**
 * Context Pack text primitives (spec §30).
 *
 * The pack is plain text destined for a ChatGPT prompt, so it optimises for
 * being unambiguous when read by a model: fixed section banners, one fact per
 * line, units always attached, and missing values written as an explicit
 * "not logged" rather than omitted or shown as 0 (spec §33).
 */

export const BANNER_WIDTH = 52;

export function banner(title: string): string {
  const rule = '='.repeat(BANNER_WIDTH);
  return `${rule}\n${title.toUpperCase()}\n${rule}`;
}

export function section(title: string): string {
  return `\n${title.toUpperCase()}\n${'-'.repeat(BANNER_WIDTH)}`;
}

/**
 * A single labelled fact. `value` of null renders as "not logged", which is the
 * whole point: ChatGPT must be able to tell an unmeasured day from a zero.
 */
export function line(label: string, value: string | number | null, unit = ''): string {
  if (value === null) return `- ${label}: not logged`;
  const rendered = typeof value === 'number' ? formatNumber(value) : value;
  return `- ${label}: ${rendered}${unit ? ` ${unit}` : ''}`;
}

export function formatNumber(value: number, decimals?: number): string {
  const places =
    decimals ??
    (Number.isInteger(value) ? 0 : Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2);
  return value.toLocaleString('en-US', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/** Renders a signed rate, e.g. "-1.32 lb/week". */
export function formatRate(value: number | null, unit: string): string {
  if (value === null) return 'not computable';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatNumber(value, 2)} ${unit}`;
}

export function percent(value: number | null, decimals = 0): string {
  if (value === null) return 'not computable';
  return `${(value * 100).toFixed(decimals)}%`;
}

/** A fixed-width two-column table for daily detail blocks. */
export function table(headers: string[], rows: (string | number | null)[][]): string {
  const cells = [
    headers,
    ...rows.map((row) =>
      row.map((cell) =>
        cell === null ? '-' : typeof cell === 'number' ? formatNumber(cell) : cell,
      ),
    ),
  ];
  const widths = headers.map((_, column) =>
    Math.max(...cells.map((row) => String(row[column] ?? '').length)),
  );
  const render = (row: (string | number | null)[]): string =>
    row.map((cell, i) => String(cell ?? '').padEnd(widths[i]!)).join('  ').trimEnd();

  return [
    render(cells[0]!),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...cells.slice(1).map(render),
  ].join('\n');
}
