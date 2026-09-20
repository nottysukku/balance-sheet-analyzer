import type { Period } from '../domain/types.js';
import type { Row, ValueColumn } from './rows.js';

/**
 * Works out what each value column represents.
 *
 * Column headers are read from the raw tokens rather than from the row's label
 * text, because a header like "31st Mar 2024" often straddles the boundary
 * between the label region and the value region.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const YEAR_RE = /\b(19[5-9]\d|20[0-4]\d)\b/;

/** Pull a 4-digit year out of header text, tolerating OCR letter swaps. */
function extractYear(text: string): number | null {
  const repaired = text
    .replace(/[lI|!]/g, '1')
    .replace(/[oOQ]/g, '0')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8');
  const match = repaired.match(YEAR_RE);
  return match ? Number(match[1]) : null;
}

function extractMonth(text: string): number | null {
  const lower = text.toLowerCase();
  for (const [name, index] of Object.entries(MONTHS)) {
    if (lower.includes(name)) return index;
  }
  return null;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Tidy a scanned header into something presentable. */
function cleanHeaderLabel(text: string, year: number | null): string {
  const cleaned = text
    .replace(/\(?amount\s*in\s*[^)]*\)?/gi, ' ')
    .replace(/\(rs\.?\)/gi, ' ')
    .replace(/[^\w\s,'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length >= 6 && cleaned.length <= 40 && /\d/.test(cleaned)) return cleaned;
  return year ? `FY ${year}` : cleaned || 'Period';
}

export interface PeriodDetection {
  periods: Period[];
  /** columnIndex -> periodId */
  columnToPeriod: Map<number, string>;
  /** True when we had to fall back to positional guessing. */
  inferred: boolean;
}

/**
 * Identify the reporting period behind each value column.
 *
 * Header rows are the rows above the first row carrying figures. Tokens on
 * those rows are bucketed into columns by x overlap, and a year is pulled from
 * each bucket.
 */
export function detectPeriods(rows: Row[], columns: ValueColumn[]): PeriodDetection {
  if (columns.length === 0) {
    return { periods: [], columnToPeriod: new Map(), inferred: true };
  }

  const firstValueRowIndex = rows.findIndex((r) => r.cells.length > 0);
  const headerRows = firstValueRowIndex > 0 ? rows.slice(0, firstValueRowIndex) : rows.slice(0, 12);

  // Widen each column a little: headers are often centred over their figures
  // rather than right-aligned with them.
  const spans = columns.map((column, index) => {
    const previous = columns[index - 1];
    const leftBound = previous
      ? (previous.rightEdge + column.left) / 2
      : column.left - (column.right - column.left) * 0.45 - 12;
    const next = columns[index + 1];
    const rightBound = next ? (column.rightEdge + next.left) / 2 : column.right + 18;
    return { index: column.index, left: leftBound, right: rightBound };
  });

  const texts = new Map<number, string[]>();
  for (const row of headerRows) {
    for (const token of row.tokens) {
      const centre = token.x + token.width / 2;
      const span = spans.find((s) => centre >= s.left && centre <= s.right);
      if (!span) continue;
      const bucket = texts.get(span.index) ?? [];
      bucket.push(token.text);
      texts.set(span.index, bucket);
    }
  }

  interface Draft { columnIndex: number; text: string; year: number | null; month: number | null }
  const drafts: Draft[] = columns.map((column) => {
    const text = (texts.get(column.index) ?? []).join(' ').replace(/\s+/g, ' ').trim();
    return {
      columnIndex: column.index,
      text,
      year: extractYear(text),
      month: extractMonth(text),
    };
  });

  const anyYear = drafts.some((d) => d.year !== null);
  const periods: Period[] = [];
  const columnToPeriod = new Map<number, string>();
  const usedIds = new Set<string>();

  drafts.forEach((draft, position) => {
    let id: string;
    if (draft.year !== null) {
      id = `FY${draft.year}`;
    } else {
      id = `COL${position + 1}`;
    }
    // Guard against two columns resolving to the same label.
    let unique = id;
    let suffix = 2;
    while (usedIds.has(unique)) unique = `${id}-${suffix++}`;
    usedIds.add(unique);

    const month = draft.month ?? (draft.year !== null ? 3 : null);
    const endDate =
      draft.year !== null && month !== null
        ? `${draft.year}-${String(month).padStart(2, '0')}-${String(
            lastDayOfMonth(draft.year, month),
          ).padStart(2, '0')}`
        : undefined;

    periods.push({
      id: unique,
      label: cleanHeaderLabel(draft.text, draft.year),
      endDate,
      // Where we know the year, sort by it. Otherwise fall back to the Indian
      // convention that the current period is printed in the leftmost column.
      order: draft.year ?? drafts.length - position,
    });
    columnToPeriod.set(draft.columnIndex, unique);
  });

  return { periods, columnToPeriod, inferred: !anyYear };
}

/**
 * Units the figures are stated in, read from an "Amounts in lakhs" style note.
 *
 * A currency word often sits between "in" and the unit ("in USD thousands",
 * "in Rs. crores"), so one optional currency token is allowed in between.
 */
const CURRENCY_WORD = String.raw`(?:rs\.?|inr|usd|eur|gbp|₹|\$|€|£)`;
const unitPattern = (unit: string) =>
  new RegExp(String.raw`\bin\s+(?:${CURRENCY_WORD}\s*)?(?:${unit})\b`);

const UNIT_RULES: { pattern: RegExp; scale: number; label: string }[] = [
  { pattern: unitPattern('crores?|crs?'), scale: 1e7, label: 'Crore' },
  { pattern: unitPattern('lakhs?|lacs?'), scale: 1e5, label: 'Lakh' },
  { pattern: unitPattern('millions?|mns?'), scale: 1e6, label: 'Million' },
  { pattern: unitPattern(String.raw`thousands?|'?000s?`), scale: 1e3, label: 'Thousand' },
];

export function detectUnitScale(text: string): { scale: number; label: string } {
  const lower = text.toLowerCase();
  for (const rule of UNIT_RULES) {
    if (rule.pattern.test(lower)) return { scale: rule.scale, label: rule.label };
  }
  return { scale: 1, label: 'Absolute' };
}

/** Reporting currency, read from the document header. */
export function detectCurrency(text: string): string {
  const lower = text.toLowerCase();
  if (/₹|\binr\b|indian rupees?\b|\brs\.?\b/.test(lower)) return 'INR';
  if (/\busd\b|\bus dollars?\b|\$/.test(lower)) return 'USD';
  if (/\beur\b|\beuros?\b|€/.test(lower)) return 'EUR';
  if (/\bgbp\b|\bpounds?\b|£/.test(lower)) return 'GBP';
  return 'INR';
}
