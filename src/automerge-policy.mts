import type { PolicyDependencies } from './types.mts';

type Decision = 'ignore' | 'merge' | 'notify';

export const BLOCKING_LABELS = ['manual', 'system-upgrade', 'type/major'];

export default async function automergePolicy({ github, context, core, botLogin = 'renovate[bot]' }: PolicyDependencies): Promise<void> {
  const decide = (decision: Decision, reason = '', makeManual = false): void => {
    core.setOutput('decision', decision);
    core.setOutput('reason', reason);
    core.setOutput('make-manual', String(makeManual));
    core.info(`decision=${decision}${reason ? `: ${reason}` : ''}`);
  };

  const run = context.payload.workflow_run;
  const [runPr] = run?.pull_requests ?? [];
  if (!run || !runPr) {
    decide('ignore', 'validation run has no associated pull request');
    return;
  }

  const pull_number = runPr.number;
  const validatedSha = run.head_sha;
  core.setOutput('pr-number', String(pull_number));
  core.setOutput('head-sha', validatedSha ?? '');
  if (!validatedSha) {
    decide('ignore', 'validation run did not identify a pull request head');
    return;
  }

  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number });

  if (pr.state !== 'open') {
    decide('ignore', `pull request is already ${pr.state}`);
    return;
  }
  if (pr.user.login !== botLogin) {
    decide('ignore', `pull request was opened by ${pr.user.login}`);
    return;
  }
  if (pr.head.sha !== validatedSha) {
    decide('ignore', 'a newer pull request revision is awaiting validation');
    return;
  }

  const labels = new Set(pr.labels.map(label => label.name));
  const blockers = BLOCKING_LABELS.filter(label => labels.has(label));
  const conclusion = run.conclusion;

  if (conclusion === 'cancelled') {
    decide('ignore', 'validation was cancelled; a replacement run may be pending');
    return;
  }
  if (conclusion !== 'success') {
    // Preserve automerge eligibility so a corrected Renovate revision can self-heal.
    decide('notify', `validation concluded with ${conclusion}`);
    return;
  }
  if (blockers.length > 0) {
    decide('notify', `manual review required by ${blockers.join(', ')}`, true);
    return;
  }
  if (!labels.has('automerge')) {
    decide('notify', 'automerge label is absent', true);
    return;
  }
  decide('merge');
}
