import type { ConceptSection } from '../domain/types.js';
import { CONCEPTS, type ConceptDefinition } from './taxonomy.js';

/**
 * Maps a document label onto a canonical concept.
 *
 * Matching happens on a de-spaced, lower-cased string using approximate
 * substring search (Sellers' algorithm). Working without spaces is what lets
 * "Shortterm borowings" and "Long-tcrm borrowings" resolve correctly - a
 * word-by-word comparison would fail on both, because OCR merged a space in
 * the first and corrupted a letter in the second.
 */

/** Letter substitutions OCR makes inside words, applied before matching. */
const WORD_REPAIRS: [RegExp, string][] = [
  [/\brn\b/g, 'm'],
  [/æ/g, 'ae'],
  [/[‘’“”]/g, ''],
];

/** Leading enumeration markers: "a)", "(i)", "1.", "B.", "-", "*". */
const LEADING_MARKER = /^[\s(\[]*(?:[0-9]{1,2}|[a-zA-Z]|[ivxIVX]{1,4})[).\]:-]+\s*/;

export function normalizeLabel(raw: string): string {
  let s = raw.toLowerCase();
  for (const [pattern, replacement] of WORD_REPAIRS) s = s.replace(pattern, replacement);
  // Strip footnote/asterisk markers and note references.
  s = s.replace(/\*+/g, ' ').replace(/\bnote\s*no\.?\s*\d*/g, ' ');
  // Drop a wrapping bracket so "(DIRECTOR)" reads as plain text.
  s = s.replace(/^\((.*)\)$/, '$1').trim();
  // Remove enumeration markers, possibly stacked ("1) a) ...").
  let previous: string;
  do {
    previous = s;
    s = s.replace(LEADING_MARKER, '');
  } while (s !== previous && s.length > 0);
  return s.replace(/\s+/g, ' ').trim();
}

/** Collapse to letters and digits only - the form synonyms are written in. */
export function despace(s: string): string {
  return s.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Minimum edit distance between `needle` and any substring of `haystack`
 * (Sellers' variant of Levenshtein: free start and end positions).
 */
export function approxSubstringDistance(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  if (haystack.length === 0) return needle.length;

  // row[j] = distance between needle[0..j) and the best substring of the
  // haystack ending at the current position.
  let row = new Array<number>(needle.length + 1);
  for (let j = 0; j <= needle.length; j++) row[j] = j;
  let next = new Array<number>(needle.length + 1);

  let best = row[needle.length]!;

  for (let i = 1; i <= haystack.length; i++) {
    next[0] = 0; // free start: a match may begin at any position
    for (let j = 1; j <= needle.length; j++) {
      const cost = haystack[i - 1] === needle[j - 1] ? 0 : 1;
      next[j] = Math.min(
        row[j]! + 1, // skip a haystack character
        next[j - 1]! + 1, // skip a needle character
        row[j - 1]! + cost, // substitute
      );
    }
    best = Math.min(best, next[needle.length]!);
    const swap = row;
    row = next;
    next = swap;
  }
  return best;
}

/**
 * How many edits a synonym of this length may absorb and still count.
 *
 * Kept tight on purpose. At 20% of length, a 22-character synonym tolerates
 * four edits - enough for "total current liabilities" to swallow "other
 * current liabilities", which differ only in their first word.
 */
function tolerance(length: number): number {
  if (length <= 6) return 1;
  if (length <= 12) return 2;
  return Math.max(2, Math.floor(length * 0.15));
}

export interface ClassificationResult {
  concept: ConceptDefinition;
  /** 0..1 */
  score: number;
  matchedSynonym: string;
  /** Edit distance between the synonym and the label region it matched. */
  distance: number;
}

export interface ClassifyOptions {
  /** Which part of the statement we are currently reading, if known. */
  section?: ConceptSection | null;
  /** Reject matches below this score. */
  minScore?: number;
}

/**
 * Score one concept against a de-spaced label. Returns null when no synonym is
 * close enough, or when an exclusion term is present.
 */
function scoreConcept(
  concept: ConceptDefinition,
  despaced: string,
  section: ConceptSection | null | undefined,
): ClassificationResult | null {
  for (const term of concept.exclude ?? []) {
    if (despaced.includes(despace(term))) return null;
  }

  let best: ClassificationResult | null = null;
  for (const synonym of concept.synonyms) {
    const allowed = tolerance(synonym.length);
    const distance = approxSubstringDistance(despaced, synonym);
    if (distance > allowed) continue;

    // Exactness of the synonym match. The multiplier makes the penalty steep
    // enough that a near-miss can never edge out an exact hit: without it,
    // "other current liabilities" scores within a hair of the 26-character
    // "other non-current liabilities" and the tie-break decides the concept.
    let score = Math.max(0, 1 - (distance * 1.6) / (synonym.length || 1));
    // Longer synonyms are stronger evidence than a 4-letter catch-all.
    score *= 0.6 + 0.4 * Math.min(1, synonym.length / 18);
    // A synonym covering most of the label beats one buried in a long string.
    score *= 0.55 + 0.45 * Math.min(1, synonym.length / Math.max(despaced.length, 1));
    // Section agreement is a meaningful prior, not a hard filter: a scan may
    // lose the section header entirely.
    if (section) score *= concept.section === section ? 1.12 : 0.62;

    score = Math.max(0, Math.min(1, score));
    if (!best || score > best.score) best = { concept, score, matchedSynonym: synonym, distance };
  }
  return best;
}

/** Best concept for a label, or null if nothing matched convincingly. */
export function classifyLabel(
  rawLabel: string,
  options: ClassifyOptions = {},
): ClassificationResult | null {
  const normalized = normalizeLabel(rawLabel);
  if (normalized.length < 3) return null;
  const despaced = despace(normalized);
  if (despaced.length < 3) return null;

  const minScore = options.minScore ?? 0.42;
  const candidates: ClassificationResult[] = [];

  for (const concept of CONCEPTS) {
    const result = scoreConcept(concept, despaced, options.section);
    if (result && result.score >= minScore) candidates.push(result);
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // Prefer the more specific concept when scores are close, so
    // "total current assets" does not settle for "current assets".
    if (Math.abs(a.score - b.score) > 0.08) return b.score - a.score;
    if (a.concept.specificity !== b.concept.specificity) {
      return b.concept.specificity - a.concept.specificity;
    }
    // Prefer the synonym that matched more exactly before preferring the
    // longer one - a near-miss should never beat a clean hit.
    if (a.distance !== b.distance) return a.distance - b.distance;
    return b.matchedSynonym.length - a.matchedSynonym.length;
  });

  return candidates[0]!;
}

/* --------------------------- section detection --------------------------- */

/**
 * Ordered most specific first. Schedule III does not print a bare "ASSETS"
 * banner - it prints "Non-current assets" and "Current assets" as the group
 * headings - so those have to be recognised too, or the section context stays
 * stuck on whatever the last banner said and every asset caption is scored
 * against the wrong prior.
 */
const SECTION_MARKERS: { section: ConceptSection; patterns: string[] }[] = [
  {
    section: 'liabilities',
    patterns: ['equityandliabilities', 'liabilitiesandequity', 'equityliabilities'],
  },
  { section: 'assets', patterns: ['noncurrentassets', 'currentassets'] },
  { section: 'liabilities', patterns: ['noncurrentliabilities', 'currentliabilities'] },
  { section: 'equity', patterns: ['shareholdersfunds', 'stockholdersequity'] },
  { section: 'assets', patterns: ['assets'] },
  { section: 'liabilities', patterns: ['liabilities'] },
  { section: 'equity', patterns: ['equity'] },
];

/** Plain Levenshtein distance between two whole strings. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  let next = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + cost);
    }
    const swap = row;
    row = next;
    next = swap;
  }
  return row[b.length]!;
}

/**
 * Headings are printed exactly, so they are matched against the *whole* label
 * with a tight budget. Approximate substring matching is far too permissive
 * here: "other current liabilities" sits only three edits from the marker
 * "non-current liabilities", and treating that row as a heading silently drops
 * a real line item from the statement.
 */
const HEADER_EDIT_BUDGET = 2;

/**
 * Detect a section heading such as "EQUITY AND LIABILITIES", "Current assets"
 * or "ASSETS". Returns null for anything that is a line item.
 */
export function detectSectionHeader(rawLabel: string): ConceptSection | null {
  const normalized = normalizeLabel(rawLabel);
  if (normalized.length === 0 || normalized.length > 34) return null;
  const despaced = despace(normalized);
  if (despaced.length < 5) return null;
  // A roll-up row is a line item even when it reads like a heading.
  if (despaced.startsWith('total')) return null;

  for (const { section, patterns } of SECTION_MARKERS) {
    for (const pattern of patterns) {
      const budget = Math.min(HEADER_EDIT_BUDGET, tolerance(pattern.length));
      if (editDistance(despaced, pattern) <= budget) return section;
    }
  }
  return null;
}
