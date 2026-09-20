import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';

/** An error we are happy to describe to the client verbatim. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

const MULTER_MESSAGES: Record<string, { code: string; message: string }> = {
  LIMIT_FILE_SIZE: {
    code: 'FILE_TOO_LARGE',
    message: 'That file is larger than the upload limit.',
  },
  LIMIT_FILE_COUNT: {
    code: 'TOO_MANY_FILES',
    message: 'Upload one balance sheet at a time.',
  },
  LIMIT_UNEXPECTED_FILE: {
    code: 'UNEXPECTED_FIELD',
    message: 'The file must be sent in a field named "file".',
  },
};

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } } satisfies ErrorBody);
}

/**
 * Single place where anything thrown in a route becomes a client response.
 * Unknown errors are logged in full but reported generically, so we never leak
 * a stack trace or a filesystem path to the browser.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    } satisfies ErrorBody);
    return;
  }

  if (err instanceof MulterError) {
    const mapped = MULTER_MESSAGES[err.code] ?? {
      code: 'UPLOAD_FAILED',
      message: 'The upload could not be read.',
    };
    res.status(400).json({ error: mapped } satisfies ErrorBody);
    return;
  }

  console.error('[unhandled]', err);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong while analysing the file.' },
  } satisfies ErrorBody);
}
