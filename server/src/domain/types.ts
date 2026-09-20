/**
 * The contract between the extraction pipeline, the analysis engine and the UI.
 * Everything the API returns is assembled from these types.
 */

/** Canonical balance-sheet concepts the extractor knows how to recognise. */
export type ConceptId =
  // --- Equity ---
  | 'shareCapital'
  | 'reservesAndSurplus'
  | 'totalEquity'
  // --- Non-current liabilities ---
  | 'longTermBorrowings'
  | 'deferredTaxLiabilities'
  | 'longTermProvisions'
  | 'otherNonCurrentLiabilities'
  | 'totalNonCurrentLiabilities'
  // --- Current liabilities ---
  | 'shortTermBorrowings'
  | 'tradePayables'
  | 'otherCurrentLiabilities'
  | 'shortTermProvisions'
  | 'totalCurrentLiabilities'
  // --- Totals ---
  | 'totalLiabilities'
  | 'totalEquityAndLiabilities'
  // --- Non-current assets ---
  | 'propertyPlantAndEquipment'
  | 'intangibleAssets'
  | 'nonCurrentInvestments'
  | 'longTermLoansAndAdvances'
  | 'otherNonCurrentAssets'
  | 'totalNonCurrentAssets'
  // --- Current assets ---
  | 'currentInvestments'
  | 'inventories'
  | 'tradeReceivables'
  | 'cashAndCashEquivalents'
  | 'shortTermLoansAndAdvances'
  | 'otherCurrentAssets'
  | 'totalCurrentAssets'
  // --- Totals ---
  | 'totalAssets';

export type ConceptSection = 'equity' | 'liabilities' | 'assets';
export type ConceptGroup =
  | 'equity'
  | 'nonCurrentLiabilities'
  | 'currentLiabilities'
  | 'nonCurrentAssets'
  | 'currentAssets'
  | 'totals';

/** How a figure came to be in the result set. */
export type ValueOrigin =
  /** Read straight off the document. */
  | 'extracted'
  /** Summed/derived from other line items (e.g. total current assets). */
  | 'derived'
  /** Supplied by the Claude extraction assist when the parser found nothing. */
  | 'llm';

/** A single figure, with enough provenance to audit it back to the page. */
export interface ExtractedValue {
  value: number;
  origin: ValueOrigin;
  /** 0..1 – how sure the pipeline is that this number belongs to this concept. */
  confidence: number;
  /** 1-based page the figure was read from (PDF) or sheet index (Excel). */
  page?: number;
  /** The label text as it literally appeared in the document. */
  sourceLabel?: string;
  /** The number as it literally appeared, before normalisation. */
  rawText?: string;
  /** Set when OCR repair changed the digits we read. */
  repaired?: boolean;
}

/** One reporting period (a column in the balance sheet). */
export interface Period {
  /** Stable key used to index `LineItem.values`, e.g. "FY2024". */
  id: string;
  /** Human label as printed, e.g. "31st Mar 2024". */
  label: string;
  /** ISO date of the period end when we could parse one. */
  endDate?: string;
  /** Sort key – higher is more recent. */
  order: number;
}

export interface LineItem {
  concept: ConceptId;
  label: string;
  section: ConceptSection;
  group: ConceptGroup;
  /** True for roll-up rows (totals/subtotals) so the UI can style them. */
  isTotal: boolean;
  /** periodId -> value */
  values: Record<string, ExtractedValue>;
}

export interface CompanyInfo {
  name?: string;
  cin?: string;
  address?: string;
  statementTitle?: string;
  /** e.g. "INR". */
  currency?: string;
  /** Multiplier the printed figures are stated in (1, 1e5 for lakhs, 1e7 for crores). */
  unitScale?: number;
  unitLabel?: string;
}

/** The accounting identity check, per period. */
export interface BalanceCheck {
  periodId: string;
  totalAssets: number | null;
  totalEquityAndLiabilities: number | null;
  difference: number | null;
  /** |difference| / max(assets, L+E) */
  relativeDifference: number | null;
  status: 'balanced' | 'minor-variance' | 'imbalanced' | 'insufficient-data';
  message: string;
}

export interface Statement {
  company: CompanyInfo;
  periods: Period[];
  lineItems: LineItem[];
  balanceChecks: BalanceCheck[];
}

/* ------------------------------ analysis ------------------------------ */

export type MetricFormat = 'ratio' | 'currency' | 'percent' | 'times' | 'days';
export type MetricVerdict = 'strong' | 'healthy' | 'watch' | 'weak' | 'neutral';

export interface MetricValue {
  periodId: string;
  value: number | null;
  verdict: MetricVerdict;
  /** Human-readable numerator/denominator, e.g. "₹1.10 Cr ÷ ₹42.03 Cr". */
  workings?: string;
}

export interface Metric {
  id: string;
  label: string;
  /** One line on what the number means. */
  description: string;
  /** How the figure is computed, in plain words. */
  formula: string;
  format: MetricFormat;
  /** Whether a larger number is better – drives trend arrow colouring. */
  higherIsBetter: boolean | null;
  category: 'liquidity' | 'leverage' | 'structure' | 'efficiency';
  values: MetricValue[];
  /** Absolute change between the two most recent periods. */
  change: number | null;
  /** Relative change between the two most recent periods. */
  changePct: number | null;
}

export type InsightKind = 'strength' | 'concern' | 'trend' | 'observation';
export type InsightSeverity = 'high' | 'medium' | 'low';

export interface Insight {
  id: string;
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  detail: string;
  /** Metric ids / concept ids this was derived from – shown as chips. */
  evidence: string[];
}

export interface Analysis {
  metrics: Metric[];
  insights: Insight[];
  /** Short paragraph summarising the position. */
  summary: string;
  /** True when the summary/insights were written by Claude rather than the rule engine. */
  narrativeFromLlm: boolean;
}

/* ------------------------------- report ------------------------------- */

export interface ExtractionWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export interface SourceMeta {
  fileName: string;
  fileSize: number;
  format: 'pdf' | 'excel';
  pageCount?: number;
  sheetNames?: string[];
  /** Milliseconds spent in the pipeline. */
  durationMs: number;
  /** Whether the Claude assist ran, and for what. */
  llmAssist: { extraction: boolean; narrative: boolean; model?: string };
}

export interface AnalysisReport {
  source: SourceMeta;
  statement: Statement;
  analysis: Analysis;
  warnings: ExtractionWarning[];
  /** Overall 0..1 confidence in the extraction, for the UI banner. */
  extractionConfidence: number;
}
