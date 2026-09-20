import type {
  BalanceCheck,
  ConceptId,
  ExtractedValue,
  LineItem,
  Period,
  Statement,
} from '../domain/types.js';
import { CONCEPTS_BY_ID, CONCEPT_ORDER } from '../parse/taxonomy.js';

/**
 * Fills in the roll-up rows and runs the accounting identity check.
 *
 * Statements print their subtotals, but a scan loses them often enough that
 * relying on the printed figure is not an option - in the reference document
 * the grand total row survives as `1,r7,68"77.414`. So every total is computed
 * from its components, and a printed total is used only when it agrees with
 * the computed one (in which case it is a useful confirmation) or when the
 * components are missing entirely.
 */

/** Which concepts add up into each roll-up. */
const COMPOSITION: Partial<Record<ConceptId, ConceptId[]>> = {
  totalEquity: ['shareCapital', 'reservesAndSurplus'],
  totalNonCurrentLiabilities: [
    'longTermBorrowings',
    'deferredTaxLiabilities',
    'longTermProvisions',
    'otherNonCurrentLiabilities',
  ],
  totalCurrentLiabilities: [
    'shortTermBorrowings',
    'tradePayables',
    'otherCurrentLiabilities',
    'shortTermProvisions',
  ],
  totalLiabilities: ['totalNonCurrentLiabilities', 'totalCurrentLiabilities'],
  totalNonCurrentAssets: [
    'propertyPlantAndEquipment',
    'intangibleAssets',
    'nonCurrentInvestments',
    'longTermLoansAndAdvances',
    'otherNonCurrentAssets',
  ],
  totalCurrentAssets: [
    'currentInvestments',
    'inventories',
    'tradeReceivables',
    'cashAndCashEquivalents',
    'shortTermLoansAndAdvances',
    'otherCurrentAssets',
  ],
  totalAssets: ['totalNonCurrentAssets', 'totalCurrentAssets'],
  totalEquityAndLiabilities: ['totalEquity', 'totalLiabilities'],
};

/** Order matters: a roll-up may depend on one computed earlier. */
const DERIVATION_ORDER: ConceptId[] = [
  'totalEquity',
  'totalNonCurrentLiabilities',
  'totalCurrentLiabilities',
  'totalLiabilities',
  'totalNonCurrentAssets',
  'totalCurrentAssets',
  'totalAssets',
  'totalEquityAndLiabilities',
];

/** A printed total this far from the computed one is treated as misread. */
const TOTAL_AGREEMENT_TOLERANCE = 0.02;

export type ValueIndex = Map<ConceptId, Map<string, ExtractedValue>>;

export function indexValues(lineItems: LineItem[]): ValueIndex {
  const index: ValueIndex = new Map();
  for (const item of lineItems) {
    index.set(item.concept, new Map(Object.entries(item.values)));
  }
  return index;
}

export function valueOf(index: ValueIndex, concept: ConceptId, periodId: string): number | null {
  const entry = index.get(concept)?.get(periodId);
  return entry ? entry.value : null;
}

/**
 * Compute every missing roll-up. Returns the augmented line-item list, sorted
 * into presentation order.
 */
export function deriveTotals(lineItems: LineItem[], periods: Period[]): LineItem[] {
  const index = indexValues(lineItems);

  for (const target of DERIVATION_ORDER) {
    const parts = COMPOSITION[target];
    if (!parts) continue;

    const existing = index.get(target) ?? new Map<string, ExtractedValue>();

    for (const period of periods) {
      const contributions: ExtractedValue[] = [];
      for (const part of parts) {
        const entry = index.get(part)?.get(period.id);
        if (entry) contributions.push(entry);
      }
      if (contributions.length === 0) continue;

      const sum = contributions.reduce((total, entry) => total + entry.value, 0);
      // Confidence of a sum is no better than its weakest input.
      const confidence = Math.min(...contributions.map((entry) => entry.confidence)) * 0.97;

      const printed = existing.get(period.id);
      if (printed && printed.origin === 'extracted') {
        const scale = Math.max(Math.abs(printed.value), Math.abs(sum), 1);
        const agrees = Math.abs(printed.value - sum) / scale <= TOTAL_AGREEMENT_TOLERANCE;
        if (agrees) {
          // Two independent readings agree - that is worth extra confidence.
          existing.set(period.id, {
            ...printed,
            confidence: Math.min(1, printed.confidence * 1.1),
          });
          continue;
        }
        // They disagree: trust the components, which are individually checkable.
        existing.set(period.id, {
          value: sum,
          origin: 'derived',
          confidence: confidence * 0.85,
          sourceLabel: `Sum of ${contributions.length} line items (printed total differed)`,
        });
        continue;
      }

      existing.set(period.id, {
        value: sum,
        origin: 'derived',
        confidence,
        sourceLabel: `Sum of ${contributions.length} line items`,
      });
    }

    if (existing.size > 0) index.set(target, existing);
  }

  const result: LineItem[] = [];
  for (const conceptId of CONCEPT_ORDER) {
    const values = index.get(conceptId);
    if (!values || values.size === 0) continue;
    const definition = CONCEPTS_BY_ID.get(conceptId)!;
    result.push({
      concept: conceptId,
      label: definition.label,
      section: definition.section,
      group: definition.group,
      isTotal: definition.isTotal,
      values: Object.fromEntries(values),
    });
  }
  return result;
}

/**
 * Assets = Equity + Liabilities, per period.
 *
 * The tolerance is relative, which matters for scanned input: a single misread
 * digit in the reference document shifts one side by 60,000 rupees against a
 * 117 crore balance sheet. That is 0.005% - an OCR artefact, not a real
 * imbalance, and reporting it as one would be misleading. The absolute
 * difference is always reported so the reader can judge for themselves.
 */
export function buildBalanceChecks(lineItems: LineItem[], periods: Period[]): BalanceCheck[] {
  const index = indexValues(lineItems);

  return periods.map((period) => {
    const assets = valueOf(index, 'totalAssets', period.id);
    const claims = valueOf(index, 'totalEquityAndLiabilities', period.id);

    if (assets === null || claims === null) {
      return {
        periodId: period.id,
        totalAssets: assets,
        totalEquityAndLiabilities: claims,
        difference: null,
        relativeDifference: null,
        status: 'insufficient-data',
        message: 'Not enough line items were read to verify the accounting identity.',
      } satisfies BalanceCheck;
    }

    const difference = assets - claims;
    const scale = Math.max(Math.abs(assets), Math.abs(claims), 1);
    const relative = Math.abs(difference) / scale;

    let status: BalanceCheck['status'];
    let message: string;
    if (relative <= 0.001) {
      status = 'balanced';
      message =
        difference === 0
          ? 'Assets equal equity plus liabilities exactly.'
          : `Assets and claims agree to within ${(relative * 100).toFixed(3)}% - consistent with rounding or a single misread digit.`;
    } else if (relative <= 0.01) {
      status = 'minor-variance';
      message = `Assets and claims differ by ${(relative * 100).toFixed(2)}%. Likely a line item that was not read, or an extraction error.`;
    } else {
      status = 'imbalanced';
      message = `Assets and claims differ by ${(relative * 100).toFixed(1)}%. Some line items were probably missed - treat the ratios below with caution.`;
    }

    return {
      periodId: period.id,
      totalAssets: assets,
      totalEquityAndLiabilities: claims,
      difference,
      relativeDifference: relative,
      status,
      message,
    } satisfies BalanceCheck;
  });
}

export function finaliseStatement(
  base: Omit<Statement, 'balanceChecks'>,
): Statement {
  const lineItems = deriveTotals(base.lineItems, base.periods);
  return {
    ...base,
    lineItems,
    balanceChecks: buildBalanceChecks(lineItems, base.periods),
  };
}
