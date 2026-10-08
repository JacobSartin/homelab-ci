import fs from 'node:fs';
import { checkImages, hasFailures, renderImageReport } from './images.mts';
import type { Core } from './types.mts';

export interface CheckImagesDependencies {
  core: Core;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  read?: (file: string) => string;
  write?: (file: string, content: string) => void;
}

export function parseList(value: string | undefined): string[] {
  return (value ?? '').split(/[\r\n,]+/).map(item => item.trim()).filter(Boolean);
}

export default async function run({
  core, env = process.env, fetch: fetchImpl,
  read = file => fs.readFileSync(file, 'utf8'),
  write = (file, content) => fs.writeFileSync(file, content),
}: CheckImagesDependencies): Promise<void> {
  const imagesFile = env.IMAGES_FILE;
  if (!imagesFile) throw new Error('IMAGES_FILE is required.');
  const reportFile = env.REPORT_FILE;
  if (!reportFile) throw new Error('REPORT_FILE is required.');
  const platforms = parseList(env.PLATFORMS);
  if (platforms.length === 0) platforms.push('linux/amd64');

  let images: string[] = [];
  try {
    const parsed: unknown = JSON.parse(read(imagesFile) || '[]');
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
      throw new Error('expected a JSON array of image references');
    }
    images = parsed;
  } catch (error) {
    throw new Error(`Unable to read ${imagesFile}: ${(error as Error).message}`);
  }

  const results = await checkImages(images, { fetch: fetchImpl, platforms });
  const report = renderImageReport(results, platforms);
  write(reportFile, report);
  for (const result of results) {
    core.info(`${result.status.padEnd(16)} ${result.image}${result.detail ? ` (${result.detail})` : ''}`);
  }
  core.setOutput('checked', String(results.length));
  core.setOutput('failed', String(results.filter(result => result.status !== 'ok').length));
  if (hasFailures(results)) {
    const failed = results.filter(result => result.status !== 'ok').map(result => `${result.image}: ${result.detail}`);
    throw new Error(`Image verification failed:\n${failed.join('\n')}`);
  }
}
