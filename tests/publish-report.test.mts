import { test } from 'node:test';
import assert from 'node:assert/strict';
import publishReport, { MARKER, buildReport } from '../src/publish-report.mts';
import type { Comment } from '../src/types.mts';
import { recordIssues } from './github-fixture.mts';

interface Scenario {
  files?: Record<string, string>;
  comments?: Comment[];
  eventName?: string;
  env?: NodeJS.ProcessEnv;
}

async function publish({ files = {}, comments = [], eventName = 'pull_request', env = {} }: Scenario = {}) {
  const { issues, calls } = recordIssues();
  const summaries: string[] = [];
  await publishReport({
    github: { rest: { issues }, paginate: async () => comments },
    context: { repo: { owner: 'owner', repo: 'repo' }, issue: { number: 1 }, serverUrl: 'https://github.com', runId: 42, eventName },
    env: { TEST_REPORT: 'test.md', SCHEMA_REPORT: 'schema.md', IMAGE_REPORT: 'images.md', DIFF_FILE: 'diff.md', ...env },
    read: file => {
      if (!(file in files)) throw new Error('File not found');
      return files[file]!;
    },
    summary: async markdown => { summaries.push(markdown); },
  });
  return { calls, summaries };
}

test('creates one report comment, updates it on later runs and mirrors it to the job summary', async () => {
  const files = { 'test.md': '✅ Flate reconciled the repository: 5 passed.', 'images.md': 'No container images changed.', 'diff.md': '@@ a @@\n+ change' };
  const { calls, summaries } = await publish({ files });
  assert.deepEqual(calls.map(call => call.name), ['createComment']);
  const body = calls[0]!.args.body as string;
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /## ✅ GitOps validation\n/);
  assert.match(body, /### Render\n\n✅ Flate/);
  assert.match(body, /### Images\n\nNo container images changed\./);
  assert.doesNotMatch(body, /### Schemas/);
  assert.match(body, /```diff\n@@ a @@\n\+ change\n```/);
  assert.match(body, /actions\/runs\/42/);
  assert.equal(summaries.length, 1);
  assert.doesNotMatch(summaries[0]!, /homelab-ci-report/);

  const { calls: [updated] } = await publish({ files, comments: [{ id: 7, body: `${MARKER}\nold` }] });
  assert.equal(updated!.name, 'updateComment');
  assert.equal(updated!.args.comment_id, 7);
});

test('a failed validation mentions and assigns the configured user', async () => {
  const files = { 'test.md': '❌ Flate reconciled the repository: 1 failed.' };
  const { calls } = await publish({ files, env: { FAILED: 'true', ASSIGNEE: 'owner' } });
  assert.deepEqual(calls.map(call => call.name), ['createComment', 'addAssignees']);
  const body = calls[0]!.args.body as string;
  assert.match(body, /## ❌ GitOps validation failed\n\n@owner this update needs attention/);
  assert.deepEqual(calls[1]!.args, { owner: 'owner', repo: 'repo', issue_number: 1, assignees: ['owner'] });

  const unassigned = await publish({ files, env: { FAILED: 'true' } });
  assert.deepEqual(unassigned.calls.map(call => call.name), ['createComment']);
  assert.doesNotMatch(unassigned.calls[0]!.args.body as string, /needs attention/);
  const passed = await publish({ files, env: { FAILED: 'false', ASSIGNEE: 'owner' } });
  assert.deepEqual(passed.calls.map(call => call.name), ['createComment']);
});

test('outside pull requests the report only goes to the job summary', async () => {
  const { calls, summaries } = await publish({ files: { 'test.md': 'ok' }, eventName: 'workflow_dispatch', env: { FAILED: 'true', ASSIGNEE: 'owner' } });
  assert.deepEqual(calls, []);
  assert.equal(summaries.length, 1);
});

test('oversized diffs link to the workflow run instead of exceeding the comment limit', () => {
  const body = buildReport([
    { title: 'Render', body: 'ok' },
    { title: 'Rendered diff', body: '+ large change\n'.repeat(6000), diff: true },
  ], 'https://github.com/owner/repo/actions/runs/42');
  assert.ok(body.length <= 65000);
  assert.match(body, /Too large to post\. Download it from the \[workflow run\]/);
  assert.match(body, /### Render\n\nok/);
});
