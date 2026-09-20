import * as XLSX from 'xlsx';
import type { DocPage, SourceDocument, Token } from './types.js';
import { AppError } from '../http/errors.js';

/**
 * Excel ingestion.
 *
 * Rather than inventing a second parsing path, we project the sheet grid into
 * the same positioned-token model the PDF ingester produces: column index
 * becomes x, row index becomes a descending y. Everything downstream - row
 * assembly, period-column detection, label matching - is then shared.
 *
 * The synthetic geometry is chosen so the PDF-tuned tolerances still hold:
 * columns are COL_WIDTH apart (far wider than any stitching gap) and rows are
 * ROW_HEIGHT apart (wider than the row-clustering tolerance), so a sheet cell
 * can never be merged into its neighbour by accident.
 */

const COL_WIDTH = 120;
const ROW_HEIGHT = 20;

/** Cells that carry no information but would otherwise become empty labels. */
const BLANK_RE = /^[\s\-_.]*$/;

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    // Keep full precision; the amount parser handles grouping and decimals.
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

export function ingestExcel(buffer: Buffer): SourceDocument {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: false });
  } catch (err) {
    throw new AppError(
      'UNREADABLE_SPREADSHEET',
      'The spreadsheet could not be opened. It may be corrupt or in an unsupported format.',
      422,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }

  const sheetNames = workbook.SheetNames ?? [];
  if (sheetNames.length === 0) {
    throw new AppError('EMPTY_WORKBOOK', 'The spreadsheet contains no sheets.', 422);
  }

  const pages: DocPage[] = [];
  let textLength = 0;

  sheetNames.forEach((name, sheetIndex) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) return;

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: null,
      raw: true,
    });

    const tokens: Token[] = [];
    let maxCols = 0;

    rows.forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return;
      maxCols = Math.max(maxCols, row.length);
      row.forEach((cell, colIndex) => {
        const text = cellToText(cell).trim();
        if (!text || BLANK_RE.test(text)) return;
        tokens.push({
          text,
          numeric: typeof cell === 'number',
          x: colIndex * COL_WIDTH,
          // Descending y mirrors PDF coordinates (origin at the bottom).
          y: -rowIndex * ROW_HEIGHT,
          // A generous width keeps numeric stitching from bridging columns.
          width: Math.min(text.length * 6, COL_WIDTH - 20),
          height: 10,
        });
        textLength += text.length;
      });
    });

    pages.push({
      index: sheetIndex + 1,
      name,
      width: Math.max(maxCols, 1) * COL_WIDTH,
      height: Math.max(rows.length, 1) * ROW_HEIGHT,
      tokens,
    });
  });

  return { format: 'excel', pages, sheetNames, textLength };
}
