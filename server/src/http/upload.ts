import multer from 'multer';
import { config } from '../config.js';
import { AppError } from './errors.js';
import type { UploadFormat } from '../analyze/index.js';

/**
 * Upload handling and format detection.
 *
 * Files stay in memory - a balance sheet is a few megabytes and never needs to
 * touch disk, which also means there is no temp file to clean up or leak.
 *
 * The declared MIME type is treated as a hint only. Browsers routinely send
 * `application/octet-stream` for .xlsx, and a malicious client can send
 * anything at all, so the real format is confirmed from the file's magic
 * bytes before any parser is handed the buffer.
 */

const ALLOWED_EXTENSIONS = new Set(['pdf', 'xlsx', 'xls', 'xlsm', 'csv']);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      callback(
        new AppError(
          'UNSUPPORTED_FORMAT',
          `"${file.originalname}" is not a supported format. Upload a PDF or an Excel workbook (.xlsx, .xls, .xlsm) or a CSV.`,
          415,
        ),
      );
      return;
    }
    callback(null, true);
  },
});

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

/**
 * Determine the real format from content, falling back to the extension for
 * CSV (which has no signature).
 */
export function detectFormat(buffer: Buffer, fileName: string): UploadFormat {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';

  // %PDF
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  // PK.. - a ZIP container, which is what every .xlsx really is.
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])) {
    return 'excel';
  }
  // Legacy OLE2 compound file - .xls.
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'excel';

  if (extension === 'csv') return 'excel';

  if (extension === 'pdf') {
    throw new AppError(
      'CORRUPT_PDF',
      'That file is named .pdf but does not begin with a PDF signature. It may be corrupt or renamed.',
      422,
    );
  }
  throw new AppError(
    'UNRECOGNISED_CONTENT',
    'The file contents do not look like a PDF or an Excel workbook.',
    422,
  );
}
