import type { NotificationDependencies } from './types.mts';

export default async function notifyUpdate({ github, context, core, env = process.env }: NotificationDependencies): Promise<void> {
  const pull_number = Number(env.PR_NUMBER);
  if (!pull_number) throw new Error('PR_NUMBER is required to notify an update.');
  const mergeOutcome = env.MERGE_OUTCOME ?? '';
  const unresolved = env.MERGE_RESULT === 'failure' || (mergeOutcome !== '' && mergeOutcome !== 'merged' && mergeOutcome !== 'closed' && mergeOutcome !== 'superseded');
  const reason = unresolved
    ? `automerge ${mergeOutcome || 'failed unexpectedly'}${env.MERGE_REASON ? ` (${env.MERGE_REASON})` : ''}`
    : env.POLICY_REASON;
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number });

  // The PR can merge or advance between the policy and notification jobs.
  const validatedSha = context.payload.workflow_run?.head_sha;
  if (pr.state !== 'open' || !validatedSha || pr.head.sha !== validatedSha) {
    core.info('Skipping notification for a closed or superseded pull request.');
    return;
  }

  const assignee = env.ASSIGNEE;
  if (!assignee) throw new Error('ASSIGNEE is required to notify an update.');

  if (env.MAKE_MANUAL === 'true') {
    const labels = new Set(pr.labels.map(label => label.name));
    if (labels.has('automerge')) {
      await github.rest.issues.removeLabel({ ...context.repo, issue_number: pull_number, name: 'automerge' });
    }
    if (!labels.has('manual')) {
      await github.rest.issues.addLabels({ ...context.repo, issue_number: pull_number, labels: ['manual'] });
    }
  }

  if (!(pr.assignees ?? []).some(user => user.login === assignee)) {
    await github.rest.issues.addAssignees({ ...context.repo, issue_number: pull_number, assignees: [assignee] });
  }

  const marker = '<!-- renovate-attention -->';
  const body = `${marker}\n@${assignee} — Renovate PR #${pull_number} requires attention: ${reason}.`;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo, issue_number: pull_number, per_page: 100,
  });
  const existing = comments.find(comment => comment.body?.includes(marker));
  if (existing) {
    await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ ...context.repo, issue_number: pull_number, body });
  }
}
