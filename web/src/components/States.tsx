import { AlertTriangle, FileSearch, RefreshCw } from 'lucide-react';

/** Shown before anything has been uploaded. */
export function EmptyState() {
  const steps = [
    { title: 'Upload', body: 'A PDF or Excel balance sheet, including a scanned filing.' },
    { title: 'Extract', body: 'Line items are located by page geometry and matched to a standard chart of accounts.' },
    { title: 'Analyse', body: 'Ratios, an accounting-identity check and written findings.' },
  ];

  return (
    <div className="card card-pad text-center">
      <FileSearch className="mx-auto h-10 w-10 text-ink-300" aria-hidden />
      <h2 className="mt-4 text-lg font-semibold text-ink-900">No balance sheet loaded yet</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-600">
        Upload a document above to see the extracted figures, the ratios computed from them, and what
        they say about the company.
      </p>

      <ol className="mx-auto mt-7 grid max-w-3xl gap-4 text-left sm:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="rounded-lg border border-ink-200 bg-ink-50/70 p-4">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-teal-700 text-xs font-bold text-white">
              {index + 1}
            </span>
            <p className="mt-2.5 text-sm font-semibold text-ink-900">{step.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-600">{step.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

interface ErrorStateProps {
  code: string;
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ code, message, onRetry }: ErrorStateProps) {
  /** Practical next steps for the failures a user can actually fix. */
  const HINTS: Record<string, string> = {
    NO_TEXT_LAYER:
      'The page is an image with no text behind it. Run it through an OCR tool (Adobe Acrobat, or `ocrmypdf input.pdf output.pdf`) and upload the result.',
    NO_LINE_ITEMS:
      'No recognisable captions were found. Check that the file contains the balance sheet itself rather than only notes or a cover page.',
    UNSUPPORTED_FORMAT: 'Supported formats are PDF, .xlsx, .xls, .xlsm and .csv.',
    FILE_TOO_LARGE: 'Try splitting the document, or raise MAX_UPLOAD_MB in the server environment.',
    NETWORK_ERROR: 'Start the API with `npm run dev` from the project root, then try again.',
    CORRUPT_PDF: 'The file may have been renamed or truncated. Try re-exporting it.',
  };
  const hint = HINTS[code];

  return (
    <div role="alert" className="card card-pad border-rose-200 bg-rose-50">
      <div className="flex gap-3">
        <AlertTriangle className="h-5 w-5 shrink-0 text-rose-600" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-rose-900">Could not analyse this file</h2>
          <p className="mt-1 text-sm text-rose-800">{message}</p>
          {hint && <p className="mt-2 text-sm text-rose-700">{hint}</p>}
          <p className="mt-2 font-mono text-[11px] uppercase tracking-wide text-rose-500">{code}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-800 transition-colors hover:bg-rose-100"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const STAGES = [
  'Reading the document',
  'Rebuilding the table layout',
  'Matching line items',
  'Computing ratios and analysis',
];

/** Skeleton shown while the pipeline runs. */
export function LoadingState({ stage }: { stage: number }) {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <div className="card card-pad">
        <ol className="flex flex-wrap gap-x-6 gap-y-2">
          {STAGES.map((label, index) => (
            <li
              key={label}
              className={
                index <= stage
                  ? 'flex items-center gap-2 text-sm font-medium text-teal-800'
                  : 'flex items-center gap-2 text-sm text-ink-400'
              }
            >
              <span
                className={
                  index < stage
                    ? 'h-2 w-2 rounded-full bg-teal-600'
                    : index === stage
                      ? 'h-2 w-2 animate-pulse rounded-full bg-teal-600'
                      : 'h-2 w-2 rounded-full bg-ink-300'
                }
                aria-hidden
              />
              {label}
            </li>
          ))}
        </ol>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="card card-pad">
            <div className="skeleton h-3 w-24" />
            <div className="skeleton mt-4 h-7 w-20" />
            <div className="skeleton mt-3 h-3 w-32" />
          </div>
        ))}
      </div>

      <div className="card card-pad">
        <div className="skeleton h-4 w-40" />
        <div className="mt-5 space-y-3">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="flex gap-4">
              <div className="skeleton h-4 flex-1" />
              <div className="skeleton h-4 w-24" />
              <div className="skeleton h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
