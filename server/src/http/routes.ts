import { Router, type Request, type Response, type NextFunction } from 'express';
import { analyseDocument } from '../analyze/index.js';
import { config, isLlmConfigured } from '../config.js';
import { AppError } from './errors.js';
import { detectFormat, upload } from './upload.js';

/** Wraps an async handler so a rejected promise reaches the error middleware. */
function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

export const router: Router = Router();

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    llmConfigured: isLlmConfigured(),
    model: isLlmConfigured() ? config.anthropic.model : null,
    maxUploadBytes: config.maxUploadBytes,
  });
});

router.post(
  '/analyze',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const file = req.file;
    if (!file) {
      throw new AppError('NO_FILE', 'No file was uploaded. Attach one in the "file" field.', 400);
    }
    if (file.buffer.byteLength === 0) {
      throw new AppError('EMPTY_FILE', 'The uploaded file is empty.', 422);
    }

    const format = detectFormat(file.buffer, file.originalname);
    // Opt-out flag from the UI toggle; anything but "false" leaves it enabled.
    const useLlm = req.body?.useLlm !== 'false';

    const report = await analyseDocument({
      buffer: file.buffer,
      fileName: file.originalname,
      format,
      useLlm,
    });

    res.json(report);
  }),
);
