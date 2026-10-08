import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, parseFlateTest, renderTestReport } from '../src/flate-summary.mts';
import runEvaluate from '../src/evaluate-render.mts';

// Captured from `flate test all` runs against the real repositories.
const healthy = `
  ✓  Kustomization   flux-system/actions-runner-controller
  ‒  Kustomization   flux-system/media-cluster  source GitRepository/flux-system/media-cluster skipped: GitRepository flux-system/media-cluster: secret flux-system/media-cluster-deploy-key missing 'identity' for SSH auth
  ✓  HelmRelease     kube-system/cilium
  ✓  HelmRelease     jenkins/jenkins
  ‒  GitRepository   flux-system/media-cluster  GitRepository flux-system/media-cluster: secret flux-system/media-cluster-deploy-key missing 'identity' for SSH auth
  ✓  GitRepository   flux-system/cluster

  ⚠ warnings (2)
    HelmRelease cloudflared/cloudflared: values not used by the chart
      resources
    HelmRelease kube-system/cilium: values not used by the chart
      enableRuntimeDeviceDetection

  ✓ 167 passed · 4 skipped   1m13s
`;

const blocked = `
  ✓  Kustomization   flux-system/flaresolverr
  ‒  Kustomization   flux-system/grafana-operator  suspended
  ✓  HelmRelease     flaresolverr/flaresolverr
  ⊘  Kustomization   flux-system/radarr  blocked by flux-system/external-secrets-stores (not found)
  ✗  HelmRelease     unpoller/unpoller  building HelmRelease unpoller/unpoller: valuesFrom ConfigMap unpoller/unpoller-values not found

  ✗ 5 passed · 1 skipped · 1 failed · 1 blocked   4.1s
`;

test('parses resource lines, warnings and the summary', () => {
  const parsed = parseFlateTest(healthy);
  assert.deepEqual(parsed.summary, { passed: 167, skipped: 4, failed: 0, blocked: 0 });
  assert.equal(parsed.entries.length, 6);
  assert.deepEqual(parsed.entries[1], {
    status: 'skip', kind: 'Kustomization', name: 'flux-system/media-cluster',
    message: "source GitRepository/flux-system/media-cluster skipped: GitRepository flux-system/media-cluster: secret flux-system/media-cluster-deploy-key missing 'identity' for SSH auth",
  });
  assert.deepEqual(parsed.warnings, [
    'HelmRelease cloudflared/cloudflared: values not used by the chart resources',
    'HelmRelease kube-system/cilium: values not used by the chart enableRuntimeDeviceDetection',
  ]);
  assert.deepEqual(parseFlateTest(blocked).summary, { passed: 5, skipped: 1, failed: 1, blocked: 1 });
});

test('skipped sources must be allowed explicitly; suspended stand-ins are always fine', () => {
  const parsed = parseFlateTest(healthy);
  const strict = evaluate(parsed);
  assert.equal(strict.ok, false);
  assert.equal(strict.problems.length, 2);
  assert.match(strict.problems[0]!, /Kustomization flux-system\/media-cluster was skipped/);
  assert.equal(evaluate(parsed, { allowedSkips: ['flux-system/media-cluster'] }).ok, true);
  assert.equal(evaluate(parsed, { allowedSkips: ['Kustomization flux-system/media-cluster', 'GitRepository flux-system/media-cluster'] }).ok, true);
  const stubbed = evaluate(parseFlateTest(blocked));
  assert.ok(!stubbed.problems.some(problem => problem.includes('grafana-operator')));
});

test('failed and blocked resources, missing summaries and empty renders are problems', () => {
  const evaluation = evaluate(parseFlateTest(blocked));
  assert.deepEqual(evaluation.problems, [
    'Kustomization flux-system/radarr blocked by flux-system/external-secrets-stores (not found)',
    'HelmRelease unpoller/unpoller failed: building HelmRelease unpoller/unpoller: valuesFrom ConfigMap unpoller/unpoller-values not found',
  ]);
  const silent = evaluate(parseFlateTest(''));
  assert.match(silent.problems[0]!, /did not print a test summary/);
  const nothingRendered = evaluate(parseFlateTest('  ✗  HelmRelease  a/b  boom\n\n  ✗ 0 passed · 1 failed   1s\n'));
  assert.ok(nothingRendered.problems.some(problem => problem === 'No HelmRelease rendered successfully.'));
});

test('report lists the summary, problems, skips and warnings', () => {
  const parsed = parseFlateTest(healthy);
  const report = renderTestReport(parsed, evaluate(parsed, { allowedSkips: ['flux-system/media-cluster'] }));
  assert.match(report, /^✅ Flate reconciled the repository: 167 passed, 4 skipped\./);
  assert.match(report, /<summary>Skipped resources<\/summary>/);
  assert.match(report, /<summary>Flate warnings<\/summary>/);
  const failing = renderTestReport(parseFlateTest(blocked), evaluate(parseFlateTest(blocked)));
  assert.match(failing, /^❌ Flate reconciled the repository: 5 passed, 1 skipped, 1 failed, 1 blocked\./);
  assert.match(failing, /- Kustomization flux-system\/radarr blocked/);
});

test('evaluate-render entry point writes the report and fails the step on problems', async () => {
  const files: Record<string, string> = { 'test.txt': healthy };
  const outputs: Record<string, string> = {};
  const warnings: string[] = [];
  const deps = {
    core: { setOutput: (name: string, value: string) => { outputs[name] = value; }, info: () => {}, warning: (message: string) => { warnings.push(message); } },
    env: { TEST_OUTPUT_FILE: 'test.txt', REPORT_FILE: 'report.md', ALLOWED_SKIPS: 'flux-system/media-cluster' },
    read: (file: string) => files[file]!,
    write: (file: string, content: string) => { files[file] = content; },
  };
  await runEvaluate(deps);
  assert.equal(outputs.passed, '167');
  assert.equal(outputs.ok, 'true');
  assert.equal(warnings.length, 2);
  assert.match(files['report.md']!, /167 passed/);
  await assert.rejects(runEvaluate({ ...deps, env: { ...deps.env, ALLOWED_SKIPS: '' } }), /Flate validation failed:[\s\S]*media-cluster/);
  await assert.rejects(runEvaluate({ ...deps, env: {} }), /TEST_OUTPUT_FILE and REPORT_FILE/);
});
