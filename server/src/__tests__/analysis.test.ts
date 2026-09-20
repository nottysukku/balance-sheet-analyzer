import { describe, expect, it } from 'vitest';
import { buildBalanceChecks, deriveTotals } from '../analyze/derive.js';
import { generateInsights } from '../analyze/insights.js';
import { computeMetrics } from '../analyze/ratios.js';
import { CONCEPTS_BY_ID } from '../parse/taxonomy.js';
import type { ConceptId, ExtractedValue, LineItem, Period, Statement } from '../domain/types.js';

const PERIODS: Period[] = [
  { id: 'FY2024', label: '31st Mar 2024', endDate: '2024-03-31', order: 2024 },
  { id: 'FY2023', label: '31st Mar 2023', endDate: '2023-03-31', order: 2023 },
];

const extracted = (value: number): ExtractedValue => ({
  value,
  origin: 'extracted',
  confidence: 0.9,
});

function item(concept: ConceptId, fy2024: number, fy2023: number): LineItem {
  const definition = CONCEPTS_BY_ID.get(concept)!;
  return {
    concept,
    label: definition.label,
    section: definition.section,
    group: definition.group,
    isTotal: definition.isTotal,
    values: { FY2024: extracted(fy2024), FY2023: extracted(fy2023) },
  };
}

/** The figures from the reference filing, in absolute rupees. */
const SAMPLE: LineItem[] = [
  item('shareCapital', 37362140, 37362140),
  item('reservesAndSurplus', 513975424, 491983895),
  item('longTermBorrowings', 202508939, 273290824),
  item('deferredTaxLiabilities', 2611863, 7656018),
  item('shortTermBorrowings', 361211353, 491257194),
  item('tradePayables', 27056594, 27795484),
  item('otherCurrentLiabilities', 32091101, 41171976),
  item('propertyPlantAndEquipment', 64282324, 127137234),
  item('currentInvestments', 7330400, 7330400),
  item('inventories', 699006548, 798810631),
  item('tradeReceivables', 245438959, 213511710),
  item('cashAndCashEquivalents', 33721121, 88054819),
  item('shortTermLoansAndAdvances', 127098062, 135072732),
];

function buildStatement(lineItems = SAMPLE): Statement {
  const derived = deriveTotals(lineItems, PERIODS);
  return {
    company: { name: 'LAJ EXPORTS LIMITED', currency: 'INR' },
    periods: PERIODS,
    lineItems: derived,
    balanceChecks: buildBalanceChecks(derived, PERIODS),
  };
}

const find = (statement: Statement, concept: ConceptId, periodId = 'FY2024') =>
  statement.lineItems.find((i) => i.concept === concept)?.values[periodId]?.value ?? null;

describe('deriveTotals', () => {
  it('rolls components up into subtotals', () => {
    const statement = buildStatement();
    expect(find(statement, 'totalEquity')).toBe(551337564);
    expect(find(statement, 'totalCurrentLiabilities')).toBe(420359048);
    expect(find(statement, 'totalNonCurrentLiabilities')).toBe(205120802);
    expect(find(statement, 'totalCurrentAssets')).toBe(1112595090);
    expect(find(statement, 'totalAssets')).toBe(1176877414);
    expect(find(statement, 'totalEquityAndLiabilities')).toBe(1176817414);
  });

  it('marks computed rows as derived', () => {
    const statement = buildStatement();
    const total = statement.lineItems.find((i) => i.concept === 'totalAssets');
    expect(total?.values.FY2024?.origin).toBe('derived');
  });

  it('keeps a printed total that agrees with the components', () => {
    const printed = [...SAMPLE, item('totalAssets', 1176877414, 1369917526)];
    const statement = buildStatement(printed);
    const total = statement.lineItems.find((i) => i.concept === 'totalAssets');
    expect(total?.values.FY2024?.origin).toBe('extracted');
    expect(total?.values.FY2024?.value).toBe(1176877414);
  });

  it('overrides a printed total that contradicts the components', () => {
    // A misread grand total must not silently become the answer.
    const printed = [...SAMPLE, item('totalAssets', 999999999, 1369917526)];
    const statement = buildStatement(printed);
    const total = statement.lineItems.find((i) => i.concept === 'totalAssets');
    expect(total?.values.FY2024?.origin).toBe('derived');
    expect(total?.values.FY2024?.value).toBe(1176877414);
  });
});

describe('buildBalanceChecks', () => {
  it('treats a single misread digit as balanced, not as an imbalance', () => {
    // The two sides differ by 60,000 on a 117 crore balance sheet: 0.005%.
    const statement = buildStatement();
    const check = statement.balanceChecks.find((c) => c.periodId === 'FY2024')!;
    expect(check.status).toBe('balanced');
    expect(check.difference).toBe(60000);
    expect(check.relativeDifference!).toBeLessThan(0.0001);
  });

  it('flags a genuine imbalance', () => {
    const broken = SAMPLE.filter((i) => i.concept !== 'inventories');
    const statement = buildStatement(broken);
    const check = statement.balanceChecks.find((c) => c.periodId === 'FY2024')!;
    expect(check.status).toBe('imbalanced');
  });

  it('reports insufficient data rather than guessing', () => {
    const statement = buildStatement([item('shareCapital', 37362140, 37362140)]);
    const check = statement.balanceChecks.find((c) => c.periodId === 'FY2024')!;
    expect(check.status).toBe('insufficient-data');
  });
});

describe('computeMetrics', () => {
  const metrics = computeMetrics(buildStatement());
  const metric = (id: string) => metrics.find((m) => m.id === id)!;
  const latest = (id: string) => metric(id).values.find((v) => v.periodId === 'FY2024')!.value;

  it('computes the ratios the brief asks for', () => {
    expect(latest('currentRatio')).toBeCloseTo(2.647, 3);
    expect(latest('debtToEquity')).toBeCloseTo(1.022, 3);
    expect(latest('workingCapital')).toBe(692236042);
    expect(latest('totalDebt')).toBe(563720292);
    expect(latest('netWorth')).toBe(551337564);
    expect(latest('assetToLiability')).toBeCloseTo(1.882, 3);
  });

  it('computes quick ratio net of inventory', () => {
    expect(latest('quickRatio')).toBeCloseTo(0.984, 3);
  });

  it('grades each figure', () => {
    expect(metric('currentRatio').values[0]!.verdict).toBe('strong');
    expect(metric('quickRatio').values[0]!.verdict).toBe('watch');
  });

  it('reports the year-on-year move', () => {
    // Debt fell from 76.45 Cr to 56.37 Cr.
    expect(metric('totalDebt').changePct!).toBeCloseTo(-0.2626, 3);
  });

  it('returns null rather than a fabricated ratio when inputs are missing', () => {
    const partial = computeMetrics(buildStatement([item('shareCapital', 100, 100)]));
    const currentRatio = partial.find((m) => m.id === 'currentRatio');
    expect(currentRatio).toBeUndefined();
  });
});

describe('generateInsights', () => {
  const statement = buildStatement();
  const insights = generateInsights(statement, computeMetrics(statement));
  const ids = insights.map((i) => i.id);

  it('spots that liquidity depends on inventory', () => {
    expect(ids).toContain('inventory-heavy-liquidity');
  });

  it('spots the deleveraging', () => {
    const debt = insights.find((i) => i.id === 'debt-trend')!;
    expect(debt.kind).toBe('strength');
    expect(debt.title).toMatch(/reduced 26\.3%/);
  });

  it('spots the cash drawdown', () => {
    expect(ids).toContain('mover-cashAndCashEquivalents');
  });

  it('spots the reliance on short-term borrowing', () => {
    expect(ids).toContain('short-term-funding-concentration');
  });

  it('puts the most severe findings first', () => {
    expect(insights[0]!.severity).toBe('high');
  });

  it('produces both strengths and concerns', () => {
    expect(insights.some((i) => i.kind === 'strength')).toBe(true);
    expect(insights.some((i) => i.kind === 'concern')).toBe(true);
  });

  it('says nothing about trends when only one period is present', () => {
    const single: Statement = {
      ...statement,
      periods: [PERIODS[0]!],
    };
    const only = generateInsights(single, computeMetrics(single));
    expect(only.some((i) => i.id === 'debt-trend')).toBe(false);
  });
});
