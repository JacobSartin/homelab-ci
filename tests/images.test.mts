import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkImage, checkImages, hasFailures, parseImage, renderImageReport } from '../src/images.mts';
import runCheckImages from '../src/check-images.mts';

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

// A registry double: every request is matched against path handlers so tests
// drive the anonymous token exchange exactly as real registries do.
function registry(handlers: Record<string, Handler>, { requireToken = true } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}${url.search}`);
    if (url.pathname === '/token') {
      return Response.json({ token: `tok-${url.searchParams.get('scope')}` });
    }
    const authorization = new Headers(init?.headers).get('authorization');
    if (requireToken && !authorization) {
      return new Response('', {
        status: 401,
        headers: { 'www-authenticate': `Bearer realm="https://${url.host}/token",service="${url.host}",scope="repository:${url.pathname.split('/v2/')[1]!.split('/manifests/')[0]!.split('/blobs/')[0]}:pull"` },
      });
    }
    const handler = handlers[url.pathname];
    if (!handler) return new Response('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', { status: 404 });
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const digestOf = (body: string): string => `sha256:${createHash('sha256').update(body).digest('hex')}`;
const index = JSON.stringify({
  mediaType: 'application/vnd.oci.image.index.v1+json',
  manifests: [
    { digest: 'sha256:a', platform: { os: 'linux', architecture: 'amd64' } },
    { digest: 'sha256:b', platform: { os: 'linux', architecture: 'arm64' } },
    { digest: 'sha256:c', platform: { os: 'unknown', architecture: 'unknown' } },
  ],
});
const manifestBody = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.oci.image.index.v1+json' } });

test('parses references with registries, tags, digests and Docker Hub shorthands', () => {
  assert.deepEqual(parseImage('ghcr.io/home-operations/radarr:6.4.4@sha256:abc'), {
    raw: 'ghcr.io/home-operations/radarr:6.4.4@sha256:abc', registry: 'ghcr.io', repository: 'home-operations/radarr', tag: '6.4.4', digest: 'sha256:abc',
  });
  assert.equal(parseImage('nginx').registry, 'registry-1.docker.io');
  assert.equal(parseImage('nginx').repository, 'library/nginx');
  assert.equal(parseImage('nginx').tag, 'latest');
  assert.equal(parseImage('docker.io/qmcgaw/gluetun:v3').repository, 'qmcgaw/gluetun');
  assert.equal(parseImage('localhost:5000/app:1').registry, 'localhost:5000');
  assert.equal(parseImage('quay.io/cilium/cilium@sha256:abc').tag, undefined);
  assert.throws(() => parseImage('ghcr.io/'), /Invalid image reference/);
});

test('verifies a tagged image through the bearer token flow and reports its platforms', async () => {
  const { fetch, calls } = registry({ '/v2/home-operations/radarr/manifests/6.4.4': manifestBody(index) });
  const result = await checkImage('ghcr.io/home-operations/radarr:6.4.4', { fetch });
  assert.equal(result.status, 'ok');
  assert.equal(result.digest, digestOf(index));
  assert.deepEqual(result.platforms, ['linux/amd64', 'linux/arm64']);
  assert.deepEqual(calls, [
    'GET ghcr.io/v2/home-operations/radarr/manifests/6.4.4',
    'GET ghcr.io/token?service=ghcr.io&scope=repository%3Ahome-operations%2Fradarr%3Apull',
    'GET ghcr.io/v2/home-operations/radarr/manifests/6.4.4',
  ]);
});

test('a pinned digest is verified itself; a moved tag is reported without failing', async () => {
  const pinned = digestOf(index);
  const retagged = JSON.stringify({ ...JSON.parse(index), annotations: { rebuilt: 'yes' } });
  const { fetch, calls } = registry({
    [`/v2/home-operations/radarr/manifests/${pinned}`]: manifestBody(index),
    '/v2/home-operations/radarr/manifests/6.4.4': manifestBody(retagged),
  });
  const moved = await checkImage(`ghcr.io/home-operations/radarr:6.4.4@${pinned}`, { fetch });
  assert.equal(moved.status, 'tag-moved');
  assert.equal(moved.digest, pinned);
  assert.deepEqual(moved.platforms, ['linux/amd64', 'linux/arm64']);
  assert.match(moved.detail, /tag 6\.4\.4 now resolves to sha256:[0-9a-f]+; the pinned digest still pulls/);
  assert.equal(hasFailures([moved]), false);
  assert.ok(calls.some(call => call.endsWith(`/manifests/${pinned}`)));

  const gone = await checkImage(`ghcr.io/home-operations/radarr:9.9.9@${pinned}`, { fetch });
  assert.equal(gone.status, 'tag-moved');
  assert.match(gone.detail, /tag 9\.9\.9 no longer exists/);
  const current = await checkImage(`ghcr.io/home-operations/radarr:6.4.4@${digestOf(retagged)}`, {
    fetch: registry({ [`/v2/home-operations/radarr/manifests/${digestOf(retagged)}`]: manifestBody(retagged), '/v2/home-operations/radarr/manifests/6.4.4': manifestBody(retagged) }).fetch,
  });
  assert.equal(current.status, 'ok');
  assert.equal((await checkImage('ghcr.io/home-operations/radarr:6.4.4@sha256:0000', { fetch })).status, 'missing');
});

test('detects missing tags and absent platforms', async () => {
  const { fetch } = registry({ '/v2/home-operations/radarr/manifests/6.4.4': manifestBody(index) });
  const missing = await checkImage('ghcr.io/home-operations/radarr:7.0.0', { fetch });
  assert.equal(missing.status, 'missing');
  assert.match(missing.detail, /radarr:7\.0\.0 not found/);
  const armOnly = await checkImage('ghcr.io/home-operations/radarr:6.4.4', { fetch, platforms: ['linux/arm/v7'] });
  assert.equal(armOnly.status, 'platform-missing');
  assert.match(armOnly.detail, /linux\/arm\/v7/);
});

test('inspects the config blob of single-platform manifests and tolerates registries without challenges', async () => {
  const single = JSON.stringify({ mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: 'sha256:cfg' } });
  const { fetch, calls } = registry({
    '/v2/library/busybox/manifests/1.37.0': manifestBody(single),
    '/v2/library/busybox/blobs/sha256:cfg': () => Response.json({ os: 'linux', architecture: 'arm64' }),
  }, { requireToken: false });
  const result = await checkImage('busybox:1.37.0', { fetch });
  assert.equal(result.status, 'platform-missing');
  assert.deepEqual(result.platforms, ['linux/arm64']);
  assert.deepEqual(calls, ['GET registry-1.docker.io/v2/library/busybox/manifests/1.37.0', 'GET registry-1.docker.io/v2/library/busybox/blobs/sha256:cfg']);
});

test('reports registry errors without throwing and deduplicates image lists', async () => {
  const { fetch } = registry({ '/v2/a/b/manifests/1': () => new Response('', { status: 500 }) });
  const results = await checkImages(['ghcr.io/a/b:1', 'ghcr.io/a/b:1', ' '], { fetch });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.status, 'error');
  assert.match(results[0]!.detail, /500/);
  const offline = await checkImage('ghcr.io/a/b:1', { fetch: (async () => { throw new Error('ECONNRESET'); }) as typeof fetch });
  assert.equal(offline.status, 'error');
  assert.equal(hasFailures([offline]), true);
  assert.equal(hasFailures([{ image: 'x', status: 'ok', platforms: [], detail: '' }]), false);
});

test('renders a Markdown table and an empty-change message', () => {
  assert.equal(renderImageReport([], ['linux/amd64']), 'No container images changed.');
  const report = renderImageReport([
    { image: 'ghcr.io/a/b:1', status: 'ok', platforms: ['linux/amd64'], detail: '' },
    { image: 'ghcr.io/a/c:2', status: 'missing', platforms: [], detail: 'not found' },
  ], ['linux/amd64']);
  assert.match(report, /^1 of 2 changed images failed verification\./);
  assert.match(report, /\| `ghcr\.io\/a\/b:1` \| ✅ available \| linux\/amd64 \|/);
  assert.match(report, /❌ not found \| not found/);
});

test('check-images entry point writes the report, sets outputs and fails on bad images', async () => {
  const { fetch } = registry({ '/v2/a/b/manifests/1': manifestBody(index) });
  const files: Record<string, string> = { 'images.json': JSON.stringify(['ghcr.io/a/b:1', 'ghcr.io/a/missing:9']) };
  const outputs: Record<string, string> = {};
  const deps = {
    core: { setOutput: (name: string, value: string) => { outputs[name] = value; }, info: () => {} },
    env: { IMAGES_FILE: 'images.json', REPORT_FILE: 'report.md', PLATFORMS: 'linux/amd64' },
    fetch,
    read: (file: string) => files[file] ?? (() => { throw new Error('missing'); })(),
    write: (file: string, content: string) => { files[file] = content; },
  };
  await assert.rejects(runCheckImages(deps), /Image verification failed:[\s\S]*ghcr\.io\/a\/missing:9/);
  assert.equal(outputs.checked, '2');
  assert.equal(outputs.failed, '1');
  assert.match(files['report.md']!, /not found/);

  files['images.json'] = '[]';
  await runCheckImages(deps);
  assert.equal(files['report.md'], 'No container images changed.');
  await assert.rejects(runCheckImages({ ...deps, env: { ...deps.env, IMAGES_FILE: 'nope.json' } }), /Unable to read nope\.json/);
  files['bad.json'] = '{"not":"a list"}';
  await assert.rejects(runCheckImages({ ...deps, env: { ...deps.env, IMAGES_FILE: 'bad.json' } }), /JSON array/);
});
