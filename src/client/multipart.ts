import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MultipartValue } from './types';

/** What Playwright's fetch() actually accepts per multipart field. */
type PlaywrightMultipartValue =
  | string
  | number
  | boolean
  | { name: string; mimeType: string; buffer: Buffer };

/**
 * Normalises our friendlier MultipartValue (which accepts a plain filePath,
 * with fileName/mimeType optional) into the shape Playwright's fetch()
 * requires - a buffer plus explicit name/mimeType for every file field.
 */
export function toPlaywrightMultipart(
  fields: Record<string, MultipartValue>,
): Record<string, PlaywrightMultipartValue> {
  const result: Record<string, PlaywrightMultipartValue> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'object') {
      result[key] = value;
      continue;
    }

    const buffer = value.buffer ?? (value.filePath ? fs.readFileSync(value.filePath) : undefined);
    if (!buffer) {
      throw new Error(`Multipart field "${key}" must provide either a buffer or a filePath`);
    }

    result[key] = {
      name: value.fileName ?? (value.filePath ? path.basename(value.filePath) : key),
      mimeType: value.mimeType ?? 'application/octet-stream',
      buffer,
    };
  }

  return result;
}
