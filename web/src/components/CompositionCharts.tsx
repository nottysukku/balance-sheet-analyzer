import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ConceptId, Statement } from '../types';
import { formatExact, formatMoney } from '../lib/format';

/**
 * Two questions a balance sheet answers - where the money came from, and what
 * it is sitting in - plus what moved since last year.
 *
 * Colours are the validated categorical slots (adjacent-pair CVD dE 9.1, normal
 * vision 19.6 on a white surface). Three of the five sit below 3:1 contrast, so
 * the relief rule applies: every segment carries a direct label when it is wide
 * enough, a legend is always present, and the full figures are in the statement
 * table above.
 */

const SERIES = {
  slot1: '#2a78d6',
  slot2: '#eb6834',
  slot3: '#1baf7a',
  slot4: '#eda100',
  slot5: '#e87ba4',
} as const;

/** Diverging poles for the movement chart: direction, not good/bad. */
const DIVERGING = { up: '#2a78d6', down: '#e34948', axis: '#d5d9e2' };

const INK = { primary: '#171a24', secondary: '#505a75', muted: '#8591aa', surface: '#ffffff' };

/**
 * Pick white or dark ink for a label sitting on a coloured fill.
 *
 * Three of the five categorical slots are light enough that white text on them
 * is unreadable, so the choice is computed from the fill's relative luminance
 * rather than fixed.
 */
function inkOn(hex: string): string {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.42 ? INK.primary : '#ffffff';
}

/** Narrower than this and a formatted amount cannot fit inside the segment. */
const MIN_SEGMENT_WIDTH = 58;

interface Band {
  key: string;
  label: string;
  color: string;
  concepts: ConceptId[];
}

const FUNDING: Band[] = [
  { key: 'equity', label: 'Shareholders’ funds', color: SERIES.slot1, concepts: ['totalEquity'] },
  { key: 'longDebt', label: 'Long-term debt', color: SERIES.slot2, concepts: ['longTermBorrowings'] },
  { key: 'shortDebt', label: 'Short-term debt', color: SERIES.slot3, concepts: ['shortTermBorrowings'] },
  { key: 'payables', label: 'Trade payables', color: SERIES.slot4, concepts: ['tradePayables'] },
  {
    key: 'otherLiabilities',
    label: 'Other liabilities',
    color: SERIES.slot5,
    concepts: [
      'deferredTaxLiabilities',
      'longTermProvisions',
      'otherNonCurrentLiabilities',
      'otherCurrentLiabilities',
      'shortTermProvisions',
    ],
  },
];

const DEPLOYMENT: Band[] = [
  {
    key: 'nonCurrent',
    label: 'Non-current assets',
    color: SERIES.slot1,
    concepts: ['totalNonCurrentAssets'],
  },
  { key: 'inventories', label: 'Inventories', color: SERIES.slot2, concepts: ['inventories'] },
  { key: 'receivables', label: 'Trade receivables', color: SERIES.slot3, concepts: ['tradeReceivables'] },
  { key: 'cash', label: 'Cash & equivalents', color: SERIES.slot4, concepts: ['cashAndCashEquivalents'] },
  {
    key: 'otherCurrent',
    label: 'Other current assets',
    color: SERIES.slot5,
    concepts: ['currentInvestments', 'shortTermLoansAndAdvances', 'otherCurrentAssets'],
  },
];

/** Line items whose year-on-year move is worth showing. */
const MOVERS: { concept: ConceptId; label: string }[] = [
  { concept: 'inventories', label: 'Inventories' },
  { concept: 'tradeReceivables', label: 'Trade receivables' },
  { concept: 'cashAndCashEquivalents', label: 'Cash & equivalents' },
  { concept: 'shortTermBorrowings', label: 'Short-term debt' },
  { concept: 'longTermBorrowings', label: 'Long-term debt' },
  { concept: 'reservesAndSurplus', label: 'Reserves & surplus' },
  { concept: 'propertyPlantAndEquipment', label: 'Property, plant & equip.' },
  { concept: 'tradePayables', label: 'Trade payables' },
];

/**
 * Track a container's width so a chart can adapt to it.
 *
 * Breakpoints alone are not enough here: these charts sit in a grid that is
 * one column on a phone and two on a desktop, so the same breakpoint gives
 * very different plot widths.
 */
function useContainerWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/** Below this the movement chart has no room for labels outside its bars. */
const MOVEMENT_LABEL_MIN_WIDTH = 480;

function useValueLookup(statement: Statement) {
  const map = new Map<ConceptId, Record<string, number>>();
  for (const item of statement.lineItems) {
    const byPeriod: Record<string, number> = {};
    for (const [periodId, value] of Object.entries(item.values)) byPeriod[periodId] = value.value;
    map.set(item.concept, byPeriod);
  }
  return (concept: ConceptId, periodId: string): number | null => map.get(concept)?.[periodId] ?? null;
}

interface TooltipEntry {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string;
}

function StackTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((sum, entry) => sum + (entry.value ?? 0), 0);

  return (
    <div className="rounded-lg border border-ink-200 bg-white px-3 py-2 shadow-lg">
      <p className="text-xs font-semibold text-ink-900">{label}</p>
      <ul className="mt-1.5 space-y-1">
        {payload
          .filter((entry) => (entry.value ?? 0) > 0)
          .map((entry) => (
            <li key={entry.dataKey} className="flex items-center gap-2 text-xs">
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: entry.color }}
                aria-hidden
              />
              <span className="text-ink-600">{entry.name}</span>
              <span className="tnum ml-auto font-mono font-medium text-ink-900">
                {formatMoney(entry.value ?? 0, currency)}
              </span>
              <span className="tnum w-10 text-right text-ink-400">
                {total > 0 ? `${Math.round(((entry.value ?? 0) / total) * 100)}%` : ''}
              </span>
            </li>
          ))}
      </ul>
      <p className="tnum mt-1.5 border-t border-ink-100 pt-1.5 text-right font-mono text-xs font-semibold text-ink-900">
        {formatMoney(total, currency)}
      </p>
    </div>
  );
}

function Legend({ bands }: { bands: Band[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {bands.map((band) => (
        <li key={band.key} className="flex items-center gap-1.5 text-[11px] text-ink-600">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: band.color }} aria-hidden />
          {band.label}
        </li>
      ))}
    </ul>
  );
}

interface StackProps {
  title: string;
  subtitle: string;
  bands: Band[];
  statement: Statement;
}

function StackedComposition({ title, subtitle, bands, statement }: StackProps) {
  const lookup = useValueLookup(statement);
  const currency = statement.company.currency ?? 'INR';

  const data = statement.periods.map((period) => {
    const row: Record<string, string | number> = { period: period.label };
    for (const band of bands) {
      const total = band.concepts.reduce((sum, concept) => sum + (lookup(concept, period.id) ?? 0), 0);
      row[band.key] = total;
    }
    return row;
  });

  const present = bands.filter((band) => data.some((row) => Number(row[band.key]) > 0));
  if (present.length === 0) return null;

  return (
    <div className="card card-pad">
      <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
      <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>

      <div className="mt-4" style={{ height: statement.periods.length * 72 + 34 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }} barSize={38}>
            <XAxis
              type="number"
              tickFormatter={(value: number) => formatMoney(value, currency)}
              stroke={INK.muted}
              tick={{ fontSize: 10, fill: INK.muted }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="period"
              width={96}
              stroke={INK.muted}
              tick={{ fontSize: 11, fill: INK.secondary }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: 'rgba(15,118,110,0.06)' }}
              content={<StackTooltip currency={currency} />}
            />
            {present.map((band, index) => (
              <Bar
                key={band.key}
                dataKey={band.key}
                name={band.label}
                stackId="a"
                fill={band.color}
                // A 2px surface-coloured stroke is the gap between segments.
                stroke={INK.surface}
                strokeWidth={2}
                radius={index === present.length - 1 ? [0, 4, 4, 0] : 0}
              >
                {/* Direct labels are the relief for the sub-3:1 slots. They are
                    drawn by hand so a segment too narrow to hold its amount is
                    left clean rather than overflowing into its neighbour. */}
                <LabelList
                  dataKey={band.key}
                  content={(props: unknown) => {
                    const { x, y, width, height, value } = props as {
                      x?: number; y?: number; width?: number; height?: number; value?: number;
                    };
                    if (
                      x === undefined || y === undefined || width === undefined ||
                      height === undefined || !value || width < MIN_SEGMENT_WIDTH
                    ) {
                      return null;
                    }
                    return (
                      <text
                        x={x + width / 2}
                        y={y + height / 2}
                        dy={3.5}
                        textAnchor="middle"
                        fontSize={10}
                        fontWeight={600}
                        fill={inkOn(band.color)}
                        pointerEvents="none"
                      >
                        {formatMoney(value, currency)}
                      </text>
                    );
                  }}
                />
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <Legend bands={present} />
    </div>
  );
}

function MovementChart({ statement }: { statement: Statement }) {
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>();
  const compact = containerWidth > 0 && containerWidth < MOVEMENT_LABEL_MIN_WIDTH;
  const lookup = useValueLookup(statement);
  const currency = statement.company.currency ?? 'INR';
  const [latest, previous] = statement.periods;
  if (!latest || !previous) return null;

  const data = MOVERS.map((mover) => {
    const current = lookup(mover.concept, latest.id);
    const prior = lookup(mover.concept, previous.id);
    if (current === null || prior === null) return null;
    return { label: mover.label, change: current - prior, current, prior };
  })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  if (data.length === 0) return null;

  // A symmetric domain keeps a rise and a fall of the same size the same
  // length. The headroom is only there to make room for the labels outside
  // each bar, so a compact chart gives the space back to the bars.
  const extent = Math.max(...data.map((row) => Math.abs(row.change))) * (compact ? 1.04 : 1.22);

  return (
    <div className="card card-pad">
      <h3 className="text-sm font-semibold text-ink-900">Year-on-year movement</h3>
      <p className="mt-0.5 text-xs text-ink-500">
        Change from {previous.label} to {latest.label}, largest first. Blue is an increase, red a decrease.
      </p>

      <div ref={containerRef} className="mt-4" style={{ height: data.length * 30 + 34 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 12 }} barSize={16}>
            <XAxis
              type="number"
              domain={[-extent, extent]}
              tickFormatter={(value: number) => formatMoney(value, currency)}
              stroke={INK.muted}
              tick={{ fontSize: 10, fill: INK.muted }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              width={compact ? 104 : 140}
              stroke={INK.muted}
              tick={{ fontSize: 11, fill: INK.secondary }}
              axisLine={false}
              tickLine={false}
            />
            <ReferenceLine x={0} stroke={DIVERGING.axis} strokeWidth={1} />
            <Tooltip
              cursor={{ fill: 'rgba(15,118,110,0.06)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]?.payload as { label: string; change: number; current: number; prior: number };
                return (
                  <div className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-xs shadow-lg">
                    <p className="font-semibold text-ink-900">{row.label}</p>
                    <p className="tnum mt-1 font-mono text-ink-600">
                      {formatExact(row.prior, currency)} &rarr; {formatExact(row.current, currency)}
                    </p>
                    <p
                      className="tnum mt-0.5 font-mono font-semibold"
                      style={{ color: row.change >= 0 ? DIVERGING.up : DIVERGING.down }}
                    >
                      {row.change >= 0 ? '+' : ''}
                      {formatMoney(row.change, currency)}
                    </p>
                  </div>
                );
              }}
            />
            <Bar dataKey="change" radius={3}>
              {data.map((row) => (
                <Cell key={row.label} fill={row.change >= 0 ? DIVERGING.up : DIVERGING.down} />
              ))}
              <LabelList
                dataKey="change"
                content={(props: unknown) => {
                  const { x, y, width, height, value } = props as {
                    x?: number; y?: number; width?: number; height?: number; value?: number;
                  };
                  // On a narrow plot the labels would sit on top of the
                  // category names; the tooltip and the table carry the figures.
                  if (compact) return null;
                  if (
                    x === undefined || y === undefined || width === undefined ||
                    height === undefined || value === undefined
                  ) {
                    return null;
                  }
                  // Recharts anchors `x` at the baseline for a negative bar, so
                  // x is not reliably the left edge. Deriving both edges from
                  // the span keeps this correct whichever way it reports them.
                  const left = Math.min(x, x + width);
                  const right = Math.max(x, x + width);
                  const rising = value >= 0;
                  return (
                    <text
                      x={rising ? right + 6 : left - 6}
                      y={y + height / 2}
                      dy={3.5}
                      textAnchor={rising ? 'start' : 'end'}
                      fontSize={10}
                      fontWeight={600}
                      fill={INK.secondary}
                      pointerEvents="none"
                    >
                      {rising ? '+' : ''}
                      {formatMoney(value, currency)}
                    </text>
                  );
                }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function CompositionCharts({ statement }: { statement: Statement }) {
  if (statement.lineItems.length === 0) return null;

  return (
    <section className="animate-fade-up space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink-900">Balance sheet shape</h2>
        <p className="mt-0.5 text-xs text-ink-500">
          The same figures as the table above, read as proportions and movements.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <StackedComposition
          title="Where the money came from"
          subtitle={"Funding mix: shareholders’ funds against borrowings and payables."}
          bands={FUNDING}
          statement={statement}
        />
        <StackedComposition
          title="Where the money is deployed"
          subtitle="Asset mix: what the funding is currently sitting in."
          bands={DEPLOYMENT}
          statement={statement}
        />
      </div>

      <MovementChart statement={statement} />
    </section>
  );
}
