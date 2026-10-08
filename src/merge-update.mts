import type { Core, GitHubClient } from './types.mts';

// Merge a validated Renovate pull request with the GitHub API directly. The
// outcome names tell the notification step what went wrong without a third
// party action in the loop.
export type MergeOutcome = 'merged' | 'closed' | 'superseded' | 'conflict' | 'not_ready' | 'workflow_permission' | 'merge_failed';

export interface MergeDependencies {
  github: Pick<GitHubClient, 'rest'>;
  context: { repo: { owner: string; repo: string } };
  core: Core;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
}

const READY_STATES = new Set(['clean', 'unstable', 'has_hooks']);
const WAIT_STATES = new Set(['unknown', 'blocked', 'behind', '']);

function errorStatus(error: unknown): { status?: number; message: string } {
  const candidate = error as { status?: number; message?: string };
  return { status: candidate.status, message: candidate.message ?? String(error) };
}

export default async function mergeUpdate({ github, context, core, env = process.env, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }: MergeDependencies): Promise<void> {
  const pull_number = Number(env.PR_NUMBER);
  if (!pull_number) throw new Error('PR_NUMBER is required.');
  const expectedSha = env.HEAD_SHA;
  const method = (env.MERGE_METHOD || 'squash') as 'merge' | 'squash' | 'rebase';
  const retries = Number(env.RETRIES || 12);
  const delay = Number(env.RETRY_DELAY_MS || 10000);

  const finish = (outcome: MergeOutcome, reason: string): void => {
    core.setOutput('outcome', outcome);
    core.setOutput('reason', reason);
    core.info(`outcome=${outcome}: ${reason}`);
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number });
    if (pr.state !== 'open') return finish('closed', `pull request is ${pr.state}`);
    if (expectedSha && pr.head.sha !== expectedSha) return finish('superseded', 'pull request head moved after validation');
    const state = pr.mergeable_state ?? '';
    if (pr.mergeable === false && state === 'dirty') return finish('conflict', 'pull request has merge conflicts');
    if (!READY_STATES.has(state) && (WAIT_STATES.has(state) || attempt < retries)) {
      core.info(`attempt ${attempt}/${retries}: mergeable_state=${state || 'unknown'}, waiting ${delay}ms`);
      if (attempt < retries) await sleep(delay);
      continue;
    }
    try {
      await github.rest.pulls.merge({ ...context.repo, pull_number, merge_method: method, sha: pr.head.sha });
      return finish('merged', `merged with ${method}`);
    } catch (error) {
      const { status, message } = errorStatus(error);
      if (/workflows?\b.*permission|without `workflows` permission/i.test(message)) {
        return finish('workflow_permission', 'the token cannot merge workflow file changes; configure a GitHub App token with the workflows permission');
      }
      if ((status === 405 || status === 409) && attempt < retries) {
        core.info(`attempt ${attempt}/${retries}: ${message}; retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      return finish('merge_failed', message);
    }
  }
  finish('not_ready', `pull request was not mergeable after ${retries} attempts`);
}
