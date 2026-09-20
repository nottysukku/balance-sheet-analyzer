import type { ConceptGroup, ConceptId, ConceptSection } from '../domain/types.js';

/**
 * The canonical chart of accounts the extractor maps every document label onto.
 *
 * Synonyms cover Schedule III (the Indian Companies Act format used by the
 * reference document) plus the IFRS/US-GAAP wording, so the same pipeline
 * reads an Indian filing and an international one. Terms are written without
 * spaces because matching happens on a de-spaced string - it is the only way
 * to recognise OCR output like "Shortterm borowings" as "short term
 * borrowings".
 */

export interface ConceptDefinition {
  id: ConceptId;
  label: string;
  section: ConceptSection;
  group: ConceptGroup;
  isTotal: boolean;
  /** Higher wins when two concepts both match a label. */
  specificity: number;
  /** De-spaced synonyms, most specific first. */
  synonyms: string[];
  /** If the label contains any of these (de-spaced), reject the match. */
  exclude?: string[];
  /** Only consider this concept while inside one of these document sections. */
  sections?: ConceptSection[];
}

const D = (d: ConceptDefinition): ConceptDefinition => d;

export const CONCEPTS: ConceptDefinition[] = [
  /* ------------------------------- equity ------------------------------- */
  D({
    id: 'shareCapital',
    label: 'Share Capital',
    section: 'equity',
    group: 'equity',
    isTotal: false,
    specificity: 3,
    synonyms: [
      'equitysharecapital', 'issuedsubscribedandpaidupcapital', 'paidupsharecapital',
      'sharecapital', 'capitalstock', 'commonstock', 'sharedcapital',
    ],
    exclude: ['reserve', 'workingcapital', 'capitalworkinprogress', 'capitalreserve'],
  }),
  D({
    id: 'reservesAndSurplus',
    label: 'Reserves & Surplus',
    section: 'equity',
    group: 'equity',
    isTotal: false,
    specificity: 3,
    synonyms: [
      'reservesandsurplus', 'retainedearnings', 'otherequity', 'accumulatedprofits',
      'profitandlossaccount', 'reserves', 'surplus',
    ],
    exclude: ['deficit'],
  }),
  D({
    id: 'totalEquity',
    label: 'Total Equity',
    section: 'equity',
    group: 'equity',
    isTotal: true,
    specificity: 5,
    synonyms: [
      'totalshareholdersfunds', 'totalshareholdersequity', 'shareholdersfunds',
      'shareholdersequity', 'totalstockholdersequity', 'totalequity', 'networth',
    ],
    exclude: ['liabilit', 'other'],
  }),

  /* ----------------------- non-current liabilities ---------------------- */
  D({
    id: 'longTermBorrowings',
    label: 'Long-term Borrowings',
    section: 'liabilities',
    group: 'nonCurrentLiabilities',
    isTotal: false,
    specificity: 4,
    synonyms: [
      'longtermborrowings', 'noncurrentborrowings', 'longtermdebt', 'longtermloans',
      'noncurrentfinancialliabilitiesborrowings', 'termloans', 'securedloans',
    ],
    // "term loans" is a legitimate caption for long-term debt, but it is also
    // a substring of "shor(t) term loans and advances" - an asset. The
    // advances exclusions keep the two apart.
    exclude: ['shortterm', 'currentportion', 'loansandadvances', 'advances'],
  }),
  D({
    id: 'deferredTaxLiabilities',
    label: 'Deferred Tax Liabilities (Net)',
    section: 'liabilities',
    group: 'nonCurrentLiabilities',
    isTotal: false,
    specificity: 4,
    synonyms: ['deferredtaxliabilities', 'deferredtaxliability', 'deferredtax'],
    exclude: ['asset'],
  }),
  D({
    id: 'longTermProvisions',
    label: 'Long-term Provisions',
    section: 'liabilities',
    group: 'nonCurrentLiabilities',
    isTotal: false,
    specificity: 4,
    synonyms: ['longtermprovisions', 'noncurrentprovisions'],
  }),
  D({
    id: 'otherNonCurrentLiabilities',
    label: 'Other Non-current Liabilities',
    section: 'liabilities',
    group: 'nonCurrentLiabilities',
    isTotal: false,
    specificity: 4,
    synonyms: ['otherlongtermliabilities', 'othernoncurrentliabilities'],
  }),
  D({
    id: 'totalNonCurrentLiabilities',
    label: 'Total Non-current Liabilities',
    section: 'liabilities',
    group: 'nonCurrentLiabilities',
    isTotal: true,
    specificity: 6,
    synonyms: ['totalnoncurrentliabilities', 'totallongtermliabilities'],
    exclude: ['other'],
  }),

  /* ------------------------- current liabilities ------------------------ */
  D({
    id: 'shortTermBorrowings',
    label: 'Short-term Borrowings',
    section: 'liabilities',
    group: 'currentLiabilities',
    isTotal: false,
    specificity: 4,
    synonyms: [
      'shorttermborrowings', 'currentborrowings', 'shorttermdebt', 'workingcapitalloan',
      'cashcredit', 'bankoverdraft', 'packingcredit',
      'currentmaturitiesoflongtermdebt', 'currentportionoflongtermdebt',
    ],
  }),
  D({
    id: 'tradePayables',
    label: 'Trade Payables',
    section: 'liabilities',
    group: 'currentLiabilities',
    isTotal: false,
    specificity: 4,
    synonyms: ['tradepayables', 'accountspayable', 'sundrycreditors', 'creditors', 'payables'],
    exclude: ['receivable', 'debtors'],
  }),
  D({
    id: 'otherCurrentLiabilities',
    label: 'Other Current Liabilities',
    section: 'liabilities',
    group: 'currentLiabilities',
    isTotal: false,
    specificity: 4,
    synonyms: ['othercurrentliabilities', 'otherfinancialliabilities'],
  }),
  D({
    id: 'shortTermProvisions',
    label: 'Short-term Provisions',
    section: 'liabilities',
    group: 'currentLiabilities',
    isTotal: false,
    specificity: 4,
    synonyms: ['shorttermprovisions', 'currentprovisions', 'provisions'],
    exclude: ['longterm', 'noncurrent'],
  }),
  D({
    id: 'totalCurrentLiabilities',
    label: 'Total Current Liabilities',
    section: 'liabilities',
    group: 'currentLiabilities',
    isTotal: true,
    specificity: 6,
    synonyms: ['totalcurrentliabilities'],
    exclude: ['other'],
  }),

  /* --------------------------- liability totals ------------------------- */
  D({
    id: 'totalLiabilities',
    label: 'Total Liabilities',
    section: 'liabilities',
    group: 'totals',
    isTotal: true,
    specificity: 5,
    synonyms: ['totalliabilities'],
    exclude: ['equity', 'shareholders', 'current', 'other'],
  }),
  D({
    id: 'totalEquityAndLiabilities',
    label: 'Total Equity & Liabilities',
    section: 'liabilities',
    group: 'totals',
    isTotal: true,
    specificity: 7,
    synonyms: [
      'totalequityandliabilities', 'totalliabilitiesandequity',
      'totalliabilitiesandshareholdersequity', 'totalequityliabilities',
    ],
    exclude: ['other'],
  }),

  /* -------------------------- non-current assets ------------------------ */
  D({
    id: 'propertyPlantAndEquipment',
    label: 'Property, Plant & Equipment',
    section: 'assets',
    group: 'nonCurrentAssets',
    isTotal: false,
    specificity: 4,
    synonyms: [
      'propertyplantandequipment', 'plantandequipment', 'tangibleassets', 'fixedassets',
      'netblock', 'propertyplantequipment',
    ],
    exclude: ['intangible'],
  }),
  D({
    id: 'intangibleAssets',
    label: 'Intangible Assets',
    section: 'assets',
    group: 'nonCurrentAssets',
    isTotal: false,
    specificity: 4,
    synonyms: ['intangibleassets', 'goodwill'],
  }),
  D({
    id: 'nonCurrentInvestments',
    label: 'Non-current Investments',
    section: 'assets',
    group: 'nonCurrentAssets',
    isTotal: false,
    specificity: 4,
    synonyms: ['noncurrentinvestments', 'longterminvestments'],
  }),
  D({
    id: 'longTermLoansAndAdvances',
    label: 'Long-term Loans & Advances',
    section: 'assets',
    group: 'nonCurrentAssets',
    isTotal: false,
    specificity: 4,
    synonyms: ['longtermloansandadvances', 'noncurrentloansandadvances'],
  }),
  D({
    id: 'otherNonCurrentAssets',
    label: 'Other Non-current Assets',
    section: 'assets',
    group: 'nonCurrentAssets',
    isTotal: false,
    specificity: 4,
    synonyms: ['othernoncurrentassets', 'capitalworkinprogress'],
  }),
  D({
    id: 'totalNonCurrentAssets',
    label: 'Total Non-current Assets',
    section: 'assets',
    group: 'nonCurrentAssets',
    isTotal: true,
    specificity: 6,
    synonyms: ['totalnoncurrentassets', 'totalfixedassets'],
    exclude: ['other'],
  }),

  /* ---------------------------- current assets -------------------------- */
  D({
    id: 'currentInvestments',
    label: 'Current Investments',
    section: 'assets',
    group: 'currentAssets',
    isTotal: false,
    specificity: 4,
    synonyms: ['currentinvestments', 'shortterminvestments', 'investments'],
    exclude: ['noncurrent', 'longterm'],
  }),
  D({
    id: 'inventories',
    label: 'Inventories',
    section: 'assets',
    group: 'currentAssets',
    isTotal: false,
    specificity: 4,
    synonyms: ['inventories', 'inventory', 'stockintrade', 'closingstock', 'stocks'],
  }),
  D({
    id: 'tradeReceivables',
    label: 'Trade Receivables',
    section: 'assets',
    group: 'currentAssets',
    isTotal: false,
    specificity: 4,
    synonyms: ['tradereceivables', 'accountsreceivable', 'sundrydebtors', 'debtors', 'receivables'],
    exclude: ['payable', 'creditors'],
  }),
  D({
    id: 'cashAndCashEquivalents',
    label: 'Cash & Cash Equivalents',
    section: 'assets',
    group: 'currentAssets',
    isTotal: false,
    specificity: 4,
    synonyms: [
      'cashandcashequivalents', 'cashandbankbalances', 'cashandbank', 'bankbalances',
      'cashatbankandinhand', 'cashinhand', 'cash',
    ],
    exclude: ['cashcredit', 'cashflow'],
  }),
  D({
    id: 'shortTermLoansAndAdvances',
    label: 'Short-term Loans & Advances',
    section: 'assets',
    group: 'currentAssets',
    isTotal: false,
    specificity: 4,
    synonyms: ['shorttermloansandadvances', 'currentloansandadvances', 'loansandadvances'],
  }),
  D({
    id: 'otherCurrentAssets',
    label: 'Other Current Assets',
    section: 'assets',
    group: 'currentAssets',
    isTotal: false,
    specificity: 4,
    synonyms: ['othercurrentassets', 'prepaidexpenses'],
  }),
  D({
    id: 'totalCurrentAssets',
    label: 'Total Current Assets',
    section: 'assets',
    group: 'currentAssets',
    isTotal: true,
    specificity: 6,
    synonyms: ['totalcurrentassets'],
    exclude: ['other'],
  }),
  D({
    id: 'totalAssets',
    label: 'Total Assets',
    section: 'assets',
    group: 'totals',
    isTotal: true,
    specificity: 6,
    synonyms: ['totalassets'],
    exclude: ['current', 'fixed', 'other'],
  }),
];

export const CONCEPTS_BY_ID = new Map<ConceptId, ConceptDefinition>(
  CONCEPTS.map((c) => [c.id, c]),
);

/** Display order for the statement table. */
export const CONCEPT_ORDER: ConceptId[] = [
  'shareCapital',
  'reservesAndSurplus',
  'totalEquity',
  'longTermBorrowings',
  'deferredTaxLiabilities',
  'longTermProvisions',
  'otherNonCurrentLiabilities',
  'totalNonCurrentLiabilities',
  'shortTermBorrowings',
  'tradePayables',
  'otherCurrentLiabilities',
  'shortTermProvisions',
  'totalCurrentLiabilities',
  'totalLiabilities',
  'totalEquityAndLiabilities',
  'propertyPlantAndEquipment',
  'intangibleAssets',
  'nonCurrentInvestments',
  'longTermLoansAndAdvances',
  'otherNonCurrentAssets',
  'totalNonCurrentAssets',
  'currentInvestments',
  'inventories',
  'tradeReceivables',
  'cashAndCashEquivalents',
  'shortTermLoansAndAdvances',
  'otherCurrentAssets',
  'totalCurrentAssets',
  'totalAssets',
];

export const GROUP_LABELS: Record<ConceptGroup, string> = {
  equity: 'Shareholders’ Funds',
  nonCurrentLiabilities: 'Non-current Liabilities',
  currentLiabilities: 'Current Liabilities',
  nonCurrentAssets: 'Non-current Assets',
  currentAssets: 'Current Assets',
  totals: 'Totals',
};
