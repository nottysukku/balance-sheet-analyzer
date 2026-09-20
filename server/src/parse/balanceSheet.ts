import type {
  CompanyInfo,
  ConceptId,
  ConceptSection,
  ExtractedValue,
  ExtractionWarning,
  LineItem,
  Period,
  Statement,
} from '../domain/types.js';
import type { DocPage, SourceDocument } from '../ingest/types.js';
import { alignRows, type AlignedRow } from './align.js';
import { classifyLabel, detectSectionHeader, normalizeLabel } from './classify.js';
import { detectCurrency, detectPeriods, detectUnitScale, type PeriodDetection } from './periods.js';
import { assignCells, buildRows, detectValueColumns, type Row, type ValueColumn } from './rows.js';
import { CONCEPTS_BY_ID, CONCEPT_ORDER } from './taxonomy.js';

/**
 * Turns an ingested document into a structured balance sheet.
 *
 * A filing is not just the balance sheet - the sample contains a P&L, fifteen
 * pages of notes and an auditor's report. So the first job is to find the
 * right page, and the second is to read only the rows on it that are real
 * line items.
 */

export interface ParsedStatement {
  statement: Omit<Statement, 'balanceChecks'>;
  warnings: ExtractionWarning[];
  /** Mean confidence across everything we extracted. */
  confidence: number;
  /**
   * Rows carrying figures that no concept matched, kept for the LLM assist.
   * Each figure carries its own period id - relying on column position would
   * break on any statement that prints the older year first.
   */
  unmappedRows: {
    label: string;
    values: { periodId: string; value: number }[];
    page: number;
  }[];
  pageIndex: number;
}

interface PreparedPage {
  page: DocPage;
  rows: Row[];
  columns: ValueColumn[];
  text: string;
  score: number;
  conceptHits: number;
}

/** Words that mark a page as the balance sheet rather than a note schedule. */
const TITLE_PATTERNS = [
  /balance\s*sheet/i,
  /statement\s+of\s+financial\s+position/i,
];

const NOTE_PAGE_PATTERNS = [
  /statement\s+of\s+profit\s+and\s+loss/i,
  /cash\s*flow\s*statement/i,
  /notes?\s+forming\s+(?:an?\s+)?(?:integral\s+)?part/i,
];

/**
 * Flatten a page to a single string. Tokens arrive in the PDF's internal draw
 * order, which interleaves captions with figures, so the text is rebuilt from
 * reconstructed rows instead - otherwise header regexes match across columns
 * and pick up fragments of the wrong line.
 */
function rowsText(rows: Row[]): string {
  return rows
    .map((row) => row.tokens.map((t) => t.text).join(' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Prepare geometry for a page and score how much it looks like a balance sheet. */
function preparePage(page: DocPage): PreparedPage {
  const rows = buildRows(page);
  const columns = detectValueColumns(rows, page.width);
  assignCells(rows, columns, page.width);
  const text = rowsText(rows);

  let conceptHits = 0;
  let section: ConceptSection | null = null;
  const seen = new Set<ConceptId>();

  for (const row of rows) {
    const header = detectSectionHeader(row.label);
    if (header) section = header;
    const hit = classifyLabel(row.label, { section });
    if (hit && !seen.has(hit.concept.id)) {
      seen.add(hit.concept.id);
      conceptHits += 1;
    }
  }

  let score = conceptHits * 2;
  if (TITLE_PATTERNS.some((p) => p.test(text))) score += 12;
  if (NOTE_PAGE_PATTERNS.some((p) => p.test(text))) score -= 10;
  // A balance sheet has both halves of the accounting identity on it.
  const hasAssetSide = [...seen].some((id) => CONCEPTS_BY_ID.get(id)?.section === 'assets');
  const hasClaimSide = [...seen].some((id) => {
    const s = CONCEPTS_BY_ID.get(id)?.section;
    return s === 'liabilities' || s === 'equity';
  });
  if (hasAssetSide && hasClaimSide) score += 8;
  if (columns.length === 0) score -= 6;

  return { page, rows, columns, text, score, conceptHits };
}

function extractCompanyInfo(chosen: PreparedPage): CompanyInfo {
  // Only the top of the statement page carries letterhead details; reading the
  // whole document would pull captions out of the notes.
  const header = rowsText(chosen.rows.slice(0, 10));

  // Company name: the first substantial line of the balance sheet page, which
  // is where the letterhead sits.
  let name: string | undefined;
  for (const row of chosen.rows.slice(0, 6)) {
    const text = row.tokens.map((t) => t.text).join(' ').trim();
    if (text.length < 4 || text.length > 90) continue;
    if (/^\d/.test(text)) continue;
    if (/regd|office|cin\b|address/i.test(text)) continue;
    name = text.replace(/\s+/g, ' ');
    break;
  }
  // Scans mangle the trailing "LIMITED"; normalise the common cases.
  if (name) name = name.replace(/\bLIMITE[I1lD)]+\)?/i, 'LIMITED').replace(/\s+/g, ' ').trim();

  const cinMatch = header.match(/CIN\s*[:\-]?\s*([A-Za-z0-9 ]{15,32})/i);
  const cin = cinMatch?.[1]?.replace(/\s+/g, '').toUpperCase();

  const addressMatch = header.match(/Reg[dt]?\.?\s*Off?i?ce?\s*[:\-]?\s*([^\n]{10,140})/i);
  const address = addressMatch?.[1]?.replace(/\s+/g, ' ').trim();

  const titleMatch = chosen.text.match(/^.*BALANCE\s*SHEET.*$/im);

  const units = detectUnitScale(header);
  return {
    name,
    cin: cin && cin.length >= 15 ? cin : undefined,
    address,
    statementTitle: titleMatch?.[0]?.replace(/\s+/g, ' ').trim().slice(0, 70),
    currency: detectCurrency(header),
    unitScale: units.scale,
    unitLabel: units.label,
  };
}

/** Rows that are obviously not line items, regardless of what they match. */
function isNoiseRow(row: Row): boolean {
  const normalized = normalizeLabel(row.label);
  if (normalized.length < 3) return true;
  if (normalized.length > 110) return true; // policy prose
  if (/^(for|place|dated?|din|udin|membership|firm|partner|director|chartered)\b/i.test(normalized)) {
    return true;
  }
  // The scan mangles "significant" into "tcant", so match on the tail.
  if (/accounting polic/i.test(normalized)) return true;
  if (/^see accompanying/i.test(normalized)) return true;
  if (/integral part of the financial statement/i.test(normalized)) return true;
  return false;
}

interface Collected {
  concept: ConceptId;
  label: string;
  values: Map<string, ExtractedValue>;
  score: number;
}

function collectFromPage(
  prepared: PreparedPage,
  detection: PeriodDetection,
  collected: Map<ConceptId, Collected>,
  unmapped: ParsedStatement['unmappedRows'],
): void {
  const aligned: AlignedRow[] = alignRows(prepared.rows);
  let section: ConceptSection | null = null;

  for (const entry of aligned) {
    const row = entry.labelRow;

    const header = detectSectionHeader(row.label);
    if (header) {
      section = header;
      continue;
    }
    if (isNoiseRow(row)) continue;

    const hit = classifyLabel(row.label, { section });

    if (!hit) {
      if (entry.cells.length > 0) {
        const values = entry.cells
          .map((cell) => {
            const periodId = detection.columnToPeriod.get(cell.columnIndex);
            return periodId ? { periodId, value: cell.amount.value } : null;
          })
          .filter((v): v is { periodId: string; value: number } => v !== null);
        if (values.length > 0) unmapped.push({ label: row.label, values, page: row.page });
      }
      continue;
    }
    if (entry.cells.length === 0) continue;

    // Combined score: how sure we are of the label AND of the row pairing.
    const rowScore = hit.score * 0.55 + entry.confidence * 0.45;
    const existing = collected.get(hit.concept.id);
    if (existing && existing.score >= rowScore) continue;

    const values = new Map<string, ExtractedValue>();
    for (const cell of entry.cells) {
      const periodId = detection.columnToPeriod.get(cell.columnIndex);
      if (!periodId) continue;
      values.set(periodId, {
        value: cell.amount.value,
        origin: 'extracted',
        confidence: Math.max(0.15, Math.min(1, rowScore * cell.amount.confidence)),
        page: row.page,
        sourceLabel: row.label,
        rawText: cell.amount.raw,
        repaired: cell.amount.repaired,
      });
    }
    if (values.size === 0) continue;

    collected.set(hit.concept.id, {
      concept: hit.concept.id,
      label: row.label.replace(/\s+/g, ' ').trim(),
      values,
      score: rowScore,
    });
  }
}

export function parseBalanceSheet(document: SourceDocument): ParsedStatement {
  const warnings: ExtractionWarning[] = [];

  if (document.pages.length === 0) {
    throw Object.assign(new Error('No pages found'), { code: 'EMPTY_DOCUMENT' });
  }

  const prepared = document.pages.map(preparePage);
  const ranked = [...prepared].sort((a, b) => b.score - a.score);
  const primary = ranked[0]!;

  if (primary.conceptHits < 3) {
    warnings.push({
      code: 'LOW_CONCEPT_MATCH',
      severity: 'warning',
      message:
        'Few recognisable balance-sheet captions were found. The figures below may be incomplete.',
    });
  }

  // Some filings split the statement across two pages (claims on one, assets
  // on the next). Pull in a runner-up page when it clearly continues the
  // statement and shares the same column geometry.
  const pagesToRead: PreparedPage[] = [primary];
  const runnerUp = ranked[1];
  if (
    runnerUp &&
    runnerUp.conceptHits >= 3 &&
    Math.abs(runnerUp.page.index - primary.page.index) === 1 &&
    runnerUp.columns.length === primary.columns.length &&
    runnerUp.score > primary.score * 0.45 &&
    !NOTE_PAGE_PATTERNS.some((p) => p.test(runnerUp.text))
  ) {
    pagesToRead.push(runnerUp);
  }
  pagesToRead.sort((a, b) => a.page.index - b.page.index);

  const detection = detectPeriods(primary.rows, primary.columns);
  if (detection.periods.length === 0) {
    warnings.push({
      code: 'NO_VALUE_COLUMNS',
      severity: 'error',
      message: 'No numeric columns could be located in this document.',
    });
  } else if (detection.inferred) {
    warnings.push({
      code: 'PERIOD_LABELS_INFERRED',
      severity: 'info',
      message:
        'Column headings did not contain a readable year, so periods are labelled by position.',
    });
  }

  const collected = new Map<ConceptId, Collected>();
  const unmappedRows: ParsedStatement['unmappedRows'] = [];
  for (const page of pagesToRead) {
    collectFromPage(page, detection, collected, unmappedRows);
  }

  const lineItems: LineItem[] = [];
  for (const conceptId of CONCEPT_ORDER) {
    const entry = collected.get(conceptId);
    if (!entry) continue;
    const definition = CONCEPTS_BY_ID.get(conceptId)!;
    lineItems.push({
      concept: conceptId,
      label: definition.label,
      section: definition.section,
      group: definition.group,
      isTotal: definition.isTotal,
      values: Object.fromEntries(entry.values),
    });
  }

  const periods: Period[] = [...detection.periods].sort((a, b) => b.order - a.order);
  const company = extractCompanyInfo(primary);

  // Figures stated in lakhs/crores are scaled to absolute rupees so every
  // downstream calculation works in one unit.
  const scale = company.unitScale ?? 1;
  if (scale !== 1) {
    for (const item of lineItems) {
      for (const value of Object.values(item.values)) value.value *= scale;
    }
    warnings.push({
      code: 'UNIT_SCALED',
      severity: 'info',
      message: `Figures were stated in ${company.unitLabel?.toLowerCase()}s and have been converted to absolute ${company.currency ?? 'INR'}.`,
    });
  }

  if (lineItems.length === 0) {
    warnings.push({
      code: 'NO_LINE_ITEMS',
      severity: 'error',
      message:
        'No balance-sheet line items could be read. If this is a scanned image without a text layer, run OCR on it first.',
    });
  }

  const allValues = lineItems.flatMap((item) => Object.values(item.values));
  const confidence =
    allValues.length === 0
      ? 0
      : allValues.reduce((sum, v) => sum + v.confidence, 0) / allValues.length;

  return {
    statement: { company, periods, lineItems },
    warnings,
    confidence,
    unmappedRows,
    pageIndex: primary.page.index,
  };
}
