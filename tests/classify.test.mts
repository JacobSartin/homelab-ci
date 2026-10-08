import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseGitHubDiff } from '../src/classify.mts';
import runEvaluate from '../src/evaluate-render.mts';

// Captured from `flate diff all -o github` for an image bump and a chart bump.
const imageBump = `
@@ data.values.yaml @@
# v1/ConfigMap/radarr/radarr-values
! ± value change
- old
+ new

@@ spec.template.spec.containers.main.image @@
# apps/v1/Deployment/radarr/radarr-app
! ± value change
- ghcr.io/home-operations/radarr:6.4.4.10685@sha256:be53
+ ghcr.io/home-operations/radarr:6.4.5.99999
`;

const chartBump = `
@@ spec.chart.spec.version @@
# helm.toolkit.fluxcd.io/v2/HelmRelease/jenkins/jenkins
! ± value change
- 5.9.66
+ 5.9.67

@@ metadata.labels.app.kubernetes.io/version @@
# helm.toolkit.fluxcd.io/v2/HelmRelease/jenkins/jenkins
! ± value change
- a
+ b
`;

test('parses changed objects and their paths from the GitHub diff format', () => {
  const objects = parseGitHubDiff(imageBump);
  assert.deepEqual(objects, [
    { apiVersion: 'v1', kind: 'ConfigMap', namespace: 'radarr', name: 'radarr-values', paths: ['data.values.yaml'] },
    { apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'radarr', name: 'radarr-app', paths: ['spec.template.spec.containers.main.image'] },
  ]);
  const [jenkins] = parseGitHubDiff(chartBump);
  assert.equal(jenkins!.apiVersion, 'helm.toolkit.fluxcd.io/v2');
  assert.deepEqual(jenkins!.paths, ['spec.chart.spec.version', 'metadata.labels.app.kubernetes.io/version']);
  assert.deepEqual(parseGitHubDiff(''), []);
});

test('classifies image, chart and kustomization changes', () => {
  const image = classify(imageBump, ['ghcr.io/home-operations/radarr:6.4.5.99999']);
  assert.deepEqual(image.helmReleases, []);
  assert.deepEqual(image.kinds, ['ConfigMap', 'Deployment']);
  assert.equal(image.images.length, 1);
  const chart = classify(chartBump, []);
  assert.deepEqual(chart.helmReleases, ['jenkins/jenkins']);
  assert.deepEqual(chart.kinds, ['HelmRelease']);
  const ks = classify('@@ spec.interval @@\n# kustomize.toolkit.fluxcd.io/v1/Kustomization/flux-system/echo\n', []);
  assert.deepEqual(ks.kustomizations, ['flux-system/echo']);
});

test('evaluate-render publishes classification outputs and tolerates missing diff files', async () => {
  const files: Record<string, string> = {
    'test.txt': '  ✓  HelmRelease  jenkins/jenkins\n\n  ✓ 1 passed   1s\n',
    'diff.md': chartBump,
    'images.json': '["ghcr.io/a/b:1"]',
  };
  const outputs: Record<string, string> = {};
  const deps = {
    core: { setOutput: (name: string, value: string) => { outputs[name] = value; }, info: () => {} },
    env: { TEST_OUTPUT_FILE: 'test.txt', REPORT_FILE: 'report.md', DIFF_FILE: 'diff.md', IMAGES_FILE: 'images.json', CLASSIFICATION_FILE: 'classification.json' },
    read: (file: string) => { if (!(file in files)) throw new Error('missing'); return files[file]!; },
    write: (file: string, content: string) => { files[file] = content; },
  };
  await runEvaluate(deps);
  assert.equal(outputs['images-changed'], 'true');
  assert.equal(outputs['helmreleases-changed'], 'true');
  assert.equal(outputs['kustomizations-changed'], 'false');
  assert.equal(outputs['changed-helmreleases'], 'jenkins/jenkins');
  assert.equal(outputs['changed-kinds'], 'HelmRelease');
  assert.match(files['classification.json']!, /"helmReleases": \[\n\s+"jenkins\/jenkins"/);

  await runEvaluate({ ...deps, env: { ...deps.env, DIFF_FILE: 'absent.md', IMAGES_FILE: 'absent.json' } });
  assert.equal(outputs['images-changed'], 'false');
  assert.equal(outputs['changed-kinds'], '');
  files['images.json'] = '{"no":"list"}';
  await assert.rejects(runEvaluate(deps), /JSON array of image references/);
});
