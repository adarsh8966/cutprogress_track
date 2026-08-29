'use client';

/**
 * Weight / waist trend chart.
 *
 * FORM: this is an EMPHASIS chart, not a multi-series one. The smoothed trend is
 * the point; the raw daily readings are context and wear the de-emphasis grey.
 * Day-to-day weight swings several pounds on water alone, so making the raw
 * series compete visually with the trend would actively mislead.
 *
 * The target line is a reference, drawn as a dashed neutral rule rather than a
 * third coloured series.
 *
 * Gaps are real: a day with no measurement is null and the line breaks there
 * (connectNulls is deliberately off). A continuous line across a two-week gap
 * would imply measurements that were never taken.
 */
import {
  CartesianGrid, Line, ComposedChart, ReferenceLine, ResponsiveContainer,
  Scatter, Tooltip, XAxis, YAxis,
} from 'recharts';
import { formatShortDate } from '@/lib/normalization/dates';
import { formatNumber } from '@/components/ui/primitives';

export interface TrendPoint {
  date: string;
  raw: number | null;
  smoothed: number | null;
}

export function TrendChart({
  data,
  unit,
  target,
  smoothedLabel = '7-day average',
  height = 280,
}: {
  data: TrendPoint[];
  unit: string;
  target?: number | null;
  smoothedLabel?: string;
  height?: number;
}) {
  const values = data
    .flatMap((d) => [d.raw, d.smoothed])
    .filter((v): v is number => v !== null);
  if (target != null) values.push(target);

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

  // Round the domain out to a "nice" step so the axis ticks land on round
  // numbers. Padding the raw min/max directly produces ticks like 198.6 and
  // 191.6, which look arbitrary and are harder to read a value off.
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const step = niceStep(rawMax - rawMin);
  const min = Math.floor((rawMin - step * 0.4) / step) * step;
  const max = Math.ceil((rawMax + step * 0.4) / step) * step;

  return (
    <div>
      {/* Legend is always present for two marks, so identity is never colour-alone. */}
      <div className="mb-3 flex flex-wrap items-center gap-4 text-[11px] text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-[2px] w-4 rounded-full"
            style={{ background: 'var(--color-series-1)' }}
          />
          {smoothedLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: 'var(--color-series-muted)' }}
          />
          daily measurement
        </span>
        {target != null && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-[1px] w-4 border-t border-dashed border-ink-faint" />
            target
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
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
            domain={[min, max]}
            ticks={axisTicks(min, max, step)}
            tickFormatter={(v: number) => formatNumber(v, 1)}
            stroke="var(--color-line-strong)"
            tick={{ fill: 'var(--color-ink-faint)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <Tooltip content={<TrendTooltip unit={unit} smoothedLabel={smoothedLabel} />} />
          {target != null && (
            <ReferenceLine
              y={target}
              stroke="var(--color-ink-faint)"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          )}
          {/* Raw readings sit behind the trend, as small muted dots. */}
          <Scatter dataKey="raw" fill="var(--color-series-muted)" shape="circle" r={2.5} />
          <Line
            type="monotone"
            dataKey="smoothed"
            stroke="var(--color-series-1)"
            strokeWidth={2}
            dot={false}
            // A gap in the data must read as a gap, not as an interpolated line.
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

interface TooltipProps {
  active?: boolean;
  label?: string;
  payload?: { dataKey?: string | number; value?: number | null }[];
  unit: string;
  smoothedLabel: string;
}

function TrendTooltip({ active, label, payload, unit, smoothedLabel }: TooltipProps) {
  if (!active || !label) return null;
  const raw = payload?.find((p) => p.dataKey === 'raw')?.value ?? null;
  const smoothed = payload?.find((p) => p.dataKey === 'smoothed')?.value ?? null;

  return (
    <div className="rounded border border-line bg-raised px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-ink-faint">{formatShortDate(label)}</div>
      <div className="tabular space-y-0.5">
        <div className="flex justify-between gap-4">
          <span className="text-ink-muted">measured</span>
          <span>{raw === null ? 'not logged' : `${formatNumber(raw, 1)} ${unit}`}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-ink-muted">{smoothedLabel}</span>
          <span>
            {smoothed === null ? 'not enough data' : `${formatNumber(smoothed, 1)} ${unit}`}
          </span>
        </div>
      </div>
    </div>
  );
}

/** A round-numbered step covering the range in roughly 4-6 divisions. */
function niceStep(range: number): number {
  if (range <= 0) return 1;
  const rough = range / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const snapped = normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1;
  return snapped * magnitude;
}

function axisTicks(min: number, max: number, step: number): number[] {
  const ticks: number[] = [];
  for (let value = min; value <= max + step / 2; value += step) {
    ticks.push(Math.round(value * 1000) / 1000);
  }
  return ticks;
}
