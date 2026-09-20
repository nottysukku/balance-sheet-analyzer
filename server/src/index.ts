import { createApp } from './app.js';
import { config, isLlmConfigured } from './config.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
  console.log(
    isLlmConfigured()
      ? `[api] Claude assist enabled (${config.anthropic.model})`
      : '[api] Claude assist disabled - running the deterministic pipeline only',
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
