// Parse the human-readable report printed by `flate test all` so CI can fail
// on blocked or skipped resources that Flate itself tolerates, and so the pull
// request report can show what rendered.

export type EntryStatus = 'pass' | 'fail' | 'skip' | 'blocked';

export interface Entry {
  status: EntryStatus;
  kind: string;
  name: string;
  message: string;
}

export interface Summary {
  passed: number;
  skipped: number;
  failed: number;
  blocked: number;
}

export interface Parsed {
  entries: Entry[];
  warnings: string[];
  summary?: Summary;
}

const GLYPHS: Record<string, EntryStatus> = { '✓': 'pass', '✗': 'fail', '‒': 'skip', '⊘': 'blocked' };

export function parseFlateTest(text: string): Parsed {
  const entries: Entry[] = [];
  const warnings: string[] = [];
  let summary: Summary | undefined;
  let inWarnings = false;
  // Flate prints a warning header per resource followed by deeper-indented
  // detail lines; flatten each group into one line.
  let header = '';
  let details: string[] = [];
  const flushWarning = (): void => {
    if (header) warnings.push([header, ...details].join(' '));
    header = '';
    details = [];
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const summaryMatch = /^\s*[✓✗]\s+(\d+) passed(?: · (\d+) skipped)?(?: · (\d+) failed)?(?: · (\d+) blocked)?/u.exec(line);
    if (summaryMatch) {
      summary = {
        passed: Number(summaryMatch[1]),
        skipped: Number(summaryMatch[2] ?? 0),
        failed: Number(summaryMatch[3] ?? 0),
        blocked: Number(summaryMatch[4] ?? 0),
      };
      flushWarning();
      inWarnings = false;
      continue;
    }
    if (/^\s*⚠ warnings/u.test(line)) {
      inWarnings = true;
      continue;
    }
    if (inWarnings) {
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      if (indent >= 6 && header) {
        details.push(line.trim());
      } else {
        flushWarning();
        header = line.trim();
      }
      continue;
    }
    const entryMatch = /^\s*([✓✗‒⊘])\s+(\S+)\s+(\S+)(?:\s+(.*))?$/u.exec(line);
    if (entryMatch) {
      entries.push({
        status: GLYPHS[entryMatch[1]!]!,
        kind: entryMatch[2]!,
        name: entryMatch[3]!,
        message: (entryMatch[4] ?? '').trim(),
      });
    }
  }
  flushWarning();
  return { entries, warnings, summary };
}

export interface EvaluateOptions {
  // Entries such as `Kustomization flux-system/media-cluster` or
  // `flux-system/media-cluster` that may stay skipped: sources living in other
  // repositories that only the live cluster can fetch.
  allowedSkips?: string[];
}

export interface Evaluation {
  ok: boolean;
  problems: string[];
}

function allowed(entry: Entry, allowedSkips: string[]): boolean {
  if (/\bsuspended\b/.test(entry.message)) return true;
  return allowedSkips.some(pattern => pattern === entry.name || pattern === `${entry.kind} ${entry.name}`);
}

export function evaluate(parsed: Parsed, { allowedSkips = [] }: EvaluateOptions = {}): Evaluation {
  const problems: string[] = [];
  if (!parsed.summary) problems.push('Flate did not print a test summary; the render did not complete.');
  for (const entry of parsed.entries) {
    const label = `${entry.kind} ${entry.name}`;
    if (entry.status === 'fail') problems.push(`${label} failed: ${entry.message}`);
    else if (entry.status === 'blocked') problems.push(`${label} ${entry.message || 'blocked'}`);
    else if (entry.status === 'skip' && !allowed(entry, allowedSkips)) {
      problems.push(`${label} was skipped and is not in allowed-skips: ${entry.message}`);
    }
  }
  const passedHelmReleases = parsed.entries.filter(entry => entry.status === 'pass' && entry.kind === 'HelmRelease').length;
  const anyHelmReleases = parsed.entries.some(entry => entry.kind === 'HelmRelease');
  if (anyHelmReleases && passedHelmReleases === 0) problems.push('No HelmRelease rendered successfully.');
  return { ok: problems.length === 0, problems };
}

export function renderTestReport(parsed: Parsed, evaluation: Evaluation): string {
  const lines: string[] = [];
  const summary = parsed.summary;
  if (summary) {
    const parts = [`${summary.passed} passed`];
    if (summary.skipped) parts.push(`${summary.skipped} skipped`);
    if (summary.failed) parts.push(`${summary.failed} failed`);
    if (summary.blocked) parts.push(`${summary.blocked} blocked`);
    lines.push(`${evaluation.ok ? '✅' : '❌'} Flate reconciled the repository: ${parts.join(', ')}.`);
  } else {
    lines.push('❌ Flate did not complete.');
  }
  if (evaluation.problems.length) {
    lines.push('', ...evaluation.problems.map(problem => `- ${problem}`));
  }
  const skipped = parsed.entries.filter(entry => entry.status === 'skip');
  if (skipped.length) {
    lines.push('', '<details><summary>Skipped resources</summary>', '');
    lines.push(...skipped.map(entry => `- ${entry.kind} ${entry.name}: ${entry.message}`));
    lines.push('', '</details>');
  }
  if (parsed.warnings.length) {
    lines.push('', '<details><summary>Flate warnings</summary>', '');
    lines.push(...parsed.warnings.map(warning => `- ${warning}`));
    lines.push('', '</details>');
  }
  return lines.join('\n');
}
