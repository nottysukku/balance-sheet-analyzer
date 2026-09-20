import clsx from 'clsx';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import type { Metric, MetricVerdict, Period } from '../types';
import { formatChange, formatMetric } from '../lib/format';

const VERDICT_STYLES: Record<MetricVerdict, { dot: string; text: string; label: string }> = {
  strong: { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Strong' },
  healthy: { dot: 'bg-teal-500', text: 'text-teal-700', label: 'Healthy' },
  watch: { dot: 'bg-amber-500', text: 'text-amber-700', label: 'Watch' },
  weak: { dot: 'bg-rose-500', text: 'text-rose-700', label: 'Weak' },
  neutral: { dot: 'bg-ink-300', text: 'text-ink-500', label: '' },
};

const CATEGORY_LABELS: Record<Metric['category'], string> = {
  liquidity: 'Liquidity',
  leverage: 'Leverage',
  structure: 'Capital structure',
  efficiency: 'Asset mix',
};

const CATEGORY_ORDER: Metric['category'][] = ['liquidity', 'leverage', 'structure', 'efficiency'];

interface Props {
  metrics: Metric[];
  periods: Period[];
  currency: string;
}

function MetricCard({ metric, periods, currency }: { metric: Metric; periods: Period[]; currency: string }) {
  const latest = metric.values.find((value) => value.periodId === periods[0]?.id);
  const previous = periods[1] ? metric.values.find((value) => value.periodId === periods[1]?.id) : undefined;
  const verdict = VERDICT_STYLES[latest?.verdict ?? 'neutral'];

  const change = formatChange(metric.change, metric.changePct, metric.format, currency);
  // An arrow is only meaningful when we know which direction is good.
  const improving =
    metric.change === null || metric.higherIsBetter === null
      ? null
      : metric.higherIsBetter
        ? metric.change > 0
        : metric.change < 0;
  const Arrow = metric.change === null || metric.change === 0 ? ArrowRight : metric.change > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <div className="card card-pad flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold leading-snug text-ink-700">{metric.label}</h3>
        {verdict.label && (
          <span className={clsx('inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold', verdict.text)}>
            <span className={clsx('h-1.5 w-1.5 rounded-full', verdict.dot)} aria-hidden />
            {verdict.label}
          </span>
        )}
      </div>

      <p className="tnum mt-2.5 font-mono text-2xl font-semibold tracking-tight text-ink-900">
        {formatMetric(latest?.value ?? null, metric.format, currency)}
      </p>

      {change && (
        <p
          className={clsx(
            'mt-1.5 inline-flex items-center gap-1 text-xs font-medium',
            improving === null ? 'text-ink-500' : improving ? 'text-emerald-700' : 'text-rose-700',
          )}
        >
          <Arrow className="h-3.5 w-3.5" aria-hidden />
          {change}
          <span className="font-normal text-ink-400">
            vs {formatMetric(previous?.value ?? null, metric.format, currency)}
          </span>
        </p>
      )}

      <p className="mt-3 text-xs leading-relaxed text-ink-600">{metric.description}</p>

      <div className="mt-auto pt-3">
        <p className="font-mono text-[10px] leading-relaxed text-ink-400">{metric.formula}</p>
        {latest?.workings && (
          <p className="tnum mt-0.5 font-mono text-[10px] leading-relaxed text-ink-400">{latest.workings}</p>
        )}
      </div>
    </div>
  );
}

export function MetricsGrid({ metrics, periods, currency }: Props) {
  if (metrics.length === 0) return null;

  const byCategory = CATEGORY_ORDER.map((category) => ({
    category,
    items: metrics.filter((metric) => metric.category === category),
  })).filter((group) => group.items.length > 0);

  return (
    <section className="animate-fade-up space-y-6">
      <div>
        <h2 className="text-base font-semibold text-ink-900">Financial metrics</h2>
        <p className="mt-0.5 text-xs text-ink-500">
          Computed from the extracted figures. Each card shows the formula and the numbers behind it.
        </p>
      </div>

      {byCategory.map((group) => (
        <div key={group.category}>
          <h3 className="label-caps mb-2.5">{CATEGORY_LABELS[group.category]}</h3>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {group.items.map((metric) => (
              <MetricCard key={metric.id} metric={metric} periods={periods} currency={currency} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
