'use client';

/**
 * Single-series column chart for daily counts (steps, calories, minutes).
 *
 * FORM: one series comparing magnitude over time, so it takes the single
 * sequential hue and needs no legend - the title names it.
 *
 * A day with no data renders as a GAP, not as a zero-height bar, because those
 * mean different things (spec §33). Recharts skips null values, which is the
 * behaviour we want.
 */
import {
  Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip,
  XAxis, YAxis,
} from 'recharts';
import { formatShortDate } from '@/lib/normalization/dates';
import { formatNumber } from '@/components/ui/primitives';

export function BarSeries({
  data,
  target,
  unit = '',
  height = 200,
  label,
}: {
  data: { date: string; value: number | null }[];
  target?: number | null;
  unit?: string;
  height?: number;
  label: string;
}) {
  const values = data.map((d) => d.value).filter((v): v is number => v !== null);
  if (values.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-ink-faint"
        style={{ height }}
      >
        Nothing logged yet.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="var(--color-line)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(d: string) => formatShortDate(d)}
          stroke="var(--color-line-strong)"
          tick={{ fill: 'var(--color-ink-faint)', fontSize: 11 }}
          tickLine={false}
          minTickGap={40}
        />
        <YAxis
          tickFormatter={(v: number) => formatNumber(v)}
          stroke="var(--color-line-strong)"
          tick={{ fill: 'var(--color-ink-faint)', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <Tooltip
          cursor={{ fill: 'var(--color-raised)' }}
          content={({ active, label: date, payload }) => {
            if (!active || typeof date !== 'string') return null;
            const value = payload?.[0]?.value;
            return (
              <div className="rounded border border-line bg-raised px-3 py-2 text-xs shadow-lg">
                <div className="mb-1 text-ink-faint">{formatShortDate(date)}</div>
                <div className="tabular">
                  {value == null
                    ? 'not logged'
                    : `${formatNumber(Number(value))}${unit ? ` ${unit}` : ''} ${label}`}
                </div>
              </div>
            );
          }}
        />
        {target != null && (
          <ReferenceLine
            y={target}
            stroke="var(--color-ink-faint)"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
        )}
        {/* 4px rounded top on the data end, anchored to the baseline. */}
        <Bar
          dataKey="value"
          fill="var(--color-series-1)"
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
