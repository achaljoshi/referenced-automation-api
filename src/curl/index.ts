import { parseCurlFile } from './curlFile';
import { generateTests, type GenerateOptions, type GeneratedTests } from './generate';

export { parseCurl, splitCommands, tokenize } from './parseCurl';
export type { ParsedCurl, CurlFormField } from './parseCurl';
export { parseCurlFile } from './curlFile';
export type { CurlEntry, Directives, ParsedCurlFile } from './curlFile';
export { generateTests } from './generate';
export type { GenerateOptions, GeneratedTests, ParamRule } from './generate';
export { toCurl } from './toCurl';
export type { CurlRequest } from './toCurl';

export interface ConvertResult extends GeneratedTests {
  /** Commands that could not be read (reading continued past them). */
  problems: string[];
}

/** curl text in, Playwright spec source out - what the `api-curl-to-playwright` command does for one file. */
export function convertCurl(text: string, options: GenerateOptions): ConvertResult {
  const { entries, problems } = parseCurlFile(text);
  if (entries.length === 0) {
    throw new Error(
      `No curl commands found in ${options.source}${problems.length > 0 ? `:\n  ${problems.join('\n  ')}` : ''}`,
    );
  }
  return { ...generateTests(entries, options), problems };
}
