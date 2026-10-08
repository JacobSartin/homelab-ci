import { test } from 'node:test';
import assert from 'node:assert/strict';

import evaluatePolicy from '../src/automerge-policy.mts';
import notifyUpdate from '../src/notify-update.mts';
import mergeUpdate from '../src/merge-update.mts';
import type { GitHubClient, NotificationDependencies, PullRequest, WorkflowContext } from '../src/types.mts';
import { recordIssues } from './github-fixture.mts';

interface Scenario {
  author?: string;
  botLogin?: string;
  conclusion?: NonNullable<WorkflowContext['payload']['workflow_run']>['conclusion'];
  state?: PullRequest['state'];
  sha?: string;
  runSha?: string;
  labels?: string[];
  assignees?: PullRequest['assignees'];
  env?: NodeJS.ProcessEnv;
}

async function runAction(
  action: (dependencies: NotificationDependencies) => Promise<void>,
  {
    conclusion = 'success', state = 'open', sha = 'validated', runSha = 'validated',
    labels = ['automerge'], assignees = [], env = {},
    author = 'renovate[bot]', botLogin,
  }: Scenario = {},
) {
  const outputs: Record<string, string> = {};
  const { issues, calls: mutations } = recordIssues();
  const pr: PullRequest = { state, head: { sha }, user: { login: author }, labels: labels.map(name => ({ name })), assignees };
  const github: GitHubClient = {
    rest: {
      pulls: { get: async () => ({ data: pr }), merge: async () => {} },
      issues,
    },
    paginate: async () => [],
  };
  await action({
    botLogin,
    github,
    context: { repo: { owner: 'owner', repo: 'repo' }, payload: { workflow_run: { conclusion, head_sha: runSha, pull_requests: [{ number: 1, head: { sha } }] } } },
    core: { setOutput: (name, value) => outputs[name] = value, info: () => {} },
    env: { PR_NUMBER: '1', ASSIGNEE: 'owner', POLICY_REASON: 'validation concluded with failure', ...env },
  });
  return { outputs, mutations };
}

test('automerge accepts only the configured bot and retains manual and stale-head protections', async () => {
  const bot = { author: 'homelab-renovate[bot]', botLogin: 'homelab-renovate[bot]' };
  const merge = await runAction(evaluatePolicy, bot);
  assert.equal(merge.outputs.decision, 'merge');
  assert.equal(merge.outputs['head-sha'], 'validated');
  assert.equal((await runAction(evaluatePolicy, { ...bot, author: 'someone-else' })).outputs.decision, 'ignore');
  assert.equal((await runAction(evaluatePolicy, { botLogin: bot.botLogin })).outputs.decision, 'ignore');
  assert.equal((await runAction(evaluatePolicy, { ...bot, labels: ['automerge', 'type/major'] })).outputs.decision, 'notify');
  assert.equal((await runAction(evaluatePolicy, { ...bot, sha: 'newer' })).outputs.decision, 'ignore');
});

test('cancelled validation is ignored; success and real failures retain their policy', async () => {
  for (const [conclusion, decision] of [['cancelled', 'ignore'], ['success', 'merge'], ['failure', 'notify'], ['timed_out', 'notify']]) {
    assert.equal((await runAction(evaluatePolicy, { conclusion })).outputs.decision, decision);
  }
  assert.equal((await runAction(evaluatePolicy, { labels: ['manual'] })).outputs['make-manual'], 'true');
});

test('notification does not mutate closed or superseded PRs', async () => {
  for (const options of [{ state: 'closed' }, { sha: 'new-revision' }, { runSha: '' }] satisfies Scenario[]) {
    assert.deepEqual((await runAction(notifyUpdate, options)).mutations, []);
  }
  assert.deepEqual((await runAction(notifyUpdate)).mutations.map(call => call.name), ['addAssignees', 'createComment']);
});

test('notification explains merge outcomes and handles missing settings', async () => {
  const { mutations } = await runAction(notifyUpdate, { env: { MERGE_OUTCOME: 'workflow_permission', MERGE_REASON: 'needs an app token' } });
  const comment = mutations.find(call => call.name === 'createComment')!;
  assert.match(comment.args.body as string, /automerge workflow_permission \(needs an app token\)/);
  const policy = await runAction(notifyUpdate, { env: { MERGE_OUTCOME: 'superseded' } });
  assert.match(policy.mutations.find(call => call.name === 'createComment')!.args.body as string, /validation concluded with failure/);
  const nullAssignees = await runAction(notifyUpdate, { assignees: null });
  assert.deepEqual(nullAssignees.mutations[0]!.args.assignees, ['owner']);
  await assert.rejects(runAction(notifyUpdate, { env: { ASSIGNEE: undefined } }), /ASSIGNEE is required/);
});

interface MergeScenario {
  states?: Array<Partial<PullRequest>>;
  mergeError?: { status?: number; message: string } | Array<{ status?: number; message: string } | undefined>;
  env?: NodeJS.ProcessEnv;
}

async function merge({ states = [{ mergeable_state: 'clean' }], mergeError, env = {} }: MergeScenario = {}) {
  const outputs: Record<string, string> = {};
  const merges: Array<Record<string, unknown>> = [];
  const sleeps: number[] = [];
  let call = 0;
  const errors = Array.isArray(mergeError) ? mergeError : [mergeError];
  await mergeUpdate({
    github: { rest: {
      pulls: {
        get: async () => ({ data: { state: 'open', head: { sha: 'validated' }, user: { login: 'bot' }, labels: [], assignees: [], mergeable: true, ...states[Math.min(call++, states.length - 1)] } }),
        merge: async args => {
          merges.push(args as Record<string, unknown>);
          const error = errors[merges.length - 1];
          if (error) throw Object.assign(new Error(error.message), { status: error.status });
        },
      },
      issues: recordIssues().issues,
    } },
    context: { repo: { owner: 'owner', repo: 'repo' } },
    core: { setOutput: (name, value) => outputs[name] = value, info: () => {} },
    env: { PR_NUMBER: '1', HEAD_SHA: 'validated', RETRIES: '3', RETRY_DELAY_MS: '5', ...env },
    sleep: async ms => { sleeps.push(ms); },
  });
  return { outputs, merges, sleeps };
}

test('merge squashes a clean pull request at the validated head', async () => {
  const { outputs, merges, sleeps } = await merge();
  assert.equal(outputs.outcome, 'merged');
  assert.deepEqual(merges, [{ owner: 'owner', repo: 'repo', pull_number: 1, merge_method: 'squash', sha: 'validated' }]);
  assert.deepEqual(sleeps, []);
});

test('merge waits for GitHub to compute mergeability and gives up with not_ready', async () => {
  const waited = await merge({ states: [{ mergeable_state: 'unknown' }, { mergeable_state: 'blocked' }, { mergeable_state: 'clean' }] });
  assert.equal(waited.outputs.outcome, 'merged');
  assert.deepEqual(waited.sleeps, [5, 5]);
  const stuck = await merge({ states: [{ mergeable_state: 'unknown' }] });
  assert.equal(stuck.outputs.outcome, 'not_ready');
  assert.equal(stuck.merges.length, 0);
});

test('merge reports conflicts, superseded heads, closed pull requests and token limitations', async () => {
  assert.equal((await merge({ states: [{ mergeable: false, mergeable_state: 'dirty' }] })).outputs.outcome, 'conflict');
  assert.equal((await merge({ states: [{ head: { sha: 'moved' } }] })).outputs.outcome, 'superseded');
  assert.equal((await merge({ states: [{ state: 'closed' }] })).outputs.outcome, 'closed');
  const workflows = await merge({ mergeError: { status: 405, message: 'refusing to allow a GitHub App to create or update workflow `.github/workflows/flate.yaml` without `workflows` permission' } });
  assert.equal(workflows.outputs.outcome, 'workflow_permission');
  assert.match(workflows.outputs.reason!, /workflows permission/);
  const retried = await merge({ mergeError: [{ status: 405, message: 'Base branch was modified' }, undefined] });
  assert.equal(retried.outputs.outcome, 'merged');
  assert.equal(retried.merges.length, 2);
  const failed = await merge({ mergeError: { status: 403, message: 'Resource not accessible by integration' } });
  assert.equal(failed.outputs.outcome, 'merge_failed');
  await assert.rejects(merge({ env: { PR_NUMBER: '' } }), /PR_NUMBER is required/);
});
