import { describe, expect, it } from 'vitest';
import { alignRows, estimateVerticalOffset } from '../parse/align.js';
import type { Cell, Row } from '../parse/rows.js';

/** Build a row carrying a label, figures, or both. */
function row(y: number, label: string, ...values: number[]): Row {
  const cells: Cell[] = values.map((value, columnIndex) => ({
    columnIndex,
    amount: { value, confidence: 1, repaired: false, raw: String(value) },
    x: 400 + columnIndex * 90,
    width: 45,
  }));
  return {
    y,
    page: 1,
    label,
    tokens: label ? [{ text: label, x: 60, y, width: label.length * 5, height: 8 }] : [],
    cells,
    labelStartX: 60,
    labelEndX: 60 + label.length * 5,
  };
}

/**
 * The exact geometry of page 1 of the sample filing: the scan is skewed, so
 * every figure is printed about seven points below the caption it belongs to.
 */
const SKEWED_LIABILITIES: Row[] = [
  row(594, 'EQUITY AND LIABILITIES'),
  row(574, "1) Shareholder's funds"),
  row(564, 'a) Share capital'),
  row(556, 'b) Surplus', 37362140, 37362140),
  row(548, '', 513975424, 491983895),
  row(533, '2) Non-current liabilities'),
  row(524, 'a) Long-term borrowings'),
  row(514, 'b) Deferred Tax Liabilities (Net)', 202508939, 273290824),
  row(507, '', 2611863, 7656018),
  row(494, '3) Current liabilities'),
  row(484, 'a) Short-term borrowings'),
  row(475, 'b) Trade payables', 361211353, 491257194),
  // Trade payables is split into the two Schedule III sub-captions, and the
  // figure is printed against the wrapped tail of the second one.
  row(463, '(A) total outstanding dues of micro enterprises'),
  row(454, 'and small enterprises; and'),
  row(443, '(B) total outstanding dues of creditors other than'),
  row(435, 'micro enterprises and small enterprises', 27056594, 27795484),
  row(424, 'c) Other current liabilities'),
  row(418, '', 32091101, 41171976),
];

/** Same items, printed without any skew - label and figures on one line. */
const CLEAN_LIABILITIES: Row[] = [
  row(594, 'EQUITY AND LIABILITIES'),
  row(564, 'Share capital', 37362140, 37362140),
  row(556, 'Reserves and surplus', 513975424, 491983895),
  row(524, 'Long-term borrowings', 202508939, 273290824),
  row(514, 'Deferred tax liabilities', 2611863, 7656018),
  row(484, 'Short-term borrowings', 361211353, 491257194),
  row(475, 'Trade payables', 27056594, 27795484),
  row(424, 'Other current liabilities', 32091101, 41171976),
];

function pairs(rows: Row[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of alignRows(rows)) {
    if (entry.cells.length === 0) continue;
    out[entry.labelRow.label] = entry.cells[0]!.amount.value;
  }
  return out;
}

describe('estimateVerticalOffset', () => {
  it('measures the skew from value-only rows', () => {
    // 556->564 is 8, 507->514 is 7, 418->424 is 6: median 7.
    expect(estimateVerticalOffset(SKEWED_LIABILITIES)).toBe(7);
  });

  it('reports no offset for an unskewed page', () => {
    expect(estimateVerticalOffset(CLEAN_LIABILITIES)).toBe(0);
  });
});

describe('alignRows', () => {
  it('pairs figures with the right caption on a skewed scan', () => {
    const result = pairs(SKEWED_LIABILITIES);

    // The load-bearing assertion: naive nearest-row matching puts share
    // capital's figure against "Surplus" and shifts every later row with it.
    expect(result['a) Share capital']).toBe(37362140);
    expect(result['b) Surplus']).toBe(513975424);
    expect(result['a) Long-term borrowings']).toBe(202508939);
    expect(result['b) Deferred Tax Liabilities (Net)']).toBe(2611863);
    expect(result['a) Short-term borrowings']).toBe(361211353);
    expect(result['c) Other current liabilities']).toBe(32091101);
    // The payables figure attaches to the "(B) ... creditors other than"
    // caption rather than its wrapped tail, which is the row the printed
    // figure sits level with. Both resolve to trade payables downstream, and
    // the caption carrying the word "creditors" is the one that classifies.
    expect(result['(B) total outstanding dues of creditors other than']).toBe(27056594);
  });

  it('leaves the empty sub-caption without a figure', () => {
    const result = pairs(SKEWED_LIABILITIES);
    expect(result['(A) total outstanding dues of micro enterprises']).toBeUndefined();
  });

  it('leaves group headings without figures', () => {
    const result = pairs(SKEWED_LIABILITIES);
    expect(result['EQUITY AND LIABILITIES']).toBeUndefined();
    expect(result["1) Shareholder's funds"]).toBeUndefined();
    expect(result['2) Non-current liabilities']).toBeUndefined();
    expect(result['3) Current liabilities']).toBeUndefined();
  });

  it('still works when there is no skew at all', () => {
    const result = pairs(CLEAN_LIABILITIES);
    expect(result['Share capital']).toBe(37362140);
    expect(result['Reserves and surplus']).toBe(513975424);
    expect(result['Other current liabilities']).toBe(32091101);
  });

  it('carries both columns through to the caption', () => {
    const entry = alignRows(SKEWED_LIABILITIES).find(
      (e) => e.labelRow.label === 'a) Share capital',
    );
    expect(entry?.cells.map((c) => c.amount.value)).toEqual([37362140, 37362140]);
  });

  it('returns captions with no figures rather than dropping them', () => {
    const aligned = alignRows([row(100, 'Intangible assets'), row(80, 'Goodwill')]);
    expect(aligned).toHaveLength(2);
    expect(aligned.every((entry) => entry.valueRow === null)).toBe(true);
  });
});
