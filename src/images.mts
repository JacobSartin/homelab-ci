import { createHash } from 'node:crypto';

// Verify container image references against their registries without any
// registry CLI: anonymous token exchange, manifest fetch, digest comparison and
// platform inspection follow the OCI distribution specification.

export interface ImageRef {
  raw: string;
  registry: string;
  repository: string;
  tag?: string;
  digest?: string;
}

export type ImageStatus = 'ok' | 'missing' | 'digest-mismatch' | 'platform-missing' | 'error';

export interface ImageResult {
  image: string;
  status: ImageStatus;
  digest?: string;
  platforms: string[];
  detail: string;
}

export interface CheckOptions {
  fetch?: typeof fetch;
  platforms?: string[];
  concurrency?: number;
}

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export function parseImage(raw: string): ImageRef {
  let rest = raw.trim();
  let digest: string | undefined;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | undefined;
  const lastSlash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split('/');
  const first = parts[0] ?? '';
  const looksLikeRegistry = parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  let registry = looksLikeRegistry ? first : 'docker.io';
  let repository = looksLikeRegistry ? parts.slice(1).join('/') : parts.join('/');
  if (registry === 'docker.io' || registry === 'index.docker.io') {
    registry = 'registry-1.docker.io';
    if (!repository.includes('/')) repository = `library/${repository}`;
  }
  if (!repository) throw new Error(`Invalid image reference: ${raw}`);
  if (!tag && !digest) tag = 'latest';
  return { raw: raw.trim(), registry, repository, tag, digest };
}

function parseChallenge(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) params[match[1]!] = match[2]!;
  return params;
}

async function fetchManifest(ref: ImageRef, reference: string, fetchImpl: typeof fetch): Promise<Response> {
  const url = `https://${ref.registry}/v2/${ref.repository}/manifests/${reference}`;
  const headers: Record<string, string> = { Accept: MANIFEST_TYPES };
  let response = await fetchImpl(url, { headers });
  if (response.status !== 401) return response;
  const challenge = response.headers.get('www-authenticate') ?? '';
  if (!challenge.toLowerCase().startsWith('bearer')) return response;
  const { realm, service, scope } = parseChallenge(challenge);
  if (!realm) return response;
  const tokenUrl = new URL(realm);
  if (service) tokenUrl.searchParams.set('service', service);
  tokenUrl.searchParams.set('scope', scope || `repository:${ref.repository}:pull`);
  const tokenResponse = await fetchImpl(tokenUrl.toString());
  if (!tokenResponse.ok) return response;
  const body = await tokenResponse.json() as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  if (!token) return response;
  response = await fetchImpl(url, { headers: { ...headers, Authorization: `Bearer ${token}` } });
  return response;
}

interface Manifest {
  mediaType?: string;
  manifests?: Array<{ platform?: { os?: string; architecture?: string; variant?: string } }>;
  config?: { digest: string };
}

function platformsOf(manifest: Manifest): string[] | undefined {
  if (!manifest.manifests) return undefined;
  return manifest.manifests
    .map(entry => entry.platform)
    .filter((platform): platform is NonNullable<typeof platform> => Boolean(platform))
    .filter(platform => platform.os !== 'unknown' && platform.architecture !== 'unknown')
    .map(platform => `${platform.os}/${platform.architecture}${platform.variant ? `/${platform.variant}` : ''}`);
}

export async function checkImage(raw: string, { fetch: fetchImpl = fetch, platforms = ['linux/amd64'] }: CheckOptions = {}): Promise<ImageResult> {
  let ref: ImageRef;
  try {
    ref = parseImage(raw);
  } catch (error) {
    return { image: raw, status: 'error', platforms: [], detail: (error as Error).message };
  }
  try {
    // Resolve by tag when present so a pinned digest is compared against what
    // the tag currently points to; otherwise resolve by digest.
    const reference = ref.tag ?? ref.digest!;
    const response = await fetchManifest(ref, reference, fetchImpl);
    if (response.status === 404) {
      return { image: raw, status: 'missing', platforms: [], detail: `${ref.registry}/${ref.repository}:${reference} not found` };
    }
    if (!response.ok) {
      return { image: raw, status: 'error', platforms: [], detail: `registry responded ${response.status} for ${reference}` };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (ref.digest && ref.tag && ref.digest !== digest) {
      return { image: raw, status: 'digest-mismatch', digest, platforms: [], detail: `tag ${ref.tag} resolves to ${digest}, not the pinned ${ref.digest}` };
    }
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
    let available = platformsOf(manifest);
    if (!available) {
      available = [];
      if (manifest.config?.digest) {
        const blob = await fetchBlob(ref, manifest.config.digest, fetchImpl);
        if (blob) available.push(`${blob.os}/${blob.architecture}${blob.variant ? `/${blob.variant}` : ''}`);
      }
    }
    const missing = platforms.filter(platform => !available!.some(candidate => candidate === platform || candidate.startsWith(`${platform}/`)));
    if (available.length > 0 && missing.length > 0) {
      return { image: raw, status: 'platform-missing', digest, platforms: available, detail: `no manifest for ${missing.join(', ')}` };
    }
    return { image: raw, status: 'ok', digest, platforms: available, detail: available.length ? '' : 'platform not reported by registry' };
  } catch (error) {
    return { image: raw, status: 'error', platforms: [], detail: (error as Error).message };
  }
}

async function fetchBlob(ref: ImageRef, digest: string, fetchImpl: typeof fetch): Promise<{ os?: string; architecture?: string; variant?: string } | undefined> {
  const url = `https://${ref.registry}/v2/${ref.repository}/blobs/${digest}`;
  let response = await fetchImpl(url, { redirect: 'follow' });
  if (response.status === 401) {
    // Reuse the manifest challenge flow by requesting the manifest first; most
    // registries honor the same token for blobs.
    const challenge = response.headers.get('www-authenticate') ?? '';
    const { realm, service, scope } = parseChallenge(challenge);
    if (!realm) return undefined;
    const tokenUrl = new URL(realm);
    if (service) tokenUrl.searchParams.set('service', service);
    tokenUrl.searchParams.set('scope', scope || `repository:${ref.repository}:pull`);
    const tokenResponse = await fetchImpl(tokenUrl.toString());
    if (!tokenResponse.ok) return undefined;
    const body = await tokenResponse.json() as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) return undefined;
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow' });
  }
  if (!response.ok) return undefined;
  return await response.json() as { os?: string; architecture?: string; variant?: string };
}

export async function checkImages(images: string[], options: CheckOptions = {}): Promise<ImageResult[]> {
  const unique = [...new Set(images.map(image => image.trim()).filter(Boolean))].sort();
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const results: ImageResult[] = new Array(unique.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < unique.length) {
      const index = next++;
      results[index] = await checkImage(unique[index]!, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return results;
}

const STATUS_LABEL: Record<ImageStatus, string> = {
  ok: '✅ available',
  missing: '❌ not found',
  'digest-mismatch': '❌ digest mismatch',
  'platform-missing': '❌ platform missing',
  error: '⚠️ check failed',
};

export function hasFailures(results: ImageResult[]): boolean {
  return results.some(result => result.status !== 'ok');
}

export function renderImageReport(results: ImageResult[], platforms: string[]): string {
  if (results.length === 0) return 'No container images changed.';
  const rows = results.map(result => {
    const detail = result.detail || result.platforms.join(', ');
    return `| \`${result.image}\` | ${STATUS_LABEL[result.status]} | ${detail} |`;
  });
  const failures = results.filter(result => result.status !== 'ok').length;
  const heading = failures === 0
    ? `All ${results.length} changed image${results.length === 1 ? '' : 's'} resolve for ${platforms.join(', ')}.`
    : `${failures} of ${results.length} changed image${results.length === 1 ? '' : 's'} failed verification.`;
  return [heading, '', '| Image | Status | Detail |', '| --- | --- | --- |', ...rows].join('\n');
}
