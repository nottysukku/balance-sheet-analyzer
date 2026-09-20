import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { analyseDocument } from '../analyze/index.js';
import type { ConceptId } from '../domain/types.js';

/**
 * End-to-end tests against the real scanned filing.
 *
 * The expected figures were verified by hand against the note schedules on
 * pages 10-11 of the document (Note 10 Investments, Note 11 Inventories,
 * Note 12 Trade receivables, Note 13 Cash, Note 14 Loans and advances), not
 * read off the balance sheet page the parser itself uses. If the row alignment
 * ever slips by one line, these assertions fail.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(here, '../../../samples/laj-exports-fy2024.pdf');

const EXPECTED_FY2024: Partial<Record<ConceptId, number>> = {
  shareCapital: 37362140,
  reservesAndSurplus: 513975424,
  longTermBorrowings: 202508939,
  deferredTaxLiabilities: 2611863,
  shortTermBorrowings: 361211353,
  tradePayables: 27056594,
  otherCurrentLiabilities: 32091101,
  propertyPlantAndEquipment: 64282324,
  currentInvestments: 7330400,
  inventories: 699006548,
  tradeReceivables: 245438959,
  cashAndCashEquivalents: 33721121,
  shortTermLoansAndAdvances: 127098062,
};

const EXPECTED_FY2023: Partial<Record<ConceptId, number>> = {
  shareCapital: 37362140,
  reservesAndSurplus: 491983895,
  longTermBorrowings: 273290824,
  shortTermBorrowings: 491257194,
  inventories: 798810631,
  tradeReceivables: 213511710,
  cashAndCashEquivalents: 88054819,
  shortTermLoansAndAdvances: 135072732,
};

const analyse = () =>
  analyseDocument({
    buffer: fs.readFileSync(SAMPLE),
    fileName: 'laj-exports-fy2024.pdf',
    format: 'pdf',
    useLlm: false, // deterministic path only, so the suite needs no API key
  });

describe('PDF pipeline', () => {
  it('identifies the company and both reporting periods', async () => {
    const report = await analyse();
    expect(report.statement.company.name).toBe('LAJ EXPORTS LIMITED');
    expect(report.statement.company.currency).toBe('INR');
    expect(report.statement.periods.map((p) => p.id)).toEqual(['FY2024', 'FY2023']);
    // Most recent first.
    expect(report.statement.periods[0]!.endDate).toBe('2024-03-31');
  });

  it('finds the balance sheet among fifteen pages of filing', async () => {
    const report = await analyse();
    expect(report.source.pageCount).toBe(15);
    expect(report.statement.lineItems.length).toBeGreaterThanOrEqual(13);
  });

  it.each(Object.entries(EXPECTED_FY2024))('reads %s for FY2024', async (concept, expected) => {
    const report = await analyse();
    const item = report.statement.lineItems.find((i) => i.concept === concept);
    expect(item?.values.FY2024?.value).toBe(expected);
  });

  it.each(Object.entries(EXPECTED_FY2023))('reads %s for FY2023', async (concept, expected) => {
    const report = await analyse();
    const item = report.statement.lineItems.find((i) => i.concept === concept);
    expect(item?.values.FY2023?.value).toBe(expected);
  });

  it('balances within OCR tolerance for both years', async () => {
    const report = await analyse();
    for (const check of report.statement.balanceChecks) {
      expect(check.status).toBe('balanced');
      expect(check.relativeDifference!).toBeLessThan(0.001);
    }
  });

  it('produces ratios and insights without an API key', async () => {
    const report = await analyse();
    expect(report.analysis.metrics.length).toBeGreaterThan(6);
    expect(report.analysis.insights.length).toBeGreaterThan(4);
    expect(report.analysis.narrativeFromLlm).toBe(false);
    expect(report.source.llmAssist.extraction).toBe(false);
  });

  it('records provenance for every extracted figure', async () => {
    const report = await analyse();
    const shareCapital = report.statement.lineItems.find((i) => i.concept === 'shareCapital');
    const value = shareCapital!.values.FY2024!;
    expect(value.origin).toBe('extracted');
    expect(value.page).toBe(1);
    expect(value.sourceLabel).toMatch(/share capital/i);
    expect(value.rawText).toBeTruthy();
  });
});

describe('Excel pipeline', () => {
  /** Build a workbook in the Schedule III shape the PDF uses. */
  function workbook(): Buffer {
    const rows = [
      ['LAJ EXPORTS LIMITED'],
      ['Balance Sheet as at 31st March 2024'],
      ['All amounts in Indian Rupees'],
      ['Particulars', '31st Mar 2024', '31st March 2023'],
      ['EQUITY AND LIABILITIES'],
      ["Shareholder's funds"],
      ['Share capital', 37362140, 37362140],
      ['Reserves and surplus', 513975424, 491983895],
      ['Non-current liabilities'],
      ['Long-term borrowings', 202508939, 273290824],
      ['Deferred tax liabilities (net)', 2611863, 7656018],
      ['Current liabilities'],
      ['Short-term borrowings', 361211353, 491257194],
      ['Trade payables', 27056594, 27795484],
      ['Other current liabilities', 32091101, 41171976],
      ['ASSETS'],
      ['Non-current assets'],
      ['Property, plant and equipment', 64282324, 127137234],
      ['Current assets'],
      ['Current investments', 7330400, 7330400],
      ['Inventories', 699006548, 798810631],
      ['Trade receivables', 245438959, 213511710],
      ['Cash and cash equivalents', 33721121, 88054819],
      ['Short-term loans and advances', 127098062, 135072732],
    ];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Balance Sheet');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  it('reads the same figures out of a spreadsheet', async () => {
    const report = await analyseDocument({
      buffer: workbook(),
      fileName: 'balance-sheet.xlsx',
      format: 'excel',
      useLlm: false,
    });

    expect(report.source.sheetNames).toEqual(['Balance Sheet']);
    expect(report.statement.periods.map((p) => p.id)).toEqual(['FY2024', 'FY2023']);
    for (const [concept, expected] of Object.entries(EXPECTED_FY2024)) {
      const item = report.statement.lineItems.find((i) => i.concept === concept);
      expect(item?.values.FY2024?.value, concept).toBe(expected);
    }
  });

  it('balances', async () => {
    const report = await analyseDocument({
      buffer: workbook(),
      fileName: 'balance-sheet.xlsx',
      format: 'excel',
      useLlm: false,
    });
    const check = report.statement.balanceChecks.find((c) => c.periodId === 'FY2024')!;
    expect(check.status).toBe('balanced');
  });

  /**
   * A US-GAAP sheet stated in thousands, so every figure is a bare four- or
   * five-digit number with no separators.
   *
   * This is the case that the PDF-tuned heuristics get wrong: an unseparated
   * run of four digits looks exactly like a year, so `8600` was being thrown
   * away. A numeric spreadsheet cell is not ambiguous, and the ingester says so.
   */
  function bareNumberWorkbook(): Buffer {
    const rows = [
      ['ACME MANUFACTURING PLC'],
      ['Balance Sheet as at 31 December 2024'],
      ['All amounts in USD thousands'],
      ['Particulars', '31 Dec 2024', '31 Dec 2023'],
      ['ASSETS'],
      ['Non-current assets'],
      ['Property, plant and equipment', 48200, 45100],
      ['Intangible assets', 6400, 7100],
      ['Current assets'],
      ['Inventories', 18900, 21400],
      ['Accounts receivable', 24300, 22800],
      ['Cash and cash equivalents', 12750, 7600],
      ['LIABILITIES AND EQUITY'],
      ['Equity'],
      ['Common stock', 15000, 15000],
      ['Retained earnings', 42150, 35900],
      ['Non-current liabilities'],
      ['Long-term debt', 28000, 32000],
      ['Current liabilities'],
      ['Short-term debt', 9000, 8500],
      ['Accounts payable', 11400, 10600],
      ['Other current liabilities', 5000, 2000],
    ];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'BS');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  const analyseBare = () =>
    analyseDocument({
      buffer: bareNumberWorkbook(),
      fileName: 'acme.xlsx',
      format: 'excel',
      useLlm: false,
    });

  it('reads unseparated four-digit figures out of numeric cells', async () => {
    const report = await analyseBare();
    const value = (concept: ConceptId, periodId: string) =>
      report.statement.lineItems.find((i) => i.concept === concept)?.values[periodId]?.value ?? null;

    // Stated in thousands, so the pipeline scales them to absolute dollars.
    expect(value('intangibleAssets', 'FY2024')).toBe(6_400_000);
    expect(value('shortTermBorrowings', 'FY2024')).toBe(9_000_000);
    expect(value('shortTermBorrowings', 'FY2023')).toBe(8_500_000);
    expect(value('otherCurrentLiabilities', 'FY2024')).toBe(5_000_000);
    expect(value('cashAndCashEquivalents', 'FY2023')).toBe(7_600_000);
  });

  it('applies the stated unit scale and currency', async () => {
    const report = await analyseBare();
    expect(report.statement.company.currency).toBe('USD');
    expect(report.statement.company.unitScale).toBe(1000);
    expect(report.warnings.some((w) => w.code === 'UNIT_SCALED')).toBe(true);
  });

  it('balances a US-GAAP sheet', async () => {
    const report = await analyseBare();
    for (const check of report.statement.balanceChecks) {
      expect(check.status, check.periodId).toBe('balanced');
    }
  });
});

describe('failure handling', () => {
  it('rejects a PDF with no text layer', async () => {
    // A valid PDF header with nothing extractable behind it.
    const empty = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');
    await expect(
      analyseDocument({ buffer: empty, fileName: 'scan.pdf', format: 'pdf', useLlm: false }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NO_TEXT_LAYER|UNREADABLE_PDF/) });
  });

  it('rejects an unreadable spreadsheet', async () => {
    await expect(
      analyseDocument({
        buffer: Buffer.from('this is not a workbook'),
        fileName: 'notes.xlsx',
        format: 'excel',
        useLlm: false,
      }),
    ).rejects.toThrow();
  });
});
