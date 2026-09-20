import { config, isLlmConfigured } from '../config.js';
import type { AnalysisReport, ExtractionWarning, SourceMeta } from '../domain/types.js';
import { AppError } from '../http/errors.js';
import { ingestExcel } from '../ingest/excel.js';
import { ingestPdf } from '../ingest/pdf.js';
import type { SourceDocument } from '../ingest/types.js';
import { assistExtraction } from '../llm/extractAssist.js';
import { writeNarrative } from '../llm/narrative.js';
import { parseBalanceSheet } from '../parse/balanceSheet.js';
import { finaliseStatement } from './derive.js';
import { buildSummary, generateInsights } from './insights.js';
import { computeMetrics } from './ratios.js';

/**
 * The pipeline, end to end.
 *
 *   ingest -> parse -> [optional LLM mapping assist] -> derive totals
 *          -> balance check -> ratios -> insights -> [optional LLM narrative]
 *
 * Each stage narrows uncertainty and records where its numbers came from. The
 * two LLM stages are strictly additive: remove the API key and every earlier
 * stage still produces a complete, auditable report.
 */

export type UploadFormat = 'pdf' | 'excel';

export interface AnalyseInput {
  buffer: Buffer;
  fileName: string;
  format: UploadFormat;
  /** Set false to force the deterministic path even when a key is present. */
  useLlm?: boolean;
}

/** Minimum characters of recovered text before we call a PDF image-only. */
const MIN_TEXT_LENGTH = 120;

export async function analyseDocument(input: AnalyseInput): Promise<AnalysisReport> {
  const startedAt = Date.now();

  const document: SourceDocument =
    input.format === 'pdf' ? await ingestPdf(input.buffer) : ingestExcel(input.buffer);

  if (document.textLength < MIN_TEXT_LENGTH) {
    throw new AppError(
      'NO_TEXT_LAYER',
      input.format === 'pdf'
        ? 'This PDF has no extractable text - it looks like a photographed or scanned page without OCR. Run OCR on it and upload again.'
        : 'This spreadsheet appears to be empty.',
      422,
    );
  }

  const parsed = parseBalanceSheet(document);
  const warnings: ExtractionWarning[] = [...parsed.warnings];

  const llmAvailable = isLlmConfigured() && input.useLlm !== false;
  let extractionAssisted = false;

  // Only spend a model call when the deterministic pass left something on the
  // table: low confidence, or rows carrying figures that nothing matched.
  const needsAssist =
    parsed.confidence < config.llmAssistThreshold || parsed.unmappedRows.length > 0;

  let lineItems = parsed.statement.lineItems;
  if (llmAvailable && needsAssist) {
    const assisted = await assistExtraction(parsed);
    if (assisted.applied > 0) {
      lineItems = assisted.lineItems;
      extractionAssisted = true;
      warnings.push({
        code: 'LLM_ASSISTED_MAPPING',
        severity: 'info',
        message: `${assisted.applied} line item${assisted.applied === 1 ? '' : 's'} were matched with Claude's help and are marked accordingly.`,
      });
    }
  }

  const statement = finaliseStatement({ ...parsed.statement, lineItems });
  const metrics = computeMetrics(statement);
  const ruleInsights = generateInsights(statement, metrics);

  let insights = ruleInsights;
  let summary = buildSummary(statement, metrics, ruleInsights);
  let narrativeFromLlm = false;

  if (llmAvailable) {
    const narrative = await writeNarrative(statement, metrics, ruleInsights);
    if (narrative && narrative.insights.length > 0) {
      summary = narrative.summary;
      insights = narrative.insights;
      narrativeFromLlm = true;
    }
  }

  for (const check of statement.balanceChecks) {
    if (check.status === 'imbalanced' || check.status === 'minor-variance') {
      warnings.push({
        code: 'BALANCE_VARIANCE',
        severity: check.status === 'imbalanced' ? 'warning' : 'info',
        message: `${check.periodId}: ${check.message}`,
      });
    }
  }

  const values = statement.lineItems.flatMap((item) => Object.values(item.values));
  const extractionConfidence =
    values.length === 0 ? 0 : values.reduce((sum, v) => sum + v.confidence, 0) / values.length;

  const source: SourceMeta = {
    fileName: input.fileName,
    fileSize: input.buffer.byteLength,
    format: input.format,
    pageCount: input.format === 'pdf' ? document.pages.length : undefined,
    sheetNames: document.sheetNames,
    durationMs: Date.now() - startedAt,
    llmAssist: {
      extraction: extractionAssisted,
      narrative: narrativeFromLlm,
      model: extractionAssisted || narrativeFromLlm ? config.anthropic.model : undefined,
    },
  };

  return {
    source,
    statement,
    analysis: { metrics, insights, summary, narrativeFromLlm },
    warnings,
    extractionConfidence,
  };
}
