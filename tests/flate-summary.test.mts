import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, parseFlateTest, renderTestReport } from '../src/flate-summary.mts';
import runEvaluate from '../src/evaluate-render.mts';

// Captured from `flate test all` runs against the real repositories.
const healthy = `
  ✓  Kustomization   flux-system/actions-runner-controller
  ‒  Kustomization   private-system/private-cluster  source GitRepository/private-system/private-cluster skipped: GitRepository private-system/private-cluster: secret private-system/private-cluster-deploy-key missing 'identity' for SSH auth
  ✓  HelmRelease     kube-system/cilium
  ✓  HelmRelease     jenkins/jenkins
  ‒  GitRepository   private-system/private-cluster  GitRepository private-system/private-cluster: secret private-system/private-cluster-deploy-key missing 'identity' for SSH auth
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

// Flate 0.7.3 with FLATE_ALLOW_MISSING_KINDS=Secret; warnings go to stderr.
const missingCredentials = `
  ✓  Kustomization   flux-system/echo
  ‒  Kustomization   flux-system/external-dependency  suspended
  ‒  Kustomization   flux-system/private-source  source GitRepository.source.toolkit.fluxcd.io/flux-system/private-source skipped: secret flux-system/private-source-deploy-key not found
  ✓  HelmRelease     echo/echo
  ✓  GitRepository   flux-system/fixture
  ‒  GitRepository   flux-system/private-source  secret flux-system/private-source-deploy-key not found

  ✓ 3 passed · 3 skipped   0.3s
`;

// Flate 0.7.3 without it: the source fails instead of being skipped.
const credentialsNotTolerated = `
  ✓  Kustomization   flux-system/private-source
  ✗  GitRepository   flux-system/private-source  secret flux-system/private-source-deploy-key not found

  ✗ 1 passed · 1 failed   0.0s
`;

test('parses resource lines, warnings and the summary', () => {
  const parsed = parseFlateTest(healthy);
  assert.deepEqual(parsed.summary, { passed: 167, skipped: 4, failed: 0, blocked: 0 });
  assert.equal(parsed.entries.length, 6);
  assert.deepEqual(parsed.entries[1], {
    status: 'skip', kind: 'Kustomization', name: 'private-system/private-cluster',
    message: "source GitRepository/private-system/private-cluster skipped: GitRepository private-system/private-cluster: secret private-system/private-cluster-deploy-key missing 'identity' for SSH auth",
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
  assert.match(strict.problems[0]!, /Kustomization private-system\/private-cluster was skipped/);
  assert.equal(evaluate(parsed, { allowedSkips: ['private-system/private-cluster'] }).ok, true);
  assert.equal(evaluate(parsed, { allowedSkips: ['Kustomization private-system/private-cluster', 'GitRepository private-system/private-cluster'] }).ok, true);
  const stubbed = evaluate(parseFlateTest(blocked));
  assert.ok(!stubbed.problems.some(problem => problem.includes('grafana-operator')));
});

test('a source without credentials is allowed only while Flate skips it', () => {
  const skipped = parseFlateTest(missingCredentials);
  assert.deepEqual(skipped.summary, { passed: 3, skipped: 3, failed: 0, blocked: 0 });
  assert.equal(evaluate(skipped, { allowedSkips: ['flux-system/private-source'] }).ok, true);
  assert.equal(evaluate(skipped).problems.length, 2);
  assert.deepEqual(evaluate(parseFlateTest(credentialsNotTolerated), { allowedSkips: ['flux-system/private-source'] }).problems, [
    'GitRepository flux-system/private-source failed: secret flux-system/private-source-deploy-key not found',
  ]);
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
  // Flate 0.7 passes Kustomizations orphaned by a suspended owner without emitting them.
  const orphaned = parseFlateTest('  ✓  Kustomization  flux-system/echo\n\n  ✓ 1 passed   0.0s\n');
  assert.equal(evaluate(orphaned).ok, true);
  assert.deepEqual(evaluate(orphaned, { renderedNothing: true }).problems, ['Flate reconciled the repository but rendered no manifests.']);
});

test('report lists the summary, problems, skips and warnings', () => {
  const parsed = parseFlateTest(healthy);
  const report = renderTestReport(parsed, evaluate(parsed, { allowedSkips: ['private-system/private-cluster'] }));
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
    env: { TEST_OUTPUT_FILE: 'test.txt', REPORT_FILE: 'report.md', ALLOWED_SKIPS: 'private-system/private-cluster' },
    read: (file: string) => files[file]!,
    write: (file: string, content: string) => { files[file] = content; },
  };
  await runEvaluate(deps);
  assert.equal(outputs.passed, '167');
  assert.equal(outputs.ok, 'true');
  assert.equal(warnings.length, 2);
  assert.match(files['report.md']!, /167 passed/);
  await assert.rejects(runEvaluate({ ...deps, env: { ...deps.env, ALLOWED_SKIPS: '' } }), /Flate validation failed:[\s\S]*private-cluster/);
  // A missing rendered file means the build did not run; an empty one is a problem.
  await runEvaluate({ ...deps, env: { ...deps.env, RENDERED_FILE: 'rendered.yaml' } });
  files['rendered.yaml'] = 'kind: Deployment\n';
  await runEvaluate({ ...deps, env: { ...deps.env, RENDERED_FILE: 'rendered.yaml' } });
  files['rendered.yaml'] = '\n';
  await assert.rejects(runEvaluate({ ...deps, env: { ...deps.env, RENDERED_FILE: 'rendered.yaml' } }), /rendered no manifests/);
  await assert.rejects(runEvaluate({ ...deps, env: {} }), /TEST_OUTPUT_FILE and REPORT_FILE/);
});
