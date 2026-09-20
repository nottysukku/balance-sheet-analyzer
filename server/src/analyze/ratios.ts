import type { Metric, MetricValue, MetricVerdict, Period, Statement } from '../domain/types.js';
import { formatIndianCurrency } from '../parse/numbers.js';
import { indexValues, valueOf, type ValueIndex } from './derive.js';

/**
 * Financial ratios computed from the extracted statement.
 *
 * Every metric declares how it is computed and what a good number looks like,
 * so the UI can show the working and a verdict rather than a bare figure. A
 * metric returns null for a period whose inputs are missing - it is never
 * approximated, because a plausible-looking wrong ratio is worse than a
 * visible gap.
 */

interface Band {
  /** Lower bound (inclusive) for this verdict, in ascending order. */
  min: number;
  verdict: MetricVerdict;
}

/** Pick a verdict from ascending bands; `higherIsBetter` only affects wording. */
function gradeAscending(value: number, bands: Band[]): MetricVerdict {
  let verdict: MetricVerdict = 'weak';
  for (const band of bands) {
    if (value >= band.min) verdict = band.verdict;
  }
  return verdict;
}

/** Pick a verdict where a *lower* number is better (leverage ratios). */
function gradeDescending(value: number, thresholds: { max: number; verdict: MetricVerdict }[]): MetricVerdict {
  for (const threshold of thresholds) {
    if (value <= threshold.max) return threshold.verdict;
  }
  return 'weak';
}

type Computation = (index: ValueIndex, periodId: string) => {
  value: number | null;
  verdict?: MetricVerdict;
  workings?: string;
};

interface MetricDefinition {
  id: string;
  label: string;
  description: string;
  formula: string;
  format: Metric['format'];
  category: Metric['category'];
  higherIsBetter: boolean | null;
  compute: Computation;
}

const money = (value: number) => formatIndianCurrency(value);

/** Divide, returning null when the inputs are missing or the divisor is zero. */
function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  if (denominator === 0) return null;
  return numerator / denominator;
}

function totalDebt(index: ValueIndex, periodId: string): number | null {
  const long = valueOf(index, 'longTermBorrowings', periodId);
  const short = valueOf(index, 'shortTermBorrowings', periodId);
  if (long === null && short === null) return null;
  return (long ?? 0) + (short ?? 0);
}

const DEFINITIONS: MetricDefinition[] = [
  {
    id: 'currentRatio',
    label: 'Current Ratio',
    description: 'Short-term assets available to cover each rupee of short-term obligations.',
    formula: 'Current Assets ÷ Current Liabilities',
    format: 'ratio',
    category: 'liquidity',
    higherIsBetter: true,
    compute: (index, periodId) => {
      const ca = valueOf(index, 'totalCurrentAssets', periodId);
      const cl = valueOf(index, 'totalCurrentLiabilities', periodId);
      const value = ratio(ca, cl);
      if (value === null) return { value: null };
      return {
        value,
        verdict: gradeAscending(value, [
          { min: 0, verdict: 'weak' },
          { min: 1, verdict: 'watch' },
          { min: 1.5, verdict: 'healthy' },
          { min: 2, verdict: 'strong' },
        ]),
        workings: `${money(ca!)} ÷ ${money(cl!)}`,
      };
    },
  },
  {
    id: 'quickRatio',
    label: 'Quick Ratio',
    description:
      'Liquidity excluding inventory - what could be paid without first selling stock.',
    formula: '(Current Assets − Inventories) ÷ Current Liabilities',
    format: 'ratio',
    category: 'liquidity',
    higherIsBetter: true,
    compute: (index, periodId) => {
      const ca = valueOf(index, 'totalCurrentAssets', periodId);
      const cl = valueOf(index, 'totalCurrentLiabilities', periodId);
      const inventory = valueOf(index, 'inventories', periodId) ?? 0;
      if (ca === null || cl === null) return { value: null };
      const value = ratio(ca - inventory, cl);
      if (value === null) return { value: null };
      return {
        value,
        verdict: gradeAscending(value, [
          { min: 0, verdict: 'weak' },
          { min: 0.75, verdict: 'watch' },
          { min: 1, verdict: 'healthy' },
          { min: 1.5, verdict: 'strong' },
        ]),
        workings: `(${money(ca)} − ${money(inventory)}) ÷ ${money(cl)}`,
      };
    },
  },
  {
    id: 'cashRatio',
    label: 'Cash Ratio',
    description: 'Cash on hand against current liabilities - the strictest liquidity test.',
    formula: 'Cash & Cash Equivalents ÷ Current Liabilities',
    format: 'ratio',
    category: 'liquidity',
    higherIsBetter: true,
    compute: (index, periodId) => {
      const cash = valueOf(index, 'cashAndCashEquivalents', periodId);
      const cl = valueOf(index, 'totalCurrentLiabilities', periodId);
      const value = ratio(cash, cl);
      if (value === null) return { value: null };
      return {
        value,
        verdict: gradeAscending(value, [
          { min: 0, verdict: 'weak' },
          { min: 0.1, verdict: 'watch' },
          { min: 0.25, verdict: 'healthy' },
          { min: 0.5, verdict: 'strong' },
        ]),
        workings: `${money(cash!)} ÷ ${money(cl!)}`,
      };
    },
  },
  {
    id: 'workingCapital',
    label: 'Working Capital',
    description: 'Current assets left after settling every current liability.',
    formula: 'Current Assets − Current Liabilities',
    format: 'currency',
    category: 'liquidity',
    higherIsBetter: true,
    compute: (index, periodId) => {
      const ca = valueOf(index, 'totalCurrentAssets', periodId);
      const cl = valueOf(index, 'totalCurrentLiabilities', periodId);
      if (ca === null || cl === null) return { value: null };
      const value = ca - cl;
      return {
        value,
        verdict: value > 0 ? (value > cl * 0.5 ? 'strong' : 'healthy') : 'weak',
        workings: `${money(ca)} − ${money(cl)}`,
      };
    },
  },
  {
    id: 'totalDebt',
    label: 'Total Debt',
    description: 'All interest-bearing borrowings, long and short term.',
    formula: 'Long-term Borrowings + Short-term Borrowings',
    format: 'currency',
    category: 'leverage',
    higherIsBetter: false,
    compute: (index, periodId) => {
      const value = totalDebt(index, periodId);
      if (value === null) return { value: null };
      const long = valueOf(index, 'longTermBorrowings', periodId) ?? 0;
      const short = valueOf(index, 'shortTermBorrowings', periodId) ?? 0;
      return { value, verdict: 'neutral', workings: `${money(long)} + ${money(short)}` };
    },
  },
  {
    id: 'netWorth',
    label: 'Net Worth',
    description: 'The shareholders’ residual claim: share capital plus accumulated reserves.',
    formula: 'Share Capital + Reserves & Surplus',
    format: 'currency',
    category: 'structure',
    higherIsBetter: true,
    compute: (index, periodId) => {
      const value = valueOf(index, 'totalEquity', periodId);
      if (value === null) return { value: null };
      const capital = valueOf(index, 'shareCapital', periodId);
      const reserves = valueOf(index, 'reservesAndSurplus', periodId);
      return {
        value,
        verdict: value > 0 ? 'healthy' : 'weak',
        workings:
          capital !== null && reserves !== null
            ? `${money(capital)} + ${money(reserves)}`
            : undefined,
      };
    },
  },
  {
    id: 'debtToEquity',
    label: 'Debt-to-Equity',
    description: 'Borrowed rupees for every rupee of shareholder capital.',
    formula: 'Total Debt ÷ Net Worth',
    format: 'times',
    category: 'leverage',
    higherIsBetter: false,
    compute: (index, periodId) => {
      const debt = totalDebt(index, periodId);
      const equity = valueOf(index, 'totalEquity', periodId);
      const value = ratio(debt, equity);
      if (value === null) return { value: null };
      return {
        value,
        verdict: gradeDescending(value, [
          { max: 0.5, verdict: 'strong' },
          { max: 1, verdict: 'healthy' },
          { max: 2, verdict: 'watch' },
        ]),
        workings: `${money(debt!)} ÷ ${money(equity!)}`,
      };
    },
  },
  {
    id: 'assetToLiability',
    label: 'Asset-to-Liability',
    description: 'Total assets backing each rupee of total liabilities - the solvency cushion.',
    formula: 'Total Assets ÷ Total Liabilities',
    format: 'times',
    category: 'structure',
    higherIsBetter: true,
    compute: (index, periodId) => {
      const assets = valueOf(index, 'totalAssets', periodId);
      const liabilities = valueOf(index, 'totalLiabilities', periodId);
      const value = ratio(assets, liabilities);
      if (value === null) return { value: null };
      return {
        value,
        verdict: gradeAscending(value, [
          { min: 0, verdict: 'weak' },
          { min: 1, verdict: 'watch' },
          { min: 1.3, verdict: 'healthy' },
          { min: 1.75, verdict: 'strong' },
        ]),
        workings: `${money(assets!)} ÷ ${money(liabilities!)}`,
      };
    },
  },
  {
    id: 'debtToAssets',
    label: 'Debt-to-Assets',
    description: 'Share of the asset base funded by borrowings.',
    formula: 'Total Debt ÷ Total Assets',
    format: 'percent',
    category: 'leverage',
    higherIsBetter: false,
    compute: (index, periodId) => {
      const debt = totalDebt(index, periodId);
      const assets = valueOf(index, 'totalAssets', periodId);
      const value = ratio(debt, assets);
      if (value === null) return { value: null };
      return {
        value,
        verdict: gradeDescending(value, [
          { max: 0.3, verdict: 'strong' },
          { max: 0.5, verdict: 'healthy' },
          { max: 0.7, verdict: 'watch' },
        ]),
        workings: `${money(debt!)} ÷ ${money(assets!)}`,
      };
    },
  },
  {
    id: 'equityRatio',
    label: 'Equity Ratio',
    description: 'Share of total assets financed by shareholders rather than creditors.',
    formula: 'Net Worth ÷ Total Assets',
    format: 'percent',
    category: 'structure',
    higherIsBetter: true,
    compute: (index, periodId) => {
      const equity = valueOf(index, 'totalEquity', periodId);
      const assets = valueOf(index, 'totalAssets', periodId);
      const value = ratio(equity, assets);
      if (value === null) return { value: null };
      return {
        value,
        verdict: gradeAscending(value, [
          { min: 0, verdict: 'weak' },
          { min: 0.25, verdict: 'watch' },
          { min: 0.4, verdict: 'healthy' },
          { min: 0.6, verdict: 'strong' },
        ]),
        workings: `${money(equity!)} ÷ ${money(assets!)}`,
      };
    },
  },
  {
    id: 'inventoryShareOfCurrentAssets',
    label: 'Inventory Share of Current Assets',
    description: 'How much of the short-term asset base is tied up in stock.',
    formula: 'Inventories ÷ Current Assets',
    format: 'percent',
    category: 'efficiency',
    higherIsBetter: false,
    compute: (index, periodId) => {
      const inventory = valueOf(index, 'inventories', periodId);
      const ca = valueOf(index, 'totalCurrentAssets', periodId);
      const value = ratio(inventory, ca);
      if (value === null) return { value: null };
      return {
        value,
        verdict: gradeDescending(value, [
          { max: 0.3, verdict: 'strong' },
          { max: 0.5, verdict: 'healthy' },
          { max: 0.65, verdict: 'watch' },
        ]),
        workings: `${money(inventory!)} ÷ ${money(ca!)}`,
      };
    },
  },
];

export function computeMetrics(statement: Statement): Metric[] {
  const index = indexValues(statement.lineItems);
  const periods: Period[] = statement.periods;

  return DEFINITIONS.map((definition) => {
    const values: MetricValue[] = periods.map((period) => {
      const result = definition.compute(index, period.id);
      return {
        periodId: period.id,
        value: result.value,
        verdict: result.value === null ? 'neutral' : result.verdict ?? 'neutral',
        workings: result.workings,
      };
    });

    // Periods are ordered most recent first.
    const latest = values[0]?.value ?? null;
    const previous = values[1]?.value ?? null;
    const change = latest !== null && previous !== null ? latest - previous : null;
    const changePct =
      latest !== null && previous !== null && previous !== 0
        ? (latest - previous) / Math.abs(previous)
        : null;

    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      formula: definition.formula,
      format: definition.format,
      higherIsBetter: definition.higherIsBetter,
      category: definition.category,
      values,
      change,
      changePct,
    } satisfies Metric;
  }).filter((metric) => metric.values.some((v) => v.value !== null));
}
