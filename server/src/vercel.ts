import type { Express } from 'express';
import { createApp } from './app.js';

/**
 * Serverless entry point.
 *
 * An Express app is itself a `(req, res)` handler, so the same application
 * that runs behind `npm run dev` can be exported directly as a platform
 * function. There is no second implementation of the API to keep in sync -
 * only the way it is invoked differs.
 *
 * The router is mounted at both `/api` and `/` because the platform may or may
 * not strip the `/api` prefix before the function is called.
 */
const app: Express = createApp({ mountPaths: ['/api', '/'] });

export default app;
