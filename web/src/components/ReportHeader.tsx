import clsx from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  Info,
  Scale,
  Sparkles,
} from 'lucide-react';
import type { AnalysisReport, BalanceCheck } from '../types';
import { formatDuration, formatExact, formatFileSize } from '../lib/format';

interface Props {
  report: AnalysisReport;
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone =
    pct >= 80
      ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
      : pct >= 60
        ? 'bg-amber-50 text-amber-800 ring-amber-200'
        : 'bg-rose-50 text-rose-800 ring-rose-200';
  const wording = pct >= 80 ? 'High' : pct >= 60 ? 'Moderate' : 'Low';

  return (
    <span
      className={clsx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1', tone)}
      title="Mean confidence across every extracted figure, combining caption match quality, row alignment and how cleanly the digits parsed."
    >
      {wording} confidence &middot; {pct}%
    </span>
  );
}

const CHECK_TONE: Record<BalanceCheck['status'], string> = {
  balanced: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  'minor-variance': 'border-amber-200 bg-amber-50 text-amber-900',
  imbalanced: 'border-rose-200 bg-rose-50 text-rose-900',
  'insufficient-data': 'border-ink-200 bg-ink-50 text-ink-700',
};

function BalanceCheckRow({ check, label, currency }: { check: BalanceCheck; label: string; currency: string }) {
  const Icon = check.status === 'balanced' ? CheckCircle2 : check.status === 'insufficient-data' ? Info : AlertTriangle;

  return (
    <div className={clsx('flex gap-2.5 rounded-lg border px-3.5 py-3', CHECK_TONE[check.status])}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 text-sm">
        <p className="font-semibold">{label}</p>
        <p className="mt-0.5 opacity-90">{check.message}</p>
        {check.totalAssets !== null && check.totalEquityAndLiabilities !== null && (
          <p className="tnum mt-1.5 font-mono text-[11px] opacity-75">
            Assets {formatExact(check.totalAssets, currency)} &middot; Equity + Liabilities{' '}
            {formatExact(check.totalEquityAndLiabilities, currency)}
            {check.difference !== null && check.difference !== 0 && (
              <> &middot; difference {formatExact(check.difference, currency)}</>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

export function ReportHeader({ report }: Props) {
  const { company, periods, balanceChecks } = report.statement;
  const currency = company.currency ?? 'INR';
  const { source } = report;

  const periodLabel = (id: string) => periods.find((p) => p.id === id)?.label ?? id;

  return (
    <section className="card card-pad animate-fade-up">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight text-ink-900">
            {company.name ?? 'Balance sheet'}
          </h2>
          <p className="mt-1 text-sm text-ink-600">
            {company.statementTitle ?? 'Extracted balance sheet'}
          </p>
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-xs text-ink-600">
            {company.cin && (
              <div className="flex gap-1.5">
                <dt className="font-medium text-ink-500">CIN</dt>
                <dd className="font-mono">{company.cin}</dd>
              </div>
            )}
            <div className="flex gap-1.5">
              <dt className="font-medium text-ink-500">Periods</dt>
              <dd>{periods.map((p) => p.label).join('  •  ')}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="font-medium text-ink-500">Currency</dt>
              <dd>
                {currency}
                {company.unitScale && company.unitScale !== 1
                  ? ` (stated in ${company.unitLabel?.toLowerCase()}s)`
                  : ''}
              </dd>
            </div>
          </dl>
        </div>

        <ConfidenceBadge value={report.extractionConfidence} />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-200 pt-4 text-xs text-ink-500">
        <span className="inline-flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          {source.fileName} &middot; {formatFileSize(source.fileSize)}
          {source.pageCount ? ` · ${source.pageCount} pages` : ''}
          {source.sheetNames?.length ? ` · ${source.sheetNames.length} sheet(s)` : ''}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" aria-hidden />
          Analysed in {formatDuration(source.durationMs)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          {source.llmAssist.narrative || source.llmAssist.extraction
            ? `Claude assist: ${[
                source.llmAssist.extraction ? 'row mapping' : null,
                source.llmAssist.narrative ? 'written analysis' : null,
              ]
                .filter(Boolean)
                .join(' + ')} (${source.llmAssist.model})`
            : 'Deterministic pipeline only'}
        </span>
      </div>

      <div className="mt-5">
        <h3 className="label-caps flex items-center gap-1.5">
          <Scale className="h-3.5 w-3.5" aria-hidden />
          Accounting identity check
        </h3>
        <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
          {balanceChecks.map((check) => (
            <BalanceCheckRow
              key={check.periodId}
              check={check}
              label={periodLabel(check.periodId)}
              currency={currency}
            />
          ))}
        </div>
      </div>

      {report.warnings.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {report.warnings.map((warning, index) => (
            <li
              key={`${warning.code}-${index}`}
              className={clsx(
                'flex gap-2 rounded-md px-3 py-2 text-xs',
                warning.severity === 'error'
                  ? 'bg-rose-50 text-rose-800'
                  : warning.severity === 'warning'
                    ? 'bg-amber-50 text-amber-800'
                    : 'bg-ink-100 text-ink-600',
              )}
            >
              <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{warning.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
