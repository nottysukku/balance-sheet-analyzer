/**
 * Amount parsing for financial documents.
 *
 * Two problems this has to solve at once:
 *
 *  1. **Indian digit grouping.** Statements filed in India group as
 *     `1,17,68,77,414` (a final group of 3, then 2s) rather than
 *     `1,176,877,414`. Both have to parse, and the grouping style is also a
 *     useful signal that a token really is a number.
 *
 *  2. **OCR damage.** The reference document is a scan, so separators come
 *     back as `.` `"` `-` `_` or spaces, and digits get swapped for
 *     look-alike letters. Examples taken verbatim from the sample PDF:
 *         1,r7,68"77.414     5t,39,75,424     79,88,10,63 I     1.43.80.70.840
 *
 * The parser repairs what it can and reports whether it had to, so the UI can
 * surface a lower confidence instead of presenting a guess as fact.
 */

export interface ParsedAmount {
  value: number;
  /** 0..1 - drops when we had to repair characters or the grouping is odd. */
  confidence: number;
  /** True when OCR repair altered the digits. */
  repaired: boolean;
  /** The input, untouched. */
  raw: string;
}

/** Characters OCR commonly substitutes for digits, in numeric context. */
const DIGIT_REPAIRS: Record<string, string> = {
  l: '1', I: '1', i: '1', '|': '1', '!': '1', t: '1', T: '1', r: '1',
  O: '0', o: '0', Q: '0', D: '0',
  S: '5', s: '5',
  B: '8',
  Z: '2', z: '2',
  g: '9', q: '9',
  b: '6', G: '6',
};

/** Characters that can stand in for a thousands/lakhs separator after a scan. */
const SEPARATOR_CHARS = [',', '.', "'", '"', '_', '-', '–', '—', ' ', ' ', ';', ':', 'J'];
const SEPARATORS = new Set(SEPARATOR_CHARS);

/** Character class matching any separator, for use inside regexes. */
const SEP_CLASS = String.raw`,.'"_;:J  –—-`;
const SPLIT_RE = new RegExp(`[${SEP_CLASS}]+`);
const LAST_SEP_RE = new RegExp(`[${SEP_CLASS}](?=[^${SEP_CLASS}]*$)`);
const NON_NUMERIC_RE = new RegExp(`[^0-9${SEP_CLASS}]`);
const NUMERICISH_RE = new RegExp(`^[()+-]?[0-9lIioOQDSsBZzgqbGtTr|!${SEP_CLASS}]+[()%]?$`);

const CURRENCY_NOISE = /[₹$€£]|(?:^|\s)(?:rs\.?|inr|usd|eur)(?=\s|$)/gi;

/**
 * True if a token is plausibly a monetary amount rather than a note number, a
 * year, or prose. Deliberately strict: a lone `2024` or `12` is not an amount,
 * because balance sheets are full of note references and serial numbers that
 * would otherwise pollute the value columns.
 */
export function looksLikeAmount(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  if (!/[0-9]/.test(t)) return false;
  if (!NUMERICISH_RE.test(t)) return false;

  const bare = t.replace(/[^0-9]/g, '');
  if (bare.length < 2) return false;

  // Bare 1-4 digit runs with no separator are serial/note/year references.
  const hasSeparator = [...t].some((c) => SEPARATORS.has(c));
  if (!hasSeparator && bare.length <= 4 && !/[()]/.test(t)) return false;
  return true;
}

/** Score how well digit groups match Indian (2,2,...,3) or Western (3,3,...) style. */
function groupingQuality(groups: string[]): number {
  if (groups.length <= 1) return 0.85;
  const head = groups[0]!;
  const tail = groups.slice(1);
  const last = tail[tail.length - 1]!;

  const western = tail.every((g) => g.length === 3) && head.length >= 1 && head.length <= 3;
  if (western) return 1;

  const indian =
    last.length === 3 &&
    tail.slice(0, -1).every((g) => g.length === 2) &&
    head.length >= 1 &&
    head.length <= 2;
  if (indian) return 1;

  // Consistent but unusual grouping - accept with a haircut.
  if (tail.every((g) => g.length === tail[0]!.length)) return 0.7;
  return 0.45;
}

/** Parse one token into a number. Returns null when it is not an amount. */
export function parseAmount(input: string): ParsedAmount | null {
  const raw = input;
  let s = input.trim();
  if (!s) return null;

  s = s.replace(CURRENCY_NOISE, ' ').trim();

  // Sign: accounting parentheses, or a leading/trailing dash.
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  } else if (/^\(/.test(s) || /\)$/.test(s)) {
    // Half a bracket survived the scan - still a negative.
    negative = true;
    s = s.replace(/[()]/g, '');
  }
  s = s.trim();

  if (/^[-–—]/.test(s)) {
    negative = true;
    s = s.slice(1);
  } else if (/[-–—]$/.test(s) && /[0-9]/.test(s)) {
    negative = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/%$/, '').trim();
  if (!s) return null;

  // Repair digit look-alikes, but only where the character sits in numeric
  // company - we must not turn the word "Total" into "1o1a1".
  let repaired = false;
  const chars = [...s];
  const isDigit = (c: string | undefined) => !!c && c >= '0' && c <= '9';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (!(c in DIGIT_REPAIRS)) continue;
    const prev = chars[i - 1];
    const next = chars[i + 1];
    const nearDigit =
      isDigit(prev) ||
      isDigit(next) ||
      (prev !== undefined && SEPARATORS.has(prev)) ||
      (next !== undefined && SEPARATORS.has(next));
    if (nearDigit) {
      chars[i] = DIGIT_REPAIRS[c]!;
      repaired = true;
    }
  }
  s = chars.join('');

  // Anything left that is neither digit nor separator means this was prose.
  if (NON_NUMERIC_RE.test(s)) return null;
  if (!/[0-9]/.test(s)) return null;

  // Split on every separator; empty segments come from doubled separators
  // (".." from a smudged comma) and are dropped.
  const segments = s.split(SPLIT_RE).filter((seg) => seg.length > 0);
  if (segments.length === 0) return null;

  // Decide whether the final segment is a decimal fraction rather than a digit
  // group. It only is when the separator before it was a dot AND it is 1-2
  // digits long. "1.43.80.70.840" (every separator scanned as a dot) therefore
  // stays an integer, while "12,34,567.89" keeps its paise.
  const lastSep = s.match(LAST_SEP_RE)?.[0];
  const tail = segments[segments.length - 1]!;
  const isDecimalTail = segments.length > 1 && lastSep === '.' && tail.length <= 2;

  const intSegments = isDecimalTail ? segments.slice(0, -1) : segments;
  if (intSegments.length === 0) return null;

  const digits = intSegments.join('');
  if (!/^[0-9]+$/.test(digits)) return null;
  if (digits.length > 18) return null; // absurd - almost certainly junk

  let value = Number(digits);
  if (!Number.isFinite(value)) return null;
  if (isDecimalTail) value += Number(tail) / 10 ** tail.length;
  if (negative) value = -value;

  let confidence = groupingQuality(intSegments);
  if (repaired) confidence *= 0.8;
  // Mixed separator characters inside one token signals a rough scan.
  const sepChars = new Set([...s].filter((c) => SEPARATORS.has(c)));
  if (sepChars.size > 1) confidence *= 0.85;

  return { value, confidence: Math.max(0.2, Math.min(1, confidence)), repaired, raw };
}

export interface StitchableToken {
  text: string;
  x: number;
  width: number;
}

export interface StitchedToken<T> {
  text: string;
  x: number;
  width: number;
  parts: T[];
}

/**
 * Amounts frequently arrive shattered across tokens because the scan broke a
 * glyph: `["79,88,10,63", "I"]` or `["2t,35,t", "I,7", "10"]`. Given tokens
 * sorted left-to-right, stitch neighbours that sit close enough together to be
 * one printed figure.
 */
export function stitchNumericTokens<T extends StitchableToken>(
  tokens: T[],
  maxGap = 4,
): StitchedToken<T>[] {
  const out: StitchedToken<T>[] = [];
  let current: StitchedToken<T> | null = null;

  for (const tok of tokens) {
    const text = tok.text.trim();
    if (!text) continue;

    if (!NUMERICISH_RE.test(text)) {
      if (current) out.push(current);
      current = null;
      continue;
    }

    if (current) {
      const gap = tok.x - (current.x + current.width);
      if (gap <= maxGap) {
        current.text += text;
        current.width = tok.x + tok.width - current.x;
        current.parts.push(tok);
        continue;
      }
      out.push(current);
    }
    current = { text, x: tok.x, width: tok.width, parts: [tok] };
  }
  if (current) out.push(current);
  return out;
}

/** Compact currency formatting used in server-generated narrative text. */
export function formatIndianCurrency(value: number, symbol = '₹'): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${symbol}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${symbol}${(abs / 1e5).toFixed(2)} L`;
  return `${sign}${symbol}${Math.round(abs).toLocaleString('en-IN')}`;
}
