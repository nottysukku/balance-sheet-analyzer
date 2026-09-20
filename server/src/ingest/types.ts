/**
 * The neutral document model that PDF and Excel ingestion both produce.
 *
 * Everything downstream (row building, column detection, label matching) works
 * against this shape, so adding a third input format later means writing one
 * new ingester and nothing else.
 */

/** A positioned run of text. For Excel, x/y are synthesised from the grid. */
export interface Token {
  text: string;
  /** Left edge, in points (PDF) or column index * 100 (Excel). */
  x: number;
  /** Baseline, in points measured from the bottom (PDF) or -rowIndex (Excel). */
  y: number;
  width: number;
  height: number;
  /**
   * Set when the source told us this was a number rather than text - a numeric
   * spreadsheet cell. A PDF cannot say, so it is left undefined there and the
   * text heuristics decide.
   */
  numeric?: boolean;
}

export interface DocPage {
  /** 1-based. */
  index: number;
  /** Sheet name for Excel, undefined for PDF. */
  name?: string;
  width: number;
  height: number;
  tokens: Token[];
}

export interface SourceDocument {
  format: 'pdf' | 'excel';
  pages: DocPage[];
  /** Sheet names, for Excel sources. */
  sheetNames?: string[];
  /** Total characters recovered - near zero means an image-only PDF. */
  textLength: number;
}
