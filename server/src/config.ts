import 'dotenv/config';

/**
 * Resolve the API port.
 *
 * Priority is `--port` on the command line, then `API_PORT`, then `PORT`.
 *
 * The argv flag exists because `PORT` is often already set in the environment
 * by whatever launched the process - a dev-server wrapper, a container, an
 * IDE - and when it is, the API silently binds to the frontend's port and the
 * two fight over it. The dev script therefore passes the port explicitly and
 * the ambient value is only a fallback. `API_PORT` gives deployments a way to
 * be explicit without a flag; plain `PORT` still works for hosts that set it.
 */
function resolvePort(fallback: number): number {
  const flagIndex = process.argv.indexOf('--port');
  const candidates = [
    flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined,
    process.env.API_PORT,
    process.env.PORT,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Number.parseInt(candidate, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return fallback;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: resolvePort(5174),
  maxUploadBytes: intFromEnv('MAX_UPLOAD_MB', 15) * 1024 * 1024,
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY?.trim() || null,
    model: process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-5',
  },
  /** Below this, the pipeline asks Claude to look at the rows it could not map. */
  llmAssistThreshold: 0.6,
} as const;

export const isLlmConfigured = (): boolean => config.anthropic.apiKey !== null;
