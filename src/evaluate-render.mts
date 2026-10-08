import fs from 'node:fs';
import { evaluate, parseFlateTest, renderTestReport } from './flate-summary.mts';
import { parseList } from './check-images.mts';
import type { Core } from './types.mts';

export interface EvaluateRenderDependencies {
  core: Core;
  env?: NodeJS.ProcessEnv;
  read?: (file: string) => string;
  write?: (file: string, content: string) => void;
}

// Turn the `flate test all` output captured by the render script into a
// pass/fail decision plus a Markdown report for the pull request.
export default async function run({
  core, env = process.env,
  read = file => fs.readFileSync(file, 'utf8'),
  write = (file, content) => fs.writeFileSync(file, content),
}: EvaluateRenderDependencies): Promise<void> {
  const testFile = env.TEST_OUTPUT_FILE;
  const reportFile = env.REPORT_FILE;
  if (!testFile || !reportFile) throw new Error('TEST_OUTPUT_FILE and REPORT_FILE are required.');
  const parsed = parseFlateTest(read(testFile));
  const evaluation = evaluate(parsed, { allowedSkips: parseList(env.ALLOWED_SKIPS) });
  write(reportFile, renderTestReport(parsed, evaluation));
  core.setOutput('passed', String(parsed.summary?.passed ?? 0));
  core.setOutput('ok', String(evaluation.ok));
  for (const warning of parsed.warnings) core.warning?.(warning);
  if (!evaluation.ok) throw new Error(`Flate validation failed:\n${evaluation.problems.join('\n')}`);
  core.info(`Flate rendered ${parsed.summary?.passed ?? 0} resources successfully.`);
}
