import { describe, expect, it } from 'vitest';
import { classifyLabel, detectSectionHeader, normalizeLabel } from '../parse/classify.js';

const concept = (label: string, section?: 'assets' | 'liabilities' | 'equity') =>
  classifyLabel(label, { section })?.concept.id ?? null;

describe('normalizeLabel', () => {
  it('strips enumeration markers', () => {
    expect(normalizeLabel('a) Share capital')).toBe('share capital');
    expect(normalizeLabel('(i) Plant and Equipment')).toBe('plant and equipment');
    expect(normalizeLabel('3) Current liabilities')).toBe('current liabilities');
  });
});

describe('classifyLabel', () => {
  it('matches clean captions', () => {
    expect(concept('Share capital', 'equity')).toBe('shareCapital');
    expect(concept('Trade receivables', 'assets')).toBe('tradeReceivables');
    expect(concept('Cash and cash equivalents', 'assets')).toBe('cashAndCashEquivalents');
  });

  it('reads through OCR damage taken from the sample filing', () => {
    expect(concept('a) Shortterm borowings', 'liabilities')).toBe('shortTermBorrowings');
    expect(concept('a) Long-tcrm borrowings', 'liabilities')).toBe('longTermBorrowings');
    expect(concept('a) Cuffent Investments', 'assets')).toBe('currentInvestments');
    expect(concept('e) Short+erm loans and advances', 'assets')).toBe('shortTermLoansAndAdvances');
    expect(concept('Trade receivahles', 'assets')).toBe('tradeReceivables');
    expect(concept(') Defered Tax Liabilities Net)', 'liabilities')).toBe('deferredTaxLiabilities');
  });

  it('does not confuse "other" with "total"', () => {
    expect(concept('c) Other current liabilities', 'liabilities')).toBe('otherCurrentLiabilities');
    expect(concept('Total current liabilities', 'liabilities')).toBe('totalCurrentLiabilities');
  });

  it('does not confuse "other current" with "other non-current"', () => {
    expect(concept('Other current liabilities', 'liabilities')).toBe('otherCurrentLiabilities');
    expect(concept('Other non-current liabilities', 'liabilities')).toBe('otherNonCurrentLiabilities');
  });

  it('keeps receivables and payables apart', () => {
    expect(concept('Trade payables', 'liabilities')).toBe('tradePayables');
    expect(concept('Sundry debtors', 'assets')).toBe('tradeReceivables');
    expect(concept('Sundry creditors', 'liabilities')).toBe('tradePayables');
  });

  it('does not read an asset caption as long-term debt', () => {
    // "term loans" is a substring of "short term loans and advances".
    expect(concept('Short term loans and advances', 'assets')).toBe('shortTermLoansAndAdvances');
  });

  it('understands international wording', () => {
    expect(concept('Accounts receivable', 'assets')).toBe('tradeReceivables');
    expect(concept('Accounts payable', 'liabilities')).toBe('tradePayables');
    expect(concept('Retained earnings', 'equity')).toBe('reservesAndSurplus');
    expect(concept('Property, plant and equipment', 'assets')).toBe('propertyPlantAndEquipment');
  });

  it('returns null for prose and signatures', () => {
    expect(concept('FOR LAJ EXPORTS LIMITED')).toBeNull();
    expect(concept('PLACE: DELHI')).toBeNull();
    expect(concept('DIN : 00252160')).toBeNull();
  });
});

describe('detectSectionHeader', () => {
  it('recognises the Schedule III group headings', () => {
    expect(detectSectionHeader('EQUITY AND LIABILITIES')).toBe('liabilities');
    expect(detectSectionHeader('EQUITYAND LIABILITTES')).toBe('liabilities'); // as scanned
    expect(detectSectionHeader('I) Non-current assets')).toBe('assets');
    expect(detectSectionHeader('l) Current assets')).toBe('assets');
    expect(detectSectionHeader('3) Current liabilities')).toBe('liabilities');
    expect(detectSectionHeader("1) Shareholder's funds")).toBe('equity');
  });

  it('never swallows a line item that merely resembles a heading', () => {
    // These three are real rows; treating any of them as a heading silently
    // drops a figure from the statement.
    expect(detectSectionHeader('c) Other current liabilities')).toBeNull();
    expect(detectSectionHeader('Other current assets')).toBeNull();
    expect(detectSectionHeader('Total current assets')).toBeNull();
    expect(detectSectionHeader('Total assets')).toBeNull();
  });
});
