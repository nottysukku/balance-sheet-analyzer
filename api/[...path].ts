/**
 * Vercel serverless function covering every `/api/*` route.
 *
 * The catch-all filename is what makes Vercel's filesystem routing send
 * `/api/health` and `/api/analyze` here rather than only `/api`. The handler
 * itself is the ordinary Express app - see `server/src/vercel.ts`.
 */
export { default } from '../server/src/vercel.js';
