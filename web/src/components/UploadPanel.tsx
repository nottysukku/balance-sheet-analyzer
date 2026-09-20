import { useCallback, useId, useRef, useState } from 'react';
import clsx from 'clsx';
import { FileSpreadsheet, FileText, Sparkles, Upload, Wand2, X } from 'lucide-react';
import { formatFileSize } from '../lib/format';

const ACCEPTED = '.pdf,.xlsx,.xls,.xlsm,.csv';
const ACCEPTED_EXTENSIONS = ['pdf', 'xlsx', 'xls', 'xlsm', 'csv'];

/** The scanned filing shipped with the project, served from web/public. */
const SAMPLE_URL = '/sample-balance-sheet.pdf';
const SAMPLE_NAME = 'laj-exports-fy2024.pdf';

interface Props {
  onAnalyze: (file: File) => void;
  onReset: () => void;
  busy: boolean;
  hasResult: boolean;
  llmConfigured: boolean;
  useLlm: boolean;
  onUseLlmChange: (value: boolean) => void;
  maxUploadBytes: number;
}

export function UploadPanel({
  onAnalyze,
  onReset,
  busy,
  hasResult,
  llmConfigured,
  useLlm,
  onUseLlmChange,
  maxUploadBytes,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleId = useId();

  /**
   * Validate before uploading so an obvious mistake costs a click rather than
   * a round trip. The server re-checks everything regardless.
   */
  const accept = useCallback(
    (candidate: File | undefined) => {
      if (!candidate) return;
      const extension = candidate.name.split('.').pop()?.toLowerCase() ?? '';
      if (!ACCEPTED_EXTENSIONS.includes(extension)) {
        setLocalError(`"${candidate.name}" is not a PDF or a spreadsheet.`);
        setFile(null);
        return;
      }
      if (candidate.size === 0) {
        setLocalError('That file is empty.');
        setFile(null);
        return;
      }
      if (candidate.size > maxUploadBytes) {
        setLocalError(
          `That file is ${formatFileSize(candidate.size)}; the limit is ${formatFileSize(maxUploadBytes)}.`,
        );
        setFile(null);
        return;
      }
      setLocalError(null);
      setFile(candidate);
    },
    [maxUploadBytes],
  );

  const clear = () => {
    setFile(null);
    setLocalError(null);
    if (inputRef.current) inputRef.current.value = '';
    onReset();
  };

  /**
   * Load the bundled scanned filing so the pipeline can be tried without
   * hunting for a document first.
   */
  const loadSample = async () => {
    try {
      const response = await fetch(SAMPLE_URL);
      if (!response.ok) throw new Error(String(response.status));
      const blob = await response.blob();
      const sample = new File([blob], SAMPLE_NAME, { type: 'application/pdf' });
      setLocalError(null);
      setFile(sample);
      onAnalyze(sample);
    } catch {
      setLocalError('The bundled sample could not be loaded.');
    }
  };

  const Icon = file?.name.toLowerCase().endsWith('.pdf') ? FileText : FileSpreadsheet;

  return (
    <div className="card card-pad">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (busy) return;
          accept(event.dataTransfer.files?.[0]);
        }}
        className={clsx(
          'relative rounded-lg border-2 border-dashed px-5 py-8 text-center transition-colors',
          dragging ? 'border-teal-500 bg-teal-50' : 'border-ink-300 bg-ink-50/60',
          busy && 'opacity-60',
        )}
      >
        <input
          ref={inputRef}
          id="balance-sheet-file"
          type="file"
          accept={ACCEPTED}
          className="sr-only"
          disabled={busy}
          onChange={(event) => accept(event.target.files?.[0])}
        />

        {file ? (
          <div className="flex items-center justify-center gap-3">
            <Icon className="h-8 w-8 shrink-0 text-teal-700" aria-hidden />
            <div className="min-w-0 text-left">
              <p className="truncate text-sm font-semibold text-ink-900">{file.name}</p>
              <p className="text-xs text-ink-500">{formatFileSize(file.size)}</p>
            </div>
            {!busy && (
              <button
                type="button"
                onClick={clear}
                className="ml-1 rounded-md p-1.5 text-ink-400 transition-colors hover:bg-ink-200 hover:text-ink-700"
                aria-label="Remove file"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
        ) : (
          <>
            <Upload className="mx-auto h-8 w-8 text-ink-400" aria-hidden />
            <p className="mt-3 text-sm text-ink-700">
              <label
                htmlFor="balance-sheet-file"
                className="cursor-pointer font-semibold text-teal-700 underline decoration-teal-300 underline-offset-2 hover:text-teal-800"
              >
                Choose a balance sheet
              </label>{' '}
              or drag it here
            </p>
            <p className="mt-1 text-xs text-ink-500">PDF or Excel &middot; up to {formatFileSize(maxUploadBytes)}</p>
            <button
              type="button"
              onClick={loadSample}
              disabled={busy}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-100 disabled:opacity-50"
            >
              <Wand2 className="h-3.5 w-3.5" aria-hidden />
              Try the bundled sample (a scanned filing)
            </button>
          </>
        )}
      </div>

      {localError && (
        <p role="alert" className="mt-3 text-sm text-rose-700">
          {localError}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label
          htmlFor={toggleId}
          className={clsx(
            'flex items-center gap-2.5 text-sm',
            llmConfigured ? 'cursor-pointer text-ink-700' : 'cursor-not-allowed text-ink-400',
          )}
        >
          <span className="relative inline-flex">
            <input
              id={toggleId}
              type="checkbox"
              className="peer sr-only"
              checked={useLlm && llmConfigured}
              disabled={!llmConfigured || busy}
              onChange={(event) => onUseLlmChange(event.target.checked)}
            />
            <span className="block h-5 w-9 rounded-full bg-ink-300 transition-colors peer-checked:bg-teal-600 peer-disabled:opacity-50" />
            <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            Claude-assisted analysis
          </span>
        </label>

        <div className="flex gap-2">
          {hasResult && !busy && (
            <button
              type="button"
              onClick={clear}
              className="rounded-lg border border-ink-300 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100"
            >
              Start over
            </button>
          )}
          <button
            type="button"
            disabled={!file || busy}
            onClick={() => file && onAnalyze(file)}
            className="rounded-lg bg-teal-700 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-ink-300"
          >
            {busy ? 'Analysing…' : 'Analyse balance sheet'}
          </button>
        </div>
      </div>

      {!llmConfigured && (
        <p className="mt-3 text-xs text-ink-500">
          No <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-[11px]">ANTHROPIC_API_KEY</code> is
          set, so the deterministic parser and rule-based analysis run on their own. Everything below still works.
        </p>
      )}
    </div>
  );
}
