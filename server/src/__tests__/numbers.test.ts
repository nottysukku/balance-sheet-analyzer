import { describe, expect, it } from 'vitest';
import { looksLikeAmount, parseAmount, stitchNumericTokens } from '../parse/numbers.js';

const value = (input: string) => parseAmount(input)?.value ?? null;

describe('parseAmount', () => {
  it('reads Indian digit grouping', () => {
    expect(value('1,17,68,77,414')).toBe(1176877414);
    expect(value('3,73,62,140')).toBe(37362140);
    expect(value('73,30,400')).toBe(7330400);
  });

  it('reads Western digit grouping', () => {
    expect(value('1,176,877,414')).toBe(1176877414);
    expect(value('12,345')).toBe(12345);
  });

  it('treats accounting parentheses as negative', () => {
    expect(value('(17,95,893)')).toBe(-1795893);
    expect(value('-26,11,863')).toBe(-2611863);
  });

  it('keeps a genuine decimal fraction', () => {
    expect(value('12,34,567.89')).toBeCloseTo(1234567.89, 2);
    expect(value('1234.5')).toBeCloseTo(1234.5, 2);
  });

  it('treats repeated dots as separators, not decimals', () => {
    // Straight from the sample PDF: every comma scanned as a full stop.
    expect(value('1.43.80.70.840')).toBe(1438070840);
    expect(value('80.00.94.216')).toBe(800094216);
  });

  it('repairs OCR letter-for-digit substitutions', () => {
    expect(value('5t,39,75,424')).toBe(513975424);
    expect(value('2t,35,tI,7 10')).toBe(213511710);
    expect(value('8,80,54,8I9')).toBe(88054819);
    expect(value('1,r7,68"77.414')).toBe(1176877414);
  });

  it('flags repaired reads with lower confidence', () => {
    const clean = parseAmount('3,73,62,140');
    const damaged = parseAmount('5t,39,75,424');
    expect(clean?.repaired).toBe(false);
    expect(damaged?.repaired).toBe(true);
    expect(damaged!.confidence).toBeLessThan(clean!.confidence);
  });

  it('rejects prose and stray words', () => {
    expect(parseAmount('Total')).toBeNull();
    expect(parseAmount('Inventories')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('DIRECTOR')).toBeNull();
  });
});

describe('looksLikeAmount', () => {
  it('accepts grouped figures', () => {
    expect(looksLikeAmount('1,17,68,77,414')).toBe(true);
    expect(looksLikeAmount('(2,70,56,594)')).toBe(true);
  });

  it('rejects note references, serial numbers and bare years', () => {
    // Otherwise every "Note 12" and "2024" pollutes the value columns.
    expect(looksLikeAmount('2024')).toBe(false);
    expect(looksLikeAmount('12')).toBe(false);
    expect(looksLikeAmount('1')).toBe(false);
  });

  it('rejects text', () => {
    expect(looksLikeAmount('Trade payables')).toBe(false);
    expect(looksLikeAmount('')).toBe(false);
  });
});

describe('stitchNumericTokens', () => {
  it('rejoins a figure the scan broke apart', () => {
    const stitched = stitchNumericTokens(
      [
        { text: '79,88,10,63', x: 493, width: 34 },
        { text: 'I', x: 532, width: 3 },
      ],
      8,
    );
    expect(stitched).toHaveLength(1);
    expect(parseAmount(stitched[0]!.text)?.value).toBe(798810631);
  });

  it('keeps figures in separate columns apart', () => {
    const stitched = stitchNumericTokens(
      [
        { text: '3,73,62,140', x: 407, width: 45 },
        { text: '3,73,62,140', x: 501, width: 45 },
      ],
      8,
    );
    expect(stitched).toHaveLength(2);
  });

  it('breaks the run when a word interrupts it', () => {
    const stitched = stitchNumericTokens(
      [
        { text: '1,00,000', x: 10, width: 30 },
        { text: 'Total', x: 41, width: 20 },
        { text: '2,00,000', x: 62, width: 30 },
      ],
      8,
    );
    expect(stitched).toHaveLength(2);
  });
});
