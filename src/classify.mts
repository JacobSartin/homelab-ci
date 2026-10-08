// Classify what a change touches from Flate's rendered diff, so jobs can run
// per kind of update without relying on Renovate labels or file paths.

export interface ChangedObject {
  apiVersion: string;
  kind: string;
  namespace: string;
  name: string;
  paths: string[];
}

export interface Classification {
  images: string[];
  objects: ChangedObject[];
  helmReleases: string[];
  kustomizations: string[];
  kinds: string[];
}

// `flate diff ... -o github` prints `@@ <path> @@` followed by
// `# <apiVersion>/<Kind>/<namespace>/<name>` for every changed field.
export function parseGitHubDiff(diff: string): ChangedObject[] {
  const objects = new Map<string, ChangedObject>();
  let path = '';
  for (const line of diff.split(/\r?\n/)) {
    const pathMatch = /^@@ (.*) @@$/.exec(line);
    if (pathMatch) {
      path = pathMatch[1]!;
      continue;
    }
    const idMatch = /^# (\S+)$/.exec(line);
    if (!idMatch) continue;
    const parts = idMatch[1]!.split('/');
    if (parts.length < 3) continue;
    const name = parts.pop()!;
    const namespace = parts.pop()!;
    const kind = parts.pop()!;
    const apiVersion = parts.join('/');
    const key = `${apiVersion}/${kind}/${namespace}/${name}`;
    const object = objects.get(key) ?? { apiVersion, kind, namespace, name, paths: [] };
    if (path && !object.paths.includes(path)) object.paths.push(path);
    objects.set(key, object);
  }
  return [...objects.values()];
}

export function classify(diff: string, images: string[]): Classification {
  const objects = parseGitHubDiff(diff);
  const named = (kind: string): string[] => objects.filter(object => object.kind === kind).map(object => `${object.namespace}/${object.name}`).sort();
  return {
    images: [...new Set(images)].sort(),
    objects,
    helmReleases: named('HelmRelease'),
    kustomizations: named('Kustomization'),
    kinds: [...new Set(objects.map(object => object.kind))].sort(),
  };
}
