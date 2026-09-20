import { useState } from 'react';
import clsx from 'clsx';
import { Eye, EyeOff, Sigma, Sparkles, TriangleAlert } from 'lucide-react';
import type { ConceptGroup, ExtractedValue, LineItem, Statement } from '../types';
import { formatExact, formatMoney } from '../lib/format';

const GROUP_ORDER: ConceptGroup[] = [
  'equity',
  'nonCurrentLiabilities',
  'currentLiabilities',
  'nonCurrentAssets',
  'currentAssets',
  'totals',
];

const GROUP_LABELS: Record<ConceptGroup, string> = {
  equity: 'Shareholders’ Funds',
  nonCurrentLiabilities: 'Non-current Liabilities',
  currentLiabilities: 'Current Liabilities',
  nonCurrentAssets: 'Non-current Assets',
  currentAssets: 'Current Assets',
  totals: 'Balance Sheet Totals',
};

/** A small marker explaining where a figure came from. */
function OriginMark({ value }: { value: ExtractedValue }) {
  if (value.origin === 'derived') {
    return (
      <Sigma
        className="h-3 w-3 text-ink-400"
        aria-label="Computed by summing the line items above"
      />
    );
  }
  if (value.origin === 'llm') {
    return (
      <Sparkles className="h-3 w-3 text-violet-500" aria-label="Caption matched with Claude's help" />
    );
  }
  if (value.repaired) {
    return (
      <TriangleAlert
        className="h-3 w-3 text-amber-500"
        aria-label="Digits were repaired after OCR damage"
      />
    );
  }
  return null;
}

function cellTitle(value: ExtractedValue, currency: string): string {
  const lines = [formatExact(value.value, currency)];
  if (value.sourceLabel) lines.push(`Caption: "${value.sourceLabel}"`);
  if (value.rawText) lines.push(`As printed: ${value.rawText}`);
  if (value.page) lines.push(`Page ${value.page}`);
  lines.push(
    `Source: ${
      value.origin === 'derived' ? 'computed' : value.origin === 'llm' ? 'Claude-assisted' : 'read from document'
    } · confidence ${Math.round(value.confidence * 100)}%`,
  );
  if (value.repaired) lines.push('Digits were repaired after OCR damage.');
  return lines.join('\n');
}

interface Props {
  statement: Statement;
}

export function StatementTable({ statement }: Props) {
  const [showProvenance, setShowProvenance] = useState(false);
  const { periods, lineItems } = statement;
  const currency = statement.company.currency ?? 'INR';

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    items: lineItems.filter((item) => item.group === group),
  })).filter((section) => section.items.length > 0);

  if (lineItems.length === 0) {
    return (
      <section className="card card-pad">
        <h2 className="text-base font-semibold text-ink-900">Extracted balance sheet</h2>
        <p className="mt-2 text-sm text-ink-600">No line items could be read from this document.</p>
      </section>
    );
  }

  return (
    <section className="card animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-5 py-4 sm:px-6">
        <div>
          <h2 className="text-base font-semibold text-ink-900">Extracted balance sheet</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Hover any figure to see the caption it came from and how it was read.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowProvenance((previous) => !previous)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-100"
          aria-pressed={showProvenance}
        >
          {showProvenance ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
          {showProvenance ? 'Hide source captions' : 'Show source captions'}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <caption className="sr-only">
            Balance sheet line items for {periods.map((p) => p.label).join(' and ')}
          </caption>
          <thead>
            <tr className="border-b border-ink-200 bg-ink-50/70">
              <th scope="col" className="px-5 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-500 sm:px-6">
                Particulars
              </th>
              {periods.map((period) => (
                <th
                  key={period.id}
                  scope="col"
                  className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-ink-500 sm:px-6"
                >
                  {period.label}
                </th>
              ))}
            </tr>
          </thead>

          {grouped.map((section) => (
            <tbody key={section.group}>
              <tr className="bg-ink-50/40">
                <th
                  scope="colgroup"
                  colSpan={periods.length + 1}
                  className="px-5 pb-1.5 pt-4 text-left text-[11px] font-bold uppercase tracking-wider text-ink-500 sm:px-6"
                >
                  {GROUP_LABELS[section.group]}
                </th>
              </tr>
              {section.items.map((item: LineItem) => (
                <tr
                  key={item.concept}
                  className={clsx(
                    'border-b border-ink-100 last:border-0',
                    item.isTotal ? 'bg-ink-50/60 font-semibold' : 'hover:bg-teal-50/40',
                  )}
                >
                  <th
                    scope="row"
                    className={clsx(
                      'px-5 py-2.5 text-left font-normal sm:px-6',
                      item.isTotal ? 'font-semibold text-ink-900' : 'text-ink-700',
                    )}
                  >
                    {item.label}
                    {showProvenance && (
                      <span className="mt-0.5 block truncate text-[11px] font-normal italic text-ink-400">
                        {Object.values(item.values)[0]?.sourceLabel ?? 'computed'}
                      </span>
                    )}
                  </th>
                  {periods.map((period) => {
                    const value = item.values[period.id];
                    return (
                      <td
                        key={period.id}
                        className="tnum whitespace-nowrap px-4 py-2.5 text-right font-mono text-[13px] text-ink-900 sm:px-6"
                        title={value ? cellTitle(value, currency) : undefined}
                      >
                        {value ? (
                          <span className="inline-flex items-center justify-end gap-1.5">
                            <OriginMark value={value} />
                            {formatMoney(value.value, currency)}
                          </span>
                        ) : (
                          <span className="text-ink-300">&mdash;</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-ink-200 px-5 py-3 text-[11px] text-ink-500 sm:px-6">
        <span className="inline-flex items-center gap-1.5">
          <Sigma className="h-3 w-3 text-ink-400" aria-hidden /> computed from the rows above
        </span>
        <span className="inline-flex items-center gap-1.5">
          <TriangleAlert className="h-3 w-3 text-amber-500" aria-hidden /> digits repaired after OCR damage
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="h-3 w-3 text-violet-500" aria-hidden /> caption matched with Claude&rsquo;s help
        </span>
      </div>
    </section>
  );
}
