import fs from 'node:fs';
import { evaluate, parseFlateTest, renderTestReport } from './flate-summary.mts';
import { classify } from './classify.mts';
import { parseList } from './check-images.mts';
import type { Core } from './types.mts';

export interface EvaluateRenderDependencies {
  core: Core;
  env?: NodeJS.ProcessEnv;
  read?: (file: string) => string;
  write?: (file: string, content: string) => void;
}

function readOptional(read: (file: string) => string, file: string | undefined): string {
  if (!file) return '';
  try { return read(file); } catch { return ''; }
}

// Turn the `flate test all` output captured by the render script into a
// pass/fail decision plus a Markdown report, and classify the rendered diff so
// later jobs can run per kind of change.
export default async function run({
  core, env = process.env,
  read = file => fs.readFileSync(file, 'utf8'),
  write = (file, content) => fs.writeFileSync(file, content),
}: EvaluateRenderDependencies): Promise<void> {
  const testFile = env.TEST_OUTPUT_FILE;
  const reportFile = env.REPORT_FILE;
  if (!testFile || !reportFile) throw new Error('TEST_OUTPUT_FILE and REPORT_FILE are required.');

  let images: string[] = [];
  const imagesJson = readOptional(read, env.IMAGES_FILE).trim();
  if (imagesJson) {
    const parsed: unknown = JSON.parse(imagesJson);
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
      throw new Error(`${env.IMAGES_FILE} must contain a JSON array of image references.`);
    }
    images = parsed;
  }
  const classification = classify(readOptional(read, env.DIFF_FILE), images);
  if (env.CLASSIFICATION_FILE) write(env.CLASSIFICATION_FILE, JSON.stringify(classification, null, 2));
  core.setOutput('images-changed', String(classification.images.length > 0));
  core.setOutput('helmreleases-changed', String(classification.helmReleases.length > 0));
  core.setOutput('kustomizations-changed', String(classification.kustomizations.length > 0));
  core.setOutput('changed-kinds', classification.kinds.join(','));
  core.setOutput('changed-helmreleases', classification.helmReleases.join(','));
  core.setOutput('changed-kustomizations', classification.kustomizations.join(','));
  core.info(`changed: ${classification.images.length} images, ${classification.helmReleases.length} HelmReleases, ${classification.kustomizations.length} Kustomizations, kinds [${classification.kinds.join(', ')}]`);

  const parsed = parseFlateTest(read(testFile));
  const evaluation = evaluate(parsed, { allowedSkips: parseList(env.ALLOWED_SKIPS) });
  write(reportFile, renderTestReport(parsed, evaluation));
  core.setOutput('passed', String(parsed.summary?.passed ?? 0));
  core.setOutput('ok', String(evaluation.ok));
  for (const warning of parsed.warnings) core.warning?.(warning);
  if (!evaluation.ok) throw new Error(`Flate validation failed:\n${evaluation.problems.join('\n')}`);
  core.info(`Flate rendered ${parsed.summary?.passed ?? 0} resources successfully.`);
}
