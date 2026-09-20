import type { Cell, Row } from './rows.js';

/**
 * Pairs label rows with value rows.
 *
 * This is the hardest part of reading a scanned statement. Naive "same row"
 * matching fails badly on the reference document because the scan is slightly
 * skewed: the value columns on the right sit roughly 7 points *below* the
 * label they belong to. Matching by nearest row therefore shifts every figure
 * up by one line - share capital becomes reserves, inventory becomes
 * receivables, and the whole analysis is quietly wrong.
 *
 * Two observations make it tractable:
 *
 *  1. **Rows carrying only numbers are unambiguous.** A figure cannot exist
 *     without a label, so a value-only row must belong to a label row above
 *     it. Those pairs give an unbiased estimate of the document's vertical
 *     offset - unlike rows that carry both text and numbers, which would bias
 *     the estimate towards zero.
 *
 *  2. **Reading order is preserved.** A statement never prints item B's figure
 *     above item A's. So the assignment is a monotonic matching, which is
 *     exactly what a Needleman-Wunsch style dynamic program solves optimally.
 *
 * The result is the globally best ordered assignment under a Gaussian
 * proximity score centred on the estimated offset, rather than a greedy
 * nearest-neighbour guess.
 */

export interface AlignedRow {
  /** The row whose text names the item. */
  labelRow: Row;
  /** The row the figures were printed on (may be the same row). */
  valueRow: Row | null;
  cells: Cell[];
  /** 0..1 - how well this pairing fits the document's geometry. */
  confidence: number;
}

/** Vertical offsets outside this window are never plausible pairings. */
const MIN_DY = -6;
const MAX_DY = 26;
/** Width of the Gaussian around the estimated offset, in points. */
const SIGMA = 5;
/** Score forfeited when a value row cannot be matched at all. */
const DROP_PENALTY = 0.75;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Estimate how far below its label a figure is printed, using only rows that
 * contain numbers and no label text.
 */
export function estimateVerticalOffset(rows: Row[]): number {
  const samples: number[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.cells.length === 0) continue;
    if (row.label.length > 0) continue; // biased - skip

    // Rows are ordered top to bottom, so scan backwards for the label above.
    for (let j = i - 1; j >= 0; j--) {
      const candidate = rows[j]!;
      if (candidate.label.length === 0) continue;
      const dy = candidate.y - row.y;
      if (dy > MAX_DY) break;
      if (dy >= MIN_DY) samples.push(dy);
      break;
    }
  }

  if (samples.length === 0) return 0;
  return median(samples);
}

/** Labels that introduce a group and never carry a figure themselves. */
const HEADING_PATTERNS: RegExp[] = [
  /^\(?[ivx]+\)?[\s.)-]*$/i,
  /equity\s*and\s*liabilit/i,
  /^\s*assets\s*$/i,
  /^\s*liabilities\s*$/i,
  /shareholder'?s?\s*funds?/i,
  /^\d?\s*[).]?\s*(non[-\s]?current|current)\s+(assets|liabilities)\s*$/i,
  /^particulars\b/i,
  /^note\s*no/i,
  /^sr\.?\s*no/i,
  /^total\s+outstanding\s+dues/i,
];

/**
 * How likely a row is to be a concrete line item rather than a group heading.
 * Used to break ties between two geometrically similar pairings.
 */
function leafScore(row: Row): number {
  const text = row.label.trim();
  if (text.length === 0) return 0.1;
  for (const pattern of HEADING_PATTERNS) {
    if (pattern.test(text)) return 0.25;
  }
  // Long prose lines (accounting policy notes) are not line items.
  if (text.length > 90) return 0.3;
  // A trailing colon usually introduces a sub-list.
  if (/:\s*$/.test(text)) return 0.5;
  return 1;
}

function proximityScore(dy: number, offset: number): number {
  if (dy < MIN_DY || dy > MAX_DY) return Number.NEGATIVE_INFINITY;
  const z = (dy - offset) / SIGMA;
  return Math.exp(-0.5 * z * z);
}

/**
 * Assign each value row to at most one label row, preserving reading order and
 * maximising total score. Classic O(n*m) dynamic program.
 */
export function alignRows(rows: Row[], offsetOverride?: number): AlignedRow[] {
  const offset = offsetOverride ?? estimateVerticalOffset(rows);

  const labelRows = rows.filter((r) => r.label.trim().length > 0);
  const valueRows = rows.filter((r) => r.cells.length > 0);
  if (labelRows.length === 0 || valueRows.length === 0) {
    return labelRows.map((labelRow) => ({ labelRow, valueRow: null, cells: [], confidence: 0 }));
  }

  const n = labelRows.length;
  const m = valueRows.length;

  // pair[i][j] = score of assigning valueRows[j] to labelRows[i].
  const pair: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: m }, (_, j) => {
      const dy = labelRows[i]!.y - valueRows[j]!.y;
      const proximity = proximityScore(dy, offset);
      if (!Number.isFinite(proximity)) return Number.NEGATIVE_INFINITY;
      return proximity * (0.55 + 0.45 * leafScore(labelRows[i]!));
    }),
  );

  // best[i][j] = best total score using the first i labels and first j values.
  const NEG = Number.NEGATIVE_INFINITY;
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(NEG));
  type Move = 'skip-label' | 'drop-value' | 'match';
  const move: Move[][] = Array.from({ length: n + 1 }, () => new Array<Move>(m + 1).fill('skip-label'));

  best[0]![0] = 0;
  for (let j = 1; j <= m; j++) {
    best[0]![j] = best[0]![j - 1]! - DROP_PENALTY;
    move[0]![j] = 'drop-value';
  }
  for (let i = 1; i <= n; i++) {
    best[i]![0] = 0;
    move[i]![0] = 'skip-label';
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      // Leave this label without a figure.
      let bestScore = best[i - 1]![j]!;
      let bestMove: Move = 'skip-label';

      // Discard this value row (orphaned figure).
      const dropped = best[i]![j - 1]! - DROP_PENALTY;
      if (dropped > bestScore) {
        bestScore = dropped;
        bestMove = 'drop-value';
      }

      const pairScore = pair[i - 1]![j - 1]!;
      if (Number.isFinite(pairScore)) {
        const matched = best[i - 1]![j - 1]! + pairScore;
        if (matched > bestScore) {
          bestScore = matched;
          bestMove = 'match';
        }
      }

      best[i]![j] = bestScore;
      move[i]![j] = bestMove;
    }
  }

  const assignment = new Map<number, { valueIndex: number; score: number }>();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const step = move[i]![j]!;
    if (step === 'match') {
      assignment.set(i - 1, { valueIndex: j - 1, score: pair[i - 1]![j - 1]! });
      i--;
      j--;
    } else if (step === 'drop-value') {
      j--;
    } else {
      i--;
    }
  }

  return labelRows.map((labelRow, index) => {
    const hit = assignment.get(index);
    if (!hit) return { labelRow, valueRow: null, cells: [], confidence: 0 };
    const valueRow = valueRows[hit.valueIndex]!;
    // Blend geometric fit with how cleanly the figures themselves parsed.
    const numericConfidence =
      valueRow.cells.reduce((sum, c) => sum + c.amount.confidence, 0) / valueRow.cells.length;
    return {
      labelRow,
      valueRow,
      cells: valueRow.cells,
      confidence: Math.max(0, Math.min(1, hit.score)) * 0.6 + numericConfidence * 0.4,
    };
  });
}
