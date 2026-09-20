import type { DocPage, Token } from '../ingest/types.js';
import { looksLikeAmount, parseAmount, stitchNumericTokens, type ParsedAmount } from './numbers.js';

/**
 * Turns a bag of positioned tokens into rows and value columns.
 *
 * Scanned statements do not give you a table structure, only glyph positions,
 * so the geometry has to be rebuilt:
 *
 *   1. Cluster tokens into rows by baseline, with a tolerance scaled to the
 *      document's own line height (a scan's baselines wobble by a few points).
 *   2. Find the value columns by clustering the RIGHT edges of numeric tokens -
 *      financial figures are right-aligned, so their right edges line up far
 *      more cleanly than their left edges do.
 *   3. Split each row into a label part (everything left of the first value
 *      column) and one cell per value column.
 */

export interface Cell {
  columnIndex: number;
  amount: ParsedAmount;
  x: number;
  width: number;
}

export interface Row {
  /** Representative baseline. */
  y: number;
  /** 1-based page this row came from. */
  page: number;
  /** Text left of the value columns, joined with single spaces. */
  label: string;
  /** Every token on the row, left to right. */
  tokens: Token[];
  /** Parsed amounts, one per detected value column (sparse). */
  cells: Cell[];
  /** Right edge of the label text - used to spot indentation. */
  labelEndX: number;
  /** Left edge of the label text - indentation depth. */
  labelStartX: number;
}

export interface ValueColumn {
  index: number;
  /** Centre of the cluster of right edges. */
  rightEdge: number;
  left: number;
  right: number;
  /** How many numeric tokens landed in this column. */
  support: number;
}

/**
 * Maximum horizontal gap that may be bridged when stitching a figure broken
 * across tokens. Scaled to the page so the same rule works for A4 points and
 * for the synthetic Excel grid, and capped so it can never bridge two columns.
 */
function stitchGapFor(pageWidth: number): number {
  return Math.min(10, Math.max(4, pageWidth * 0.012));
}

/**
 * Smallest bare integer a source-declared numeric cell may be and still count
 * as a money figure.
 *
 * `looksLikeAmount` rejects unseparated runs of four digits or fewer, because
 * in a PDF they are almost always a year or a note reference. A spreadsheet
 * cell is different: the source told us it holds a number, so `8600` is a
 * figure, not a year. The remaining risk is a "Note No." column of small
 * integers, which would otherwise be detected as a value column and shift the
 * label boundary - so small bare integers are still excluded.
 */
const MIN_BARE_NUMERIC_VALUE = 100;

/** Whether a stitched piece should be read as an amount. */
function isAmountCandidate(text: string, declaredNumeric: boolean): boolean {
  if (looksLikeAmount(text)) return true;
  if (!declaredNumeric) return false;
  const parsed = parseAmount(text);
  if (!parsed) return false;
  return Math.abs(parsed.value) >= MIN_BARE_NUMERIC_VALUE || !Number.isInteger(parsed.value);
}

/** Positioned tokens reduced to what the stitcher needs. */
function stitchable(tokens: Token[]) {
  return tokens.map((t) => ({
    text: t.text,
    x: t.x,
    width: t.width,
    numeric: t.numeric === true,
  }));
}

/** Median of a numeric list; 0 for an empty list. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Group tokens into rows by baseline proximity. Tolerance defaults to ~60% of
 * the median glyph height, which tracks the document's font size instead of
 * hard-coding points.
 */
export function buildRows(page: DocPage, toleranceOverride?: number): Row[] {
  const tokens = page.tokens.filter((t) => t.text.trim().length > 0);
  if (tokens.length === 0) return [];

  const lineHeight = median(tokens.map((t) => t.height).filter((h) => h > 0)) || 8;
  const tolerance = toleranceOverride ?? Math.max(2.5, lineHeight * 0.6);

  // Sort top to bottom so rows come out in reading order.
  const sorted = [...tokens].sort((a, b) => b.y - a.y || a.x - b.x);

  const buckets: { y: number; tokens: Token[] }[] = [];
  for (const token of sorted) {
    const last = buckets[buckets.length - 1];
    if (last && Math.abs(last.y - token.y) <= tolerance) {
      last.tokens.push(token);
      // Running mean keeps the bucket centred as tokens accumulate.
      last.y = (last.y * (last.tokens.length - 1) + token.y) / last.tokens.length;
    } else {
      buckets.push({ y: token.y, tokens: [token] });
    }
  }

  return buckets.map((bucket) => {
    const ordered = [...bucket.tokens].sort((a, b) => a.x - b.x);
    return {
      y: bucket.y,
      page: page.index,
      label: '',
      tokens: ordered,
      cells: [],
      labelStartX: ordered[0]?.x ?? 0,
      labelEndX: 0,
    } satisfies Row;
  });
}

/**
 * Locate the value columns by clustering the right edges of tokens that parse
 * as amounts.
 */
export function detectValueColumns(rows: Row[], pageWidth: number): ValueColumn[] {
  interface Candidate { right: number; left: number }
  const candidates: Candidate[] = [];

  for (const row of rows) {
    for (const stitched of stitchNumericTokens(stitchable(row.tokens), stitchGapFor(pageWidth))) {
      const declaredNumeric = stitched.parts.some((part) => part.numeric);
      if (!isAmountCandidate(stitched.text, declaredNumeric)) continue;
      if (!parseAmount(stitched.text)) continue;
      candidates.push({ right: stitched.x + stitched.width, left: stitched.x });
    }
  }

  if (candidates.length < 2) return [];

  // Cluster right edges. The tolerance is a fraction of page width so the same
  // code works for A4 points and for the synthetic Excel grid.
  const tolerance = Math.max(8, pageWidth * 0.035);
  const byRight = [...candidates].sort((a, b) => a.right - b.right);

  const clusters: { rights: number[]; lefts: number[] }[] = [];
  for (const candidate of byRight) {
    const last = clusters[clusters.length - 1];
    const lastMean = last ? last.rights.reduce((a, b) => a + b, 0) / last.rights.length : null;
    if (last && lastMean !== null && candidate.right - lastMean <= tolerance) {
      last.rights.push(candidate.right);
      last.lefts.push(candidate.left);
    } else {
      clusters.push({ rights: [candidate.right], lefts: [candidate.left] });
    }
  }

  // A real column carries several figures. One-off numbers inside prose (a
  // year, a CIN fragment) form singleton clusters and are dropped.
  const minSupport = candidates.length >= 8 ? 3 : 2;
  const kept = clusters.filter((c) => c.rights.length >= minSupport);
  const source = kept.length > 0 ? kept : clusters;

  return source
    .map((cluster) => {
      const rightEdge = median(cluster.rights);
      const left = Math.min(...cluster.lefts);
      return {
        index: 0,
        rightEdge,
        left,
        right: Math.max(...cluster.rights),
        support: cluster.rights.length,
      } satisfies ValueColumn;
    })
    .sort((a, b) => a.rightEdge - b.rightEdge)
    .map((column, index) => ({ ...column, index }));
}

/**
 * Assign each row's tokens to the label region or to a value column, filling
 * in `label` and `cells`.
 */
export function assignCells(rows: Row[], columns: ValueColumn[], pageWidth: number): void {
  const labelBoundary =
    columns.length > 0 ? Math.min(...columns.map((c) => c.left)) - 4 : pageWidth;
  const tolerance = Math.max(12, pageWidth * 0.05);

  for (const row of rows) {
    const labelTokens: Token[] = [];
    const valueTokens: Token[] = [];

    for (const token of row.tokens) {
      // A token belongs to the value region when it starts at or past the
      // leftmost column edge. Anything earlier is label text, even if numeric
      // (note references, serial numbers, "(A)" markers).
      if (token.x >= labelBoundary) valueTokens.push(token);
      else labelTokens.push(token);
    }

    row.label = labelTokens
      .map((t) => t.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    row.labelStartX = labelTokens[0]?.x ?? row.labelStartX;
    const lastLabel = labelTokens[labelTokens.length - 1];
    row.labelEndX = lastLabel ? lastLabel.x + lastLabel.width : row.labelStartX;

    const stitched = stitchNumericTokens(stitchable(valueTokens), stitchGapFor(pageWidth));

    const cells: Cell[] = [];
    for (const piece of stitched) {
      const declaredNumeric = piece.parts.some((part) => part.numeric);
      if (!isAmountCandidate(piece.text, declaredNumeric)) continue;
      const amount = parseAmount(piece.text);
      if (!amount) continue;

      const pieceRight = piece.x + piece.width;
      let best: ValueColumn | null = null;
      let bestDistance = Infinity;
      for (const column of columns) {
        const distance = Math.abs(column.rightEdge - pieceRight);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = column;
        }
      }
      if (!best || bestDistance > tolerance) continue;
      // One figure per column per row; keep the higher-confidence read.
      const existing = cells.find((c) => c.columnIndex === best!.index);
      if (existing) {
        if (amount.confidence > existing.amount.confidence) {
          existing.amount = amount;
          existing.x = piece.x;
          existing.width = piece.width;
        }
        continue;
      }
      cells.push({ columnIndex: best.index, amount, x: piece.x, width: piece.width });
    }

    row.cells = cells.sort((a, b) => a.columnIndex - b.columnIndex);
  }
}
