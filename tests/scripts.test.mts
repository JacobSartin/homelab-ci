import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Execute the real action shell scripts with stubbed CLIs. On Windows the
// tests use Git for Windows Bash, the same shell GitHub Actions provides.
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const renderScript = fs.readFileSync(path.join(import.meta.dirname, '../actions/flate/render.sh'), 'utf8');
const validateScript = fs.readFileSync(path.join(import.meta.dirname, '../actions/schema/validate.sh'), 'utf8');

function run(script: string, stub: string, env: Record<string, string>, cwd: string): { status: number; output: string } {
  try {
    const output = execFileSync(bash, ['-c', `${stub}\n${script}`], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, output: `${failure.stdout}\n${failure.stderr}` };
  }
}

function withTempDir<T>(prefix: string, body: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Record each flate invocation and emulate its outputs. DIFF_FAILS and
// TEST_FAILS switch the stub into the corresponding failure modes.
const flateStub = `
flate() {
  echo "flate $*" >> "$OUTPUT_DIR/calls.txt"
  [[ -z "$FLATE_BASE" ]] || { echo "FLATE_BASE must be cleared" >&2; return 90; }
  case "$1 $2" in
    "test all") echo "  ✓  HelmRelease  a/b"; echo; echo "  ✓ 1 passed   1s"; [[ "\${TEST_FAILS:-}" == true ]] && return 1; return 0 ;;
    "build all") echo "kind: Deployment" ;;
    "diff all") [[ "\${DIFF_FAILS:-}" == true ]] && return 1; echo "@@ x @@"; echo "+ change" ;;
    "diff images") [[ "\${DIFF_FAILS:-}" == true ]] && return 1; echo '["ghcr.io/a/b:2"]' ;;
    "get images") echo '["ghcr.io/a/b:1","ghcr.io/a/b:2"]' ;;
    *) return 91 ;;
  esac
}
`;

test('render script diffs against the baseline and records every result file', () => {
  withTempDir('render-', dir => {
    const out = path.join(dir, 'out');
    const { status } = run(renderScript, flateStub, { OUTPUT_DIR: out, FLATE_BASE: 'main', FLATE_PATH: 'clusters', RENDER_BASE: 'HEAD^1' }, dir);
    assert.equal(status, 0);
    assert.equal(fs.readFileSync(path.join(out, 'calls.txt'), 'utf8'), [
      'flate test all --path clusters',
      'flate build all --path clusters',
      'flate diff all --path clusters --base HEAD^1 -o github',
      'flate diff images --path clusters --base HEAD^1 -o json',
      '',
    ].join('\n'));
    assert.match(fs.readFileSync(path.join(out, 'test.txt'), 'utf8'), /1 passed/);
    assert.equal(fs.readFileSync(path.join(out, 'rendered.yaml'), 'utf8'), 'kind: Deployment\n');
    assert.match(fs.readFileSync(path.join(out, 'diff.md'), 'utf8'), /\+ change/);
    assert.equal(fs.readFileSync(path.join(out, 'images.json'), 'utf8').trim(), '["ghcr.io/a/b:2"]');
  });
});

test('render script lists every image without a baseline', () => {
  withTempDir('render-', dir => {
    const out = path.join(dir, 'out');
    const { status } = run(renderScript, flateStub, { OUTPUT_DIR: out, FLATE_BASE: 'main' }, dir);
    assert.equal(status, 0);
    const calls = fs.readFileSync(path.join(out, 'calls.txt'), 'utf8');
    assert.match(calls, /flate get images --path \. -o json/);
    assert.doesNotMatch(calls, /diff/);
    assert.equal(fs.readFileSync(path.join(out, 'diff.md'), 'utf8'), '');
    assert.match(fs.readFileSync(path.join(out, 'images.json'), 'utf8'), /ghcr\.io\/a\/b:1/);
  });
});

test('render script stops after a failed test so the evaluator reports the failing resources', () => {
  withTempDir('render-', dir => {
    const out = path.join(dir, 'out');
    const { status, output } = run(renderScript, flateStub, { OUTPUT_DIR: out, FLATE_BASE: 'main', RENDER_BASE: 'HEAD^1', TEST_FAILS: 'true' }, dir);
    assert.equal(status, 0);
    assert.match(output, /flate test exited with 1/);
    assert.equal(fs.readFileSync(path.join(out, 'calls.txt'), 'utf8'), 'flate test all --path .\n');
    assert.match(fs.readFileSync(path.join(out, 'test.txt'), 'utf8'), /1 passed/);
    assert.equal(fs.existsSync(path.join(out, 'rendered.yaml')), false);
    assert.equal(fs.readFileSync(path.join(out, 'diff.md'), 'utf8'), '');
    assert.equal(fs.readFileSync(path.join(out, 'images.json'), 'utf8').trim(), '[]');
  });
});

test('render script falls back when the baseline cannot be rendered', () => {
  withTempDir('render-', dir => {
    const out = path.join(dir, 'out');
    const { status, output } = run(renderScript, flateStub, { OUTPUT_DIR: out, FLATE_BASE: 'main', RENDER_BASE: 'HEAD^1', DIFF_FAILS: 'true' }, dir);
    assert.equal(status, 0);
    assert.match(output, /::warning::Flate could not diff against HEAD\^1/);
    assert.match(fs.readFileSync(path.join(out, 'diff.md'), 'utf8'), /Diff unavailable/);
    assert.match(fs.readFileSync(path.join(out, 'images.json'), 'utf8'), /ghcr\.io\/a\/b:1/);
  });
});

test('render script fails when the full tree cannot be built', () => {
  withTempDir('render-', dir => {
    const broken = flateStub.replace('"build all") echo "kind: Deployment" ;;', '"build all") return 1 ;;');
    const { status } = run(renderScript, broken, { OUTPUT_DIR: path.join(dir, 'out'), FLATE_BASE: 'main' }, dir);
    assert.notEqual(status, 0);
  });
});

const kubeconformStub = `
kubeconform() {
  while (( $# > 1 )); do
    case "$1" in
      -skip) echo "skip=$2" >> "$WORK/kubeconform-args.txt"; shift 2 ;;
      -schema-location) echo "schema=$2" >> "$WORK/kubeconform-args.txt"; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "$1" "$WORK/validated.yaml"
  if grep -q 'invalid-host' "$1"; then
    echo "$1 - Ingress bad is invalid: hostname pattern"
    echo "Summary: 2 resources found in 1 file - Valid: 1, Invalid: 1, Errors: 0, Skipped: 0"
    return 1
  fi
  echo "Summary: 2 resources found in 1 file - Valid: 2, Invalid: 0, Errors: 0, Skipped: 0"
}
`;

test('schema script substitutes placeholders and composes the skip list before validating', () => {
  withTempDir('schema-', dir => {
    const rendered = path.join(dir, 'rendered.yaml');
    fs.writeFileSync(rendered, 'host: echo...PLACEHOLDER_BASE_DOMAIN..\nip: ${NAS_IP}\nother: ..PLACEHOLDER_SECRET..\nvar: ${UNKNOWN}\n');
    const report = path.join(dir, 'report.md');
    const { status } = run(validateScript, kubeconformStub, {
      WORK: dir, RENDERED_FILE: rendered, REPORT_FILE: report, SCHEMA_LOCATION: 'https://schemas.example/{{.Group}}',
      SUBSTITUTIONS: 'BASE_DOMAIN=example.invalid\nNAS_IP=10.0.0.5\n', SKIP_KINDS: 'AutoscalingRunnerSet\ntuppr.home-operations.com/v1alpha1/TalosUpgrade,Foo',
    }, dir);
    assert.equal(status, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'validated.yaml'), 'utf8'), 'host: echo.example.invalid\nip: 10.0.0.5\nother: placeholder\nvar: placeholder\n');
    assert.equal(fs.readFileSync(path.join(dir, 'kubeconform-args.txt'), 'utf8'), 'skip=Secret,ConfigMap,AutoscalingRunnerSet,tuppr.home-operations.com/v1alpha1/TalosUpgrade,Foo\nschema=default\nschema=https://schemas.example/{{.Group}}\n');
    assert.match(fs.readFileSync(report, 'utf8'), /^✅ Kubeconform: 2 resources found in 1 file - Valid: 2/);
  });
});

test('schema script reports invalid resources and rejects malformed substitutions', () => {
  withTempDir('schema-', dir => {
    const rendered = path.join(dir, 'rendered.yaml');
    fs.writeFileSync(rendered, 'host: invalid-host\n');
    const report = path.join(dir, 'report.md');
    const { status } = run(validateScript, kubeconformStub, { WORK: dir, RENDERED_FILE: rendered, REPORT_FILE: report, SCHEMA_LOCATION: 'x', SUBSTITUTIONS: '' }, dir);
    assert.equal(status, 1);
    const content = fs.readFileSync(report, 'utf8');
    assert.match(content, /^❌ Kubeconform: 2 resources found/);
    assert.match(content, /Ingress bad is invalid: hostname pattern/);
    assert.doesNotMatch(content, /rendered\.yaml - /);
    const malformed = run(validateScript, kubeconformStub, { WORK: dir, RENDERED_FILE: rendered, REPORT_FILE: report, SCHEMA_LOCATION: 'x', SUBSTITUTIONS: 'bad name=1' }, dir);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.output, /Invalid substitution name/);
  });
});
