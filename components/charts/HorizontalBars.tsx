/**
 * Horizontal magnitude bars for named categories (sets per muscle group).
 *
 * FORM: comparing magnitude across long-named categories, so it goes horizontal
 * and takes the single sequential hue. Direct-labelled, so no legend and no
 * reliance on colour to tell rows apart.
 *
 * Plain HTML rather than a chart library: at this size a div with a width is
 * more legible, more accessible and lighter than an SVG chart.
 */
import { formatNumber } from '@/components/ui/primitives';

export function HorizontalBars({
  rows,
  unit = '',
}: {
  rows: { label: string; value: number; sub?: string }[];
  unit?: string;
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-sm text-ink-faint">Nothing logged yet.</p>;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <ul className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
            <span className="text-ink-muted">{row.label}</span>
            <span className="tabular text-ink">
              {formatNumber(row.value)}
              {unit && <span className="text-ink-faint"> {unit}</span>}
              {row.sub && <span className="ml-2 text-ink-faint">{row.sub}</span>}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
            <div
              className="h-full rounded-full"
              style={{
                width: `${(row.value / max) * 100}%`,
                background: 'var(--color-series-1)',
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
