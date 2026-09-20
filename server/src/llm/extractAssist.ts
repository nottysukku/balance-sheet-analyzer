import { z } from 'zod';
import type { ConceptId, ExtractedValue, LineItem } from '../domain/types.js';
import type { ParsedStatement } from '../parse/balanceSheet.js';
import { CONCEPTS, CONCEPTS_BY_ID, CONCEPT_ORDER } from '../parse/taxonomy.js';
import { callStructured } from './client.js';

/**
 * Claude-assisted mapping for rows the deterministic parser could not name.
 *
 * Scope is deliberately narrow. The model never sees the document and never
 * produces numbers - the figures have already been read off the page by the
 * parser, with their positions and confidences. All it does is answer one
 * question: "which canonical concept does this caption mean?" That keeps the
 * arithmetic verifiable and stops a hallucinated figure reaching the report.
 */

const CONCEPT_IDS = CONCEPT_ORDER as readonly string[];

const ResponseSchema = z.object({
  mappings: z
    .array(
      z.object({
        rowIndex: z.number().int().min(0),
        concept: z.string().refine((c) => CONCEPT_IDS.includes(c), 'unknown concept'),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(40),
});

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    mappings: {
      type: 'array',
      description: 'One entry per row you can confidently map. Omit rows you are unsure about.',
      items: {
        type: 'object',
        properties: {
          rowIndex: { type: 'integer', description: 'The index given with the row.' },
          concept: { type: 'string', enum: [...CONCEPT_IDS], description: 'Canonical concept id.' },
          confidence: { type: 'number', description: '0 to 1.' },
        },
        required: ['rowIndex', 'concept', 'confidence'],
      },
    },
  },
  required: ['mappings'],
} as const;

const SYSTEM = `You classify line-item captions from company balance sheets onto a fixed set of concept ids.

The captions come from OCR of scanned filings, so they contain typos, merged words and dropped letters. Read through the damage.
The filings follow Schedule III of the Indian Companies Act, IFRS, or US GAAP.

Rules:
- Only use concept ids from the provided enum.
- Map a row only when the caption clearly means that concept. Omit anything doubtful; a missing row is far better than a wrong one.
- Do not map sub-items, note references, headings, signatures or totals that are already listed as extracted.
- Never invent or alter figures. You are only naming rows.`;

interface AssistOutcome {
  lineItems: LineItem[];
  applied: number;
}

/**
 * Ask the model to name the unmapped rows, then merge anything it returns that
 * validates and does not collide with a concept the parser already found.
 */
export async function assistExtraction(parsed: ParsedStatement): Promise<AssistOutcome> {
  const rows = parsed.unmappedRows.filter((row) => row.values.length > 0);
  if (rows.length === 0) return { lineItems: parsed.statement.lineItems, applied: 0 };

  const alreadyFound = new Set(parsed.statement.lineItems.map((item) => item.concept));
  const available = CONCEPTS.filter((concept) => !alreadyFound.has(concept.id));
  if (available.length === 0) return { lineItems: parsed.statement.lineItems, applied: 0 };

  const rowLines = rows
    .map(
      (row, index) =>
        `${index}. "${row.label}" -> ${row.values
          .map((v) => `${v.periodId}: ${v.value.toLocaleString('en-IN')}`)
          .join(', ')}`,
    )
    .join('\n');

  const alreadyText =
    alreadyFound.size > 0
      ? [...alreadyFound].map((id) => CONCEPTS_BY_ID.get(id)?.label ?? id).join(', ')
      : 'none';

  const prompt = `Already extracted by the parser (do not re-map these): ${alreadyText}

Unmapped rows:
${rowLines}

Map only the rows that are genuine balance-sheet line items.`;

  const raw = await callStructured({
    system: SYSTEM,
    prompt,
    toolName: 'submit_mappings',
    toolDescription: 'Return the caption-to-concept mappings you are confident about.',
    inputSchema: INPUT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1500,
  });
  if (!raw) return { lineItems: parsed.statement.lineItems, applied: 0 };

  const validated = ResponseSchema.safeParse(raw);
  if (!validated.success) {
    console.warn('[llm] extraction assist returned an unusable shape; ignoring it.');
    return { lineItems: parsed.statement.lineItems, applied: 0 };
  }

  const lineItems = [...parsed.statement.lineItems];
  const claimed = new Set(alreadyFound);
  let applied = 0;

  for (const mapping of validated.data.mappings) {
    const row = rows[mapping.rowIndex];
    if (!row) continue;
    const conceptId = mapping.concept as ConceptId;
    // The parser wins every conflict; the model only fills genuine gaps.
    if (claimed.has(conceptId)) continue;
    const definition = CONCEPTS_BY_ID.get(conceptId);
    if (!definition) continue;
    if (mapping.confidence < 0.6) continue;

    const values: Record<string, ExtractedValue> = {};
    row.values.forEach(({ periodId, value }) => {
      values[periodId] = {
        value,
        origin: 'llm',
        // Capped: a model-assigned label is weaker evidence than a parsed one.
        confidence: Math.min(0.75, mapping.confidence),
        page: row.page,
        sourceLabel: row.label,
      };
    });
    if (Object.keys(values).length === 0) continue;

    lineItems.push({
      concept: conceptId,
      label: definition.label,
      section: definition.section,
      group: definition.group,
      isTotal: definition.isTotal,
      values,
    });
    claimed.add(conceptId);
    applied += 1;
  }

  const order = new Map(CONCEPT_ORDER.map((id, index) => [id, index]));
  lineItems.sort((a, b) => (order.get(a.concept) ?? 999) - (order.get(b.concept) ?? 999));

  return { lineItems, applied };
}
