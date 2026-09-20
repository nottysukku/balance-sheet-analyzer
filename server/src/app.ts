import cors from 'cors';
import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { router } from './http/routes.js';

export interface AppOptions {
  /**
   * Where the router is mounted. Defaults to `/api`.
   *
   * A serverless platform may strip the `/api` prefix before the handler sees
   * the request, or may not, depending on how the function is routed. Mounting
   * at both paths makes the app work either way rather than depending on that
   * detail.
   */
  mountPaths?: string[];
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  // The Vite dev server proxies /api, so CORS only matters when the frontend
  // is served from a different origin in production.
  app.use(cors());
  // Only the multipart upload route takes a body; keep the JSON limit small.
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.use(options.mountPaths ?? ['/api'], router);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
