import { useCallback, useEffect, useRef, useState } from 'react';
import { Github, ScrollText } from 'lucide-react';
import { ApiError, analyzeFile, fetchHealth } from './lib/api';
import type { AnalysisReport } from './types';
import { CompositionCharts } from './components/CompositionCharts';
import { InsightsPanel } from './components/InsightsPanel';
import { MetricsGrid } from './components/MetricsGrid';
import { ReportHeader } from './components/ReportHeader';
import { StatementTable } from './components/StatementTable';
import { EmptyState, ErrorState, LoadingState } from './components/States';
import { UploadPanel } from './components/UploadPanel';

type Status = 'idle' | 'loading' | 'ready' | 'error';

/** Advances the progress indicator while the request is in flight. */
const STAGE_TIMINGS = [400, 1100, 2100];

const DEFAULT_MAX_UPLOAD = 15 * 1024 * 1024;

export default function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [stage, setStage] = useState(0);
  const [useLlm, setUseLlm] = useState(true);
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [maxUploadBytes, setMaxUploadBytes] = useState(DEFAULT_MAX_UPLOAD);

  const lastFile = useRef<File | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timersRef = useRef<number[]>([]);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Ask the API once whether a key is configured, so the toggle reflects
  // reality instead of promising something the server cannot do.
  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((health) => {
        setLlmConfigured(health.llmConfigured);
        setUseLlm(health.llmConfigured);
        if (health.maxUploadBytes) setMaxUploadBytes(health.maxUploadBytes);
      })
      .catch(() => {
        // The upload attempt will surface a clearer message than a banner here.
      });
    return () => controller.abort();
  }, []);

  const clearTimers = () => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current = [];
  };

  useEffect(() => () => {
    clearTimers();
    abortRef.current?.abort();
  }, []);

  const runAnalysis = useCallback(
    async (file: File) => {
      lastFile.current = file;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus('loading');
      setError(null);
      setReport(null);
      setStage(0);
      clearTimers();
      timersRef.current = STAGE_TIMINGS.map((delay, index) =>
        window.setTimeout(() => setStage(index + 1), delay),
      );

      try {
        const result = await analyzeFile(file, { useLlm, signal: controller.signal });
        setReport(result);
        setStatus('ready');
        // Bring the report into view without yanking the page on mobile.
        window.requestAnimationFrame(() => {
          resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const apiError = err instanceof ApiError ? err : null;
        setError({
          code: apiError?.code ?? 'UNKNOWN',
          message: apiError?.message ?? 'Something went wrong while analysing the file.',
        });
        setStatus('error');
      } finally {
        clearTimers();
      }
    },
    [useLlm],
  );

  const reset = () => {
    abortRef.current?.abort();
    clearTimers();
    lastFile.current = null;
    setReport(null);
    setError(null);
    setStatus('idle');
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-700">
              <ScrollText className="h-5 w-5 text-white" aria-hidden />
            </span>
            <div>
              <h1 className="text-base font-bold tracking-tight text-ink-900">Balance Sheet Analyzer</h1>
              <p className="text-xs text-ink-500">
                Extract line items from a PDF or Excel filing, then read the ratios and what they mean.
              </p>
            </div>
          </div>
          <a
            href="https://github.com"
            className="hidden items-center gap-1.5 text-xs text-ink-500 transition-colors hover:text-ink-800 sm:inline-flex"
            rel="noreferrer noopener"
            target="_blank"
          >
            <Github className="h-3.5 w-3.5" aria-hidden />
            Source
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <UploadPanel
          onAnalyze={runAnalysis}
          onReset={reset}
          busy={status === 'loading'}
          hasResult={status === 'ready' || status === 'error'}
          llmConfigured={llmConfigured}
          useLlm={useLlm}
          onUseLlmChange={setUseLlm}
          maxUploadBytes={maxUploadBytes}
        />

        <div ref={resultsRef} className="scroll-mt-4 space-y-6">
          {status === 'idle' && <EmptyState />}

          {status === 'loading' && <LoadingState stage={stage} />}

          {status === 'error' && error && (
            <ErrorState
              code={error.code}
              message={error.message}
              onRetry={lastFile.current ? () => runAnalysis(lastFile.current!) : undefined}
            />
          )}

          {status === 'ready' && report && (
            <>
              <ReportHeader report={report} />
              <StatementTable statement={report.statement} />
              <MetricsGrid
                metrics={report.analysis.metrics}
                periods={report.statement.periods}
                currency={report.statement.company.currency ?? 'INR'}
              />
              <CompositionCharts statement={report.statement} />
              <InsightsPanel analysis={report.analysis} />
            </>
          )}
        </div>
      </main>

      <footer className="border-t border-ink-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-5 text-xs leading-relaxed text-ink-500 sm:px-6">
          Figures are extracted automatically and may contain errors, particularly from scanned
          documents. Check anything material against the source filing before relying on it. This tool
          reports what the balance sheet says; it is not financial advice.
        </div>
      </footer>
    </div>
  );
}
