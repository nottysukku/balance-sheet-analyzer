# Balance Sheet Analyzer

Upload a company balance sheet as **PDF or Excel**, and get back the structured
line items, the financial ratios computed from them, and a written analysis of
what they say about the business.

The reference document for this build is a **scanned, OCR'd Indian filing**
(LAJ Exports Limited, FY2024, 15 pages). That mattered more than anything else
for the design: the text layer is damaged, the table has no structure, and the
page is slightly skewed. Most of the interesting engineering is in reading it
correctly anyway.

---

## Quick start

```bash
npm install
npm run dev
```

Then open **http://localhost:5173** and click **"Try the bundled sample"**.

- API on `http://localhost:5174`, frontend on `http://localhost:5173`
- The Vite dev server proxies `/api` to the backend, so there is one origin and no CORS setup
- Requires **Node 20.11+**

No API key and no external service is required. Everything below works offline.

### Optional: Claude-assisted analysis

```bash
cp .env.example .env
# then set ANTHROPIC_API_KEY in .env
```

This enables two **additive** steps (see [Where Claude fits](#where-claude-fits)).
Without a key, the deterministic parser and the rule-based insight engine run on
their own and the UI says so.

### Other commands

```bash
npm test         # 90 tests, including end-to-end against the real scanned PDF
npm run build    # type-check and build both workspaces
npm run typecheck
npm start        # run the built API
```

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Backend | Node 20 + TypeScript + Express 4 | One language across the stack; one `npm install` |
| PDF | `pdfjs-dist` (text-content API) | Gives **x/y coordinates per text run** — essential, see below |
| Excel | `xlsx` (SheetJS) | `.xlsx` / `.xls` / `.xlsm` / `.csv` in one reader |
| Upload | `multer` (memory storage) | Nothing touches disk, so there is no temp file to leak |
| Validation | `zod` | Validates LLM output before it is trusted |
| Frontend | React 18 + Vite + TypeScript | — |
| Styling | Tailwind CSS | — |
| Charts | Recharts | — |
| Icons | lucide-react | — |
| Tests | Vitest | — |
| Optional LLM | `@anthropic-ai/sdk` (Claude Sonnet 5) | Strictly optional; never on the critical path |

**Third-party services: none required.** The only outbound call the app can
make is to the Anthropic API, and only when `ANTHROPIC_API_KEY` is set.

---

## Architecture

```
web/  React SPA ── POST /api/analyze (multipart) ──▶ server/

server/src/
  http/       upload guard, routes, error handling
  ingest/     pdf.ts · excel.ts  ──▶ one positioned-token model
  parse/      numbers · rows · align · classify · taxonomy · periods · balanceSheet
  analyze/    derive · ratios · insights
  llm/        client · extractAssist · narrative        (optional)
  domain/     the API contract
```

The pipeline is a chain of narrowing stages, each of which records where its
numbers came from:

```
ingest ─▶ parse ─▶ [LLM mapping assist] ─▶ derive totals ─▶ balance check
       ─▶ ratios ─▶ insights ─▶ [LLM narrative] ─▶ report
```

### The neutral document model

PDF and Excel both reduce to the same thing: a list of `{ text, x, y, width, height }`
tokens per page (`ingest/types.ts`). Excel synthesises coordinates from the
grid — column index becomes `x`, row index becomes a descending `y`. Everything
downstream is shared, so **adding a third input format means writing one
ingester and nothing else**.

### API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | Reports whether a Claude key is configured, and the upload limit. The UI uses this so the toggle reflects reality. |
| `POST` | `/api/analyze` | `multipart/form-data` with `file`, optional `useLlm=false`. Returns the full `AnalysisReport`. |

Errors are always `{ error: { code, message } }`. Codes are stable and the UI
maps several of them to a concrete next step (e.g. `NO_TEXT_LAYER` → "run OCR
on it first").

---

## Approach: extracting the data

A clean digital PDF would make this a twenty-line job. The sample is not one.
These are verbatim strings out of its text layer:

```
1,r7,68"77.414      5t,39,75,424       79,88,10,63 I
2t,35,t I,7 10      1.43.80.70.840     Shortterm borowings
Cuffent Investments Long-tcrm borrowings  Trade receivahles
```

Four problems had to be solved.

### 1. Rebuilding the table

A PDF has no table — only glyphs at coordinates. Rows are rebuilt by clustering
tokens on their baseline, with a tolerance scaled to the document's own median
line height rather than a hard-coded number of points.

Columns are found by clustering the **right edges** of tokens that parse as
amounts. Financial figures are right-aligned, so their right edges line up far
more cleanly than their left edges. Clusters with only one member are dropped,
which removes stray numbers embedded in prose.

### 2. Indian digit grouping and OCR damage (`parse/numbers.ts`)

Indian filings group as `1,17,68,77,414`, not `1,176,877,414`. The parser reads
both, and uses the grouping pattern as evidence that a token is a number at all.

On top of that, the scan turns separators into `.` `"` `-` `_` or spaces, and
digits into look-alike letters (`l`→1, `O`→0, `S`→5, `t`→1, `r`→1). The parser
repairs look-alikes **only in numeric context** — so `Total` never becomes
`1o1a1` — and **reports whether it had to**. A repaired figure carries lower
confidence and is flagged with an amber marker in the UI.

Deciding decimals needs care: `1.43.80.70.840` is an integer whose commas were
all scanned as dots, while `12,34,567.89` genuinely has paise. The rule is that
a trailing dot-separated group is a fraction only if it is one or two digits long.

Figures also arrive shattered across tokens (`["79,88,10,63", "I"]`); adjacent
numeric tokens are stitched when the gap between them is small enough that it
cannot span two columns.

### 3. Pairing captions with figures (`parse/align.ts`) — the important one

**This is where a naive implementation silently produces a wrong balance sheet.**

The sample page is slightly skewed, so the value columns on the right sit about
**seven points below** the caption they belong to. Matching each figure to its
nearest row therefore shifts every number up by one line: share capital's figure
lands on "Surplus", inventory's on "Trade receivables", and so on. Every total
still adds up and the balance sheet still balances — it is just wrong, and
nothing in the output would tell you.

Two observations make it solvable:

1. **A row containing only numbers is unambiguous.** A figure cannot exist
   without a caption, so it must belong to a caption above it. Those pairs give
   an unbiased estimate of the document's vertical offset — unlike rows carrying
   both text and numbers, which would bias the estimate toward zero. On the
   sample this yields an offset of exactly 7pt.
2. **Reading order is preserved.** A statement never prints item B's figure
   above item A's, so the assignment is a *monotonic* matching.

That is exactly what a Needleman–Wunsch style dynamic program solves optimally.
Each candidate pairing scores a Gaussian on the estimated offset, weighted by
how much the caption looks like a line item rather than a group heading; the DP
then finds the globally best ordered assignment instead of a greedy guess.

The extracted figures were verified by hand against the **note schedules on
pages 10–11** of the filing (Note 10 Investments, Note 11 Inventories, Note 12
Trade receivables, Note 13 Cash, Note 14 Loans and advances) — an independent
part of the document the parser does not read. `pipeline.test.ts` asserts every
one of those values, so a regression in alignment fails the build.

### 4. Reading damaged captions (`parse/classify.ts`)

Captions are matched against a canonical chart of accounts (`parse/taxonomy.ts`,
covering Schedule III plus IFRS/US-GAAP wording) using **approximate substring
matching (Sellers' algorithm) on a de-spaced string**.

De-spacing is what makes it work: `Shortterm borowings` has a lost space *and* a
dropped letter, and no word-by-word comparison survives that — but
`shorttermborowings` is one edit from `shorttermborrowings`.

Matching this loosely needs guard rails, and building it surfaced three real
traps, each now covered by a test:

- `other current liabilities` sits 3 edits from `non-current liabilities` and 4
  from `total current liabilities`. Tolerances are tight, an inexact match can
  never outrank an exact one, and every total concept excludes captions
  containing "other".
- Section headings are matched against the **whole** caption, not as a
  substring. Without that, `Other current liabilities` reads as a section
  heading and the line item vanishes from the statement entirely.
- Schedule III has no bare `ASSETS` banner — it prints `Non-current assets` and
  `Current assets` as group headings. Miss those and the section context stays
  stuck on "liabilities", after which `Short term loans and advances` (an asset)
  matches `term loans` (long-term debt).

---

## Approach: analysing the data

### Totals are computed, not trusted

Printed subtotals are the most damaged rows on a scan — the sample's grand total
survives as `1,r7,68"77.414`. So every roll-up is **derived from its components**.
A printed total is used only as a cross-check: if it agrees with the computed
one (within 2%) the figure gains confidence; if it disagrees, the components win
and the row is marked derived.

### The balance check is relative, not absolute

`Assets = Equity + Liabilities` is verified per period. One misread digit in the
sample shifts one side by ₹60,000 against a ₹117 crore balance sheet — that is
**0.005%**, an OCR artefact, not an accounting problem. Reporting it as an
imbalance would be misleading, so the tolerance is relative. The exact rupee
difference is always shown so the reader can judge for themselves.

### Metrics

Current Ratio, Quick Ratio, Cash Ratio, Working Capital, Total Debt, Net Worth,
Debt-to-Equity, Asset-to-Liability, Debt-to-Assets, Equity Ratio, and Inventory
Share of Current Assets.

Each card shows its formula and the actual numbers behind it. A metric whose
inputs are missing returns **null and renders as an em dash** — it is never
approximated, because a plausible-looking wrong ratio is worse than a visible gap.

### Insights

A rule engine over the computed figures. Each finding cites the metrics behind
it, is graded strength / concern / trend / observation with a severity, and is
sorted most-severe first. On the sample it surfaces, among others:

> **Liquidity rests on inventory: 62.8% of current assets.** Stripping it out
> drops the ratio from 2.65× to a quick ratio of 0.98×, meaning liabilities due
> within the year cannot be met without converting stock to cash first.

> **Total debt reduced 26.3% year on year**, from ₹76.45 Cr to ₹56.37 Cr.

---

## Where Claude fits

The LLM is deliberately kept off the critical path, in two narrow roles:

1. **Mapping assist** (`llm/extractAssist.ts`) — runs only when the parser left
   rows unmapped or confidence is low. The model **never sees the document and
   never produces a number**: the figures were already read off the page with
   their positions and confidences. It answers one question — *which concept
   does this caption mean?* — from a fixed enum. The parser wins every conflict,
   model-assigned labels are capped at 0.75 confidence, and each one is flagged
   in the UI.
2. **Narrative** (`llm/narrative.ts`) — given the computed figures and ratios,
   it writes the commentary. It is told not to recompute anything.

Both are schema-validated with Zod before use. If the key is absent, a call
fails, or the response does not validate, the deterministic result stands and
the response records that the assist did not run.

**Why this split:** an LLM is genuinely good at reading through OCR damage in
prose, and genuinely unreliable at arithmetic you cannot audit. So it names
things, and the code does the maths.

---

## Provenance

Every figure in the response carries where it came from:

```ts
{ value: 37362140, origin: 'extracted', confidence: 0.98,
  page: 1, sourceLabel: 'a) Share capital', rawText: '3,73,62,140',
  repaired: false }
```

The UI exposes all of it — hover any figure for its source caption, the raw text
as printed, its page, and its confidence. The markers mean:

| Marker | Meaning |
|---|---|
| Σ | computed from the rows above, not read from the page |
| ⚠ (amber) | digits were repaired after OCR damage — check this one |
| ✦ (violet) | caption matched with Claude's help |

---

## Handling bad input

| Case | Behaviour |
|---|---|
| Image-only PDF (no text layer) | 422 `NO_TEXT_LAYER`, with the advice to run OCR first |
| File renamed to `.pdf` | 422 `CORRUPT_PDF` — format is confirmed from magic bytes, not the extension or the MIME type |
| Corrupt or encrypted PDF | 422 `UNREADABLE_PDF` |
| Wrong file type | 415, rejected client-side first, re-checked server-side |
| Over the size limit | 400 `FILE_TOO_LARGE` (`MAX_UPLOAD_MB`, default 15) |
| Balance sheet found but sparse | Succeeds, with warnings and a lowered confidence badge |
| No line items readable | Succeeds with an explicit empty state rather than a crash |

The client validates before uploading so an obvious mistake costs a click rather
than a round trip; the server re-checks everything regardless.

---

## Tests

```bash
npm test
```

90 tests across six files:

- `numbers.test.ts` — Indian and Western grouping, parenthesised negatives,
  the decimal-vs-separator rule, and the OCR repairs, using strings taken
  verbatim from the sample
- `align.test.ts` — the skewed-page fixture, with the assertion that share
  capital's figure does **not** land on "Surplus"
- `classify.test.ts` — damaged captions, and the three confusion traps above
- `periods.test.ts` — column-header years, and the unit scale when a currency
  word sits between "in" and the unit ("in USD thousands")
- `analysis.test.ts` — roll-ups, printed-total override, the relative balance
  check, every ratio the brief asks for, and the insight rules
- `pipeline.test.ts` — end to end on the real 15-page scanned PDF, on a
  Schedule III workbook, and on a US-GAAP workbook stated in thousands whose
  figures are bare four-digit numbers

The suite runs entirely offline (`useLlm: false`), so it needs no API key.

---

## Notes and limitations

- **Two-column statements are the tested case.** The column detector handles
  more, but the sample only has two periods.
- **The unit scale is read from the header** ("in lakhs" / "in crores") and
  figures are normalised to absolute currency; everything downstream works in
  one unit and compaction happens only at display time.
- **Scanned pages without a text layer are rejected, not OCR'd.** Bundling an
  OCR engine is a much larger dependency; the error explains how to produce one.
- **`web/src/types.ts` is a copy of the server's domain types.** A shared
  package would be tidier; for a two-workspace project the copy keeps install
  and build simple, and the pipeline tests guard the shape.
- Figures extracted from scans can be wrong. The UI says so, shows its
  confidence, and links every number back to what it read.
