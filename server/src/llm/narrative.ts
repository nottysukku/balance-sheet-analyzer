import { z } from 'zod';
import type { Insight, Metric, Statement } from '../domain/types.js';
import { formatIndianCurrency } from '../parse/numbers.js';
import { indexValues } from '../analyze/derive.js';
import { callStructured } from './client.js';

/**
 * Optional narrative pass.
 *
 * The model is given the figures the pipeline already computed and asked to
 * write the commentary - it never recomputes a ratio and never sees the raw
 * document. Anything it returns is schema-validated before use, and if that
 * fails the rule-engine narrative stands.
 */

const ResponseSchema = z.object({
  summary: z.string().min(40).max(1200),
  insights: z
    .array(
      z.object({
        kind: z.enum(['strength', 'concern', 'trend', 'observation']),
        severity: z.enum(['high', 'medium', 'low']),
        title: z.string().min(6).max(120),
        detail: z.string().min(20).max(600),
      }),
    )
    .max(8),
});

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Two to four sentences on the overall financial position.',
    },
    insights: {
      type: 'array',
      description: 'Between four and eight findings, most important first.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['strength', 'concern', 'trend', 'observation'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string', description: 'A short headline, under 100 characters.' },
          detail: { type: 'string', description: 'One or two sentences of explanation, citing figures.' },
        },
        required: ['kind', 'severity', 'title', 'detail'],
      },
    },
  },
  required: ['summary', 'insights'],
} as const;

const SYSTEM = `You are a credit analyst writing up a balance sheet for a reader who will act on it.

You are given figures and ratios that have already been computed. Use them exactly as given.

Rules:
- Never state a number that is not in the data provided, and never recompute one.
- Be specific: cite the figures and the year-on-year movement behind each point.
- Say what a finding means for the business, not just that the number moved.
- Balance strengths against concerns honestly. Do not soften a real risk, and do not manufacture one.
- If the data notes an extraction variance, treat the figures as indicative and say so once.
- Plain professional English. No bullet symbols, no markdown, no hedging filler.`;

function buildDataBlock(statement: Statement, metrics: Metric[], insights: Insight[]): string {
  const index = indexValues(statement.lineItems);
  const periods = statement.periods;
  const money = (value: number) => formatIndianCurrency(value);

  const lines: string[] = [];
  lines.push(`Company: ${statement.company.name ?? 'Unknown'}`);
  lines.push(`Currency: ${statement.company.currency ?? 'INR'}`);
  lines.push(`Periods (most recent first): ${periods.map((p) => p.label).join(' | ')}`);
  lines.push('');
  lines.push('BALANCE SHEET');
  for (const item of statement.lineItems) {
    const cells = periods.map((period) => {
      const entry = index.get(item.concept)?.get(period.id);
      return entry ? money(entry.value) : '-';
    });
    lines.push(`  ${item.label}: ${cells.join('  |  ')}`);
  }

  lines.push('');
  lines.push('RATIOS');
  for (const metric of metrics) {
    const cells = metric.values.map((value) => {
      if (value.value === null) return '-';
      if (metric.format === 'currency') return money(value.value);
      if (metric.format === 'percent') return `${(value.value * 100).toFixed(1)}%`;
      return value.value.toFixed(2);
    });
    lines.push(`  ${metric.label} (${metric.formula}): ${cells.join('  |  ')}`);
  }

  lines.push('');
  lines.push('ACCOUNTING IDENTITY CHECK');
  for (const check of statement.balanceChecks) {
    lines.push(`  ${check.periodId}: ${check.status} - ${check.message}`);
  }

  if (insights.length > 0) {
    lines.push('');
    lines.push('FINDINGS FROM THE RULE ENGINE (for reference - rewrite in your own words)');
    for (const insight of insights.slice(0, 10)) {
      lines.push(`  [${insight.kind}/${insight.severity}] ${insight.title}`);
    }
  }

  return lines.join('\n');
}

export interface NarrativeResult {
  summary: string;
  insights: Insight[];
}

export async function writeNarrative(
  statement: Statement,
  metrics: Metric[],
  ruleInsights: Insight[],
): Promise<NarrativeResult | null> {
  if (statement.lineItems.length === 0) return null;

  const raw = await callStructured({
    system: SYSTEM,
    prompt: buildDataBlock(statement, metrics, ruleInsights),
    toolName: 'submit_analysis',
    toolDescription: 'Return the written summary and the list of findings.',
    inputSchema: INPUT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2200,
  });
  if (!raw) return null;

  const validated = ResponseSchema.safeParse(raw);
  if (!validated.success) {
    console.warn('[llm] narrative returned an unusable shape; keeping the rule-engine version.');
    return null;
  }

  return {
    summary: validated.data.summary,
    insights: validated.data.insights.map((insight, position) => ({
      id: `llm-${position}`,
      kind: insight.kind,
      severity: insight.severity,
      title: insight.title,
      detail: insight.detail,
      // No evidence chips: the rule engine can name the metrics behind a
      // finding because it computed them, and pairing these by position would
      // attach citations the model never made.
      evidence: [],
    })),
  };
}
