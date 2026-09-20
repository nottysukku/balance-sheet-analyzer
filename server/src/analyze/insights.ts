import type { ConceptId, Insight, Metric, Statement } from '../domain/types.js';
import { formatIndianCurrency } from '../parse/numbers.js';
import { indexValues, valueOf } from './derive.js';

/**
 * A deterministic, explainable insight engine.
 *
 * Every observation is derived from figures already on screen and cites the
 * metrics behind it, so a reader can check the reasoning. This runs whether or
 * not an LLM key is configured; when one is, the model rewrites the summary
 * narrative but these findings still anchor it.
 */

const money = (value: number) => formatIndianCurrency(value);
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const times = (value: number) => `${value.toFixed(2)}×`;

interface Context {
  statement: Statement;
  metrics: Map<string, Metric>;
  latest: string;
  previous: string | null;
  value: (concept: ConceptId, periodId: string) => number | null;
  metricValue: (id: string, periodId: string) => number | null;
}

/** Relative change, or null when it cannot be computed meaningfully. */
function delta(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return (current - prior) / Math.abs(prior);
}

type Rule = (ctx: Context) => Insight | Insight[] | null;

const RULES: Rule[] = [
  /* ----------------------------- liquidity ----------------------------- */
  (ctx) => {
    const current = ctx.metricValue('currentRatio', ctx.latest);
    if (current === null) return null;
    const prior = ctx.previous ? ctx.metricValue('currentRatio', ctx.previous) : null;
    const direction =
      prior === null ? '' : current > prior ? ` (up from ${times(prior)})` : ` (down from ${times(prior)})`;

    if (current >= 2) {
      return {
        id: 'liquidity-strong',
        kind: 'strength',
        severity: 'low',
        title: `Comfortable current ratio at ${times(current)}`,
        detail: `Current assets cover current liabilities ${times(current)} over${direction}. There is a wide margin for meeting near-term obligations without new financing.`,
        evidence: ['currentRatio', 'workingCapital'],
      };
    }
    if (current >= 1) {
      return {
        id: 'liquidity-adequate',
        kind: 'observation',
        severity: 'medium',
        title: `Current ratio of ${times(current)} leaves a thin margin`,
        detail: `Current assets exceed current liabilities, but only by ${pct(current - 1)}${direction}. A delay in collections or a stock write-down would put short-term cover under pressure.`,
        evidence: ['currentRatio'],
      };
    }
    return {
      id: 'liquidity-deficit',
      kind: 'concern',
      severity: 'high',
      title: `Current liabilities exceed current assets (${times(current)})`,
      detail: `Short-term obligations are larger than the assets available to settle them${direction}. The company is dependent on refinancing or on operating cash flow arriving on time.`,
      evidence: ['currentRatio', 'workingCapital'],
    };
  },

  /* ------------------- liquidity quality vs. inventory ------------------ */
  (ctx) => {
    const quick = ctx.metricValue('quickRatio', ctx.latest);
    const currentRatio = ctx.metricValue('currentRatio', ctx.latest);
    const share = ctx.metricValue('inventoryShareOfCurrentAssets', ctx.latest);
    if (quick === null || currentRatio === null || share === null) return null;
    if (share < 0.45) return null;

    const inventory = ctx.value('inventories', ctx.latest);
    const ca = ctx.value('totalCurrentAssets', ctx.latest);

    return {
      id: 'inventory-heavy-liquidity',
      kind: quick < 1 ? 'concern' : 'observation',
      severity: quick < 1 ? 'high' : 'medium',
      title: `Liquidity rests on inventory: ${pct(share)} of current assets`,
      detail:
        `Inventory of ${inventory !== null ? money(inventory) : 'n/a'} makes up ${pct(share)} of the ${ca !== null ? money(ca) : ''} current asset base. ` +
        `Stripping it out drops the ratio from ${times(currentRatio)} to a quick ratio of ${times(quick)}` +
        (quick < 1
          ? ', meaning liabilities due within the year cannot be met without converting stock to cash first.'
          : ', which still covers current liabilities.'),
      evidence: ['quickRatio', 'inventoryShareOfCurrentAssets', 'inventories'],
    };
  },

  /* ------------------------------ leverage ----------------------------- */
  (ctx) => {
    const de = ctx.metricValue('debtToEquity', ctx.latest);
    if (de === null) return null;
    const prior = ctx.previous ? ctx.metricValue('debtToEquity', ctx.previous) : null;

    if (de <= 1) {
      return {
        id: 'leverage-conservative',
        kind: 'strength',
        severity: 'low',
        title: `Debt-to-equity of ${times(de)} is within a conservative range`,
        detail:
          `Borrowings are ${de <= 0.5 ? 'well below' : 'broadly in line with'} shareholder funds` +
          (prior !== null ? `, improved from ${times(prior)} a year earlier.` : '.') +
          ' The capital structure is not over-geared.',
        evidence: ['debtToEquity', 'netWorth', 'totalDebt'],
      };
    }
    if (de <= 2) {
      return {
        id: 'leverage-moderate',
        kind: 'observation',
        severity: 'medium',
        title: `Debt-to-equity of ${times(de)} - borrowings exceed net worth`,
        detail:
          `Every rupee of shareholder capital supports ${times(de)} of debt` +
          (prior !== null ? `, against ${times(prior)} last year.` : '.') +
          ' Servicing capacity depends on earnings holding up.',
        evidence: ['debtToEquity', 'totalDebt'],
      };
    }
    return {
      id: 'leverage-high',
      kind: 'concern',
      severity: 'high',
      title: `High leverage: debt-to-equity of ${times(de)}`,
      detail:
        `Borrowings are more than twice shareholder funds` +
        (prior !== null ? ` (${times(prior)} last year).` : '.') +
        ' The balance sheet has limited headroom to absorb a downturn or a rate rise.',
      evidence: ['debtToEquity', 'totalDebt', 'netWorth'],
    };
  },

  /* --------------------- short-term funding mix ------------------------ */
  (ctx) => {
    const shortTerm = ctx.value('shortTermBorrowings', ctx.latest);
    const cl = ctx.value('totalCurrentLiabilities', ctx.latest);
    const longTerm = ctx.value('longTermBorrowings', ctx.latest);
    if (shortTerm === null || cl === null || cl === 0) return null;
    const share = shortTerm / cl;
    if (share < 0.55) return null;

    const debt = (shortTerm ?? 0) + (longTerm ?? 0);
    return {
      id: 'short-term-funding-concentration',
      kind: 'concern',
      severity: share >= 0.75 ? 'high' : 'medium',
      title: `${pct(share)} of current liabilities is short-term borrowing`,
      detail:
        `Short-term borrowings of ${money(shortTerm)} dominate the ${money(cl)} of current liabilities` +
        (debt > 0 ? `, and make up ${pct(shortTerm / debt)} of total debt.` : '.') +
        ' Working capital is funded by facilities that must be rolled over, so the company carries refinancing risk alongside its trading risk.',
      evidence: ['shortTermBorrowings', 'totalCurrentLiabilities'],
    };
  },

  /* ------------------------------- trends ------------------------------ */
  (ctx) => {
    if (!ctx.previous) return null;
    const current = ctx.metricValue('totalDebt', ctx.latest);
    const prior = ctx.metricValue('totalDebt', ctx.previous);
    const change = delta(current, prior);
    if (current === null || prior === null || change === null) return null;
    if (Math.abs(change) < 0.05) return null;

    const reduced = change < 0;
    return {
      id: 'debt-trend',
      kind: reduced ? 'strength' : 'concern',
      severity: reduced ? 'low' : Math.abs(change) > 0.25 ? 'high' : 'medium',
      title: `Total debt ${reduced ? 'reduced' : 'increased'} ${pct(Math.abs(change))} year on year`,
      detail: `Borrowings moved from ${money(prior)} to ${money(current)}, a ${reduced ? 'reduction' : 'rise'} of ${money(Math.abs(current - prior))}. ${
        reduced
          ? 'Deleveraging of this size materially lowers interest cost and refinancing exposure.'
          : 'The additional borrowing needs to be earning a return above its cost of funds.'
      }`,
      evidence: ['totalDebt', 'debtToEquity'],
    };
  },

  (ctx) => {
    if (!ctx.previous) return null;
    const current = ctx.value('totalAssets', ctx.latest);
    const prior = ctx.value('totalAssets', ctx.previous);
    const change = delta(current, prior);
    if (current === null || prior === null || change === null) return null;
    if (Math.abs(change) < 0.05) return null;

    return {
      id: 'balance-sheet-size-trend',
      kind: 'trend',
      severity: Math.abs(change) > 0.2 ? 'medium' : 'low',
      title: `Balance sheet ${change < 0 ? 'contracted' : 'expanded'} ${pct(Math.abs(change))}`,
      detail: `Total assets moved from ${money(prior)} to ${money(current)}. ${
        change < 0
          ? 'A contraction alongside falling debt is consistent with a deliberate unwind of working capital rather than distress - worth reading against the revenue trend.'
          : 'Growth in the asset base should be checked against the funding mix that paid for it.'
      }`,
      evidence: ['totalAssets'],
    };
  },

  (ctx) => {
    if (!ctx.previous) return null;
    const out: Insight[] = [];
    const movers: { concept: ConceptId; label: string }[] = [
      { concept: 'inventories', label: 'Inventories' },
      { concept: 'tradeReceivables', label: 'Trade receivables' },
      { concept: 'cashAndCashEquivalents', label: 'Cash & cash equivalents' },
      { concept: 'tradePayables', label: 'Trade payables' },
    ];

    for (const mover of movers) {
      const current = ctx.value(mover.concept, ctx.latest);
      const prior = ctx.value(mover.concept, ctx.previous);
      const change = delta(current, prior);
      if (current === null || prior === null || change === null) continue;
      if (Math.abs(change) < 0.2) continue;

      const worrying = mover.concept === 'cashAndCashEquivalents' && change < -0.4;
      out.push({
        id: `mover-${mover.concept}`,
        kind: worrying ? 'concern' : 'trend',
        severity: worrying ? 'medium' : 'low',
        title: `${mover.label} ${change < 0 ? 'fell' : 'rose'} ${pct(Math.abs(change))}`,
        detail: `${mover.label} moved from ${money(prior)} to ${money(current)}.${
          worrying
            ? ' A drawdown of this size leaves a thinner buffer for unexpected calls on cash.'
            : ''
        }`,
        evidence: [mover.concept],
      });
    }
    return out;
  },

  /* ---------------------------- solvency ------------------------------- */
  (ctx) => {
    const cover = ctx.metricValue('assetToLiability', ctx.latest);
    if (cover === null) return null;
    const assets = ctx.value('totalAssets', ctx.latest);
    const liabilities = ctx.value('totalLiabilities', ctx.latest);

    if (cover >= 1.3) {
      return {
        id: 'solvency-cushion',
        kind: 'strength',
        severity: 'low',
        title: `Assets cover liabilities ${times(cover)} over`,
        detail: `${assets !== null ? money(assets) : ''} of assets stands against ${liabilities !== null ? money(liabilities) : ''} of liabilities, leaving a solvency cushion of ${
          assets !== null && liabilities !== null ? money(assets - liabilities) : 'n/a'
        }.`,
        evidence: ['assetToLiability', 'netWorth'],
      };
    }
    if (cover >= 1) {
      return {
        id: 'solvency-thin',
        kind: 'observation',
        severity: 'medium',
        title: `Asset cover of ${times(cover)} is modest`,
        detail: 'Assets exceed liabilities, but the surplus is small relative to the size of the balance sheet.',
        evidence: ['assetToLiability'],
      };
    }
    return {
      id: 'solvency-negative',
      kind: 'concern',
      severity: 'high',
      title: 'Liabilities exceed total assets',
      detail: 'Net worth is negative on the figures extracted. Verify the extraction before acting on this.',
      evidence: ['assetToLiability', 'netWorth'],
    };
  },

  /* ------------------------ reserves / net worth ----------------------- */
  (ctx) => {
    if (!ctx.previous) return null;
    const current = ctx.value('reservesAndSurplus', ctx.latest);
    const prior = ctx.value('reservesAndSurplus', ctx.previous);
    if (current === null || prior === null) return null;
    const change = current - prior;
    if (Math.abs(change) < Math.abs(prior) * 0.01) return null;

    return {
      id: 'reserves-trend',
      kind: change > 0 ? 'strength' : 'concern',
      severity: change > 0 ? 'low' : 'medium',
      title: `Reserves ${change > 0 ? 'grew' : 'declined'} by ${money(Math.abs(change))}`,
      detail:
        change > 0
          ? `Accumulated reserves rose from ${money(prior)} to ${money(current)}, indicating retained profit over the year rather than a drawdown.`
          : `Accumulated reserves fell from ${money(prior)} to ${money(current)}, which points to a loss or a distribution during the year.`,
      evidence: ['reservesAndSurplus', 'netWorth'],
    };
  },

  /* --------------------- extraction quality flags ---------------------- */
  (ctx) => {
    const check = ctx.statement.balanceChecks.find((c) => c.periodId === ctx.latest);
    if (!check || check.status === 'balanced') return null;
    if (check.status === 'insufficient-data') {
      return {
        id: 'identity-unverified',
        kind: 'observation',
        severity: 'medium',
        title: 'Accounting identity could not be verified',
        detail: 'Not enough line items were recognised to confirm that assets equal equity plus liabilities.',
        evidence: [],
      };
    }
    return {
      id: 'identity-variance',
      kind: 'concern',
      severity: check.status === 'imbalanced' ? 'high' : 'medium',
      title: 'Extracted figures do not fully balance',
      detail: `${check.message} The ratios above are computed from what was read, so treat them as indicative until the source figures are confirmed.`,
      evidence: [],
    };
  },
];

const KIND_WEIGHT: Record<Insight['kind'], number> = {
  concern: 0,
  strength: 1,
  trend: 2,
  observation: 3,
};
const SEVERITY_WEIGHT: Record<Insight['severity'], number> = { high: 0, medium: 1, low: 2 };

export function generateInsights(statement: Statement, metrics: Metric[]): Insight[] {
  const periods = statement.periods;
  if (periods.length === 0) return [];

  const index = indexValues(statement.lineItems);
  const metricMap = new Map(metrics.map((m) => [m.id, m]));

  const ctx: Context = {
    statement,
    metrics: metricMap,
    latest: periods[0]!.id,
    previous: periods[1]?.id ?? null,
    value: (concept, periodId) => valueOf(index, concept, periodId),
    metricValue: (id, periodId) =>
      metricMap.get(id)?.values.find((v) => v.periodId === periodId)?.value ?? null,
  };

  const insights: Insight[] = [];
  for (const rule of RULES) {
    let produced: Insight | Insight[] | null = null;
    try {
      produced = rule(ctx);
    } catch {
      // A single misbehaving rule must not take the whole report down.
      continue;
    }
    if (!produced) continue;
    for (const insight of Array.isArray(produced) ? produced : [produced]) insights.push(insight);
  }

  return insights.sort((a, b) => {
    const severity = SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity];
    if (severity !== 0) return severity;
    return KIND_WEIGHT[a.kind] - KIND_WEIGHT[b.kind];
  });
}

/** A short paragraph used when no LLM narrative is available. */
export function buildSummary(statement: Statement, metrics: Metric[], insights: Insight[]): string {
  const periods = statement.periods;
  if (periods.length === 0 || statement.lineItems.length === 0) {
    return 'Not enough data was extracted to summarise this balance sheet.';
  }

  const index = indexValues(statement.lineItems);
  const latest = periods[0]!;
  const name = statement.company.name ?? 'The company';
  const assets = valueOf(index, 'totalAssets', latest.id);
  const equity = valueOf(index, 'totalEquity', latest.id);
  const metricValue = (id: string) =>
    metrics.find((m) => m.id === id)?.values.find((v) => v.periodId === latest.id)?.value ?? null;

  const parts: string[] = [];
  if (assets !== null) {
    parts.push(
      `${name} carried a balance sheet of ${money(assets)} at ${latest.label}${
        equity !== null ? `, of which ${money(equity)} is shareholder funds` : ''
      }.`,
    );
  }

  const currentRatio = metricValue('currentRatio');
  const de = metricValue('debtToEquity');
  if (currentRatio !== null && de !== null) {
    parts.push(
      `Liquidity sits at a current ratio of ${times(currentRatio)} against leverage of ${times(de)} debt to equity.`,
    );
  }

  // Titles are already noun phrases ("Comfortable current ratio at 2.65x"), so
  // they are introduced with a colon rather than folded into a sentence.
  const strengths = insights.filter((i) => i.kind === 'strength');
  const concerns = insights.filter((i) => i.kind === 'concern');
  if (strengths[0]) parts.push(`Clearest strength: ${lowerFirst(strengths[0].title)}.`);
  if (concerns[0]) parts.push(`Main watch-point: ${lowerFirst(concerns[0].title)}.`);

  return parts.join(' ');
}

/** Lower-case the first letter unless the word is an acronym or a figure. */
function lowerFirst(text: string): string {
  if (/^[A-Z]{2,}/.test(text) || /^[^A-Za-z]/.test(text)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}
