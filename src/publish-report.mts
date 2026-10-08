import fs from 'node:fs';
import type { CommentClient, ReportContext } from './types.mts';

export interface PublishDependencies {
  github: CommentClient;
  context: ReportContext;
  env?: NodeJS.ProcessEnv;
  read?: (file: string) => string;
  summary?: (markdown: string) => Promise<void>;
}

export const MARKER = '<!-- homelab-ci-report -->';
const LIMIT = 65000;

interface Section {
  title: string;
  body: string;
  // Diff sections are fenced and can be replaced by a link when too large.
  diff?: boolean;
}

export interface ReportOptions {
  failed?: boolean;
  assignee?: string;
  limit?: number;
}

function readOptional(read: (file: string) => string, file: string | undefined): string {
  if (!file) return '';
  try { return read(file).trim(); } catch { return ''; }
}

export function buildReport(sections: Section[], runUrl: string, { failed = false, assignee = '', limit = LIMIT }: ReportOptions = {}): string {
  const linked = new Set<string>();
  const render = (): string => {
    const parts = [MARKER, failed ? '## ❌ GitOps validation failed' : '## ✅ GitOps validation'];
    if (failed && assignee) parts.push(`@${assignee} this update needs attention; the failing checks are listed below.`);
    for (const section of sections) {
      if (!section.body) continue;
      if (section.diff) {
        parts.push(linked.has(section.title)
          ? `<details><summary>${section.title} (${section.body.length.toLocaleString()} characters)</summary>\n\nToo large to post. Download it from the [workflow run](${runUrl}).\n\n</details>`
          : `<details open><summary>${section.title}</summary>\n\n\`\`\`diff\n${section.body}\n\`\`\`\n\n</details>`);
      } else {
        parts.push(`### ${section.title}\n\n${section.body}`);
      }
    }
    parts.push(`<sub>Rendered by [flate](https://github.com/home-operations/flate) — [workflow run](${runUrl})</sub>`);
    return parts.join('\n\n');
  };
  const diffs = sections.filter(section => section.diff && section.body).sort((a, b) => b.body.length - a.body.length);
  for (const section of diffs) {
    if (render().length <= limit) break;
    linked.add(section.title);
  }
  return render();
}

export default async function publishReport({ github, context, env = process.env, read = file => fs.readFileSync(file, 'utf8'), summary }: PublishDependencies): Promise<void> {
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const failed = env.FAILED === 'true';
  const assignee = (env.ASSIGNEE ?? '').trim();
  const sections: Section[] = [
    { title: 'Render', body: readOptional(read, env.TEST_REPORT) },
    { title: 'Schemas', body: readOptional(read, env.SCHEMA_REPORT) },
    { title: 'Images', body: readOptional(read, env.IMAGE_REPORT) },
    { title: 'Rendered diff', body: readOptional(read, env.DIFF_FILE), diff: true },
  ];
  const body = buildReport(sections, runUrl, { failed, assignee });
  await summary?.(body.replace(MARKER, '').trim());

  if (context.eventName !== 'pull_request' || !context.issue.number) return;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo, issue_number: context.issue.number, per_page: 100,
  });
  const existing = comments.find(comment => comment.body?.includes(MARKER));
  if (existing) {
    await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ ...context.repo, issue_number: context.issue.number, body });
  }
  // Editing a comment does not notify anyone; an assignment does.
  if (failed && assignee) {
    await github.rest.issues.addAssignees({ ...context.repo, issue_number: context.issue.number, assignees: [assignee] });
  }
}
