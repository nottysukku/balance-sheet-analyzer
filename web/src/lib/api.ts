import type { AnalysisReport } from '../types';

/** Errors the API returns with a code we can show verbatim. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export interface HealthResponse {
  status: string;
  llmConfigured: boolean;
  model: string | null;
  maxUploadBytes: number;
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/api/health', { signal });
  if (!response.ok) throw new ApiError('The API is not reachable.', 'API_DOWN', response.status);
  return (await response.json()) as HealthResponse;
}

export async function analyzeFile(
  file: File,
  options: { useLlm: boolean; signal?: AbortSignal },
): Promise<AnalysisReport> {
  const form = new FormData();
  form.append('file', file);
  form.append('useLlm', String(options.useLlm));

  let response: Response;
  try {
    response = await fetch('/api/analyze', {
      method: 'POST',
      body: form,
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(
      'Could not reach the analysis service. Is the API running on port 5174?',
      'NETWORK_ERROR',
      0,
    );
  }

  if (!response.ok) {
    let body: ErrorBody = {};
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      // A non-JSON error body (a proxy page, say) - fall through to the default.
    }
    throw new ApiError(
      body.error?.message ?? 'The file could not be analysed.',
      body.error?.code ?? 'UNKNOWN',
      response.status,
    );
  }

  return (await response.json()) as AnalysisReport;
}
