# homelab-ci

Shared GitHub Actions for the homelab GitOps repositories (`cluster`,
`media-cluster`, and any future Flux repository). Consumers call one reusable
workflow; everything else lives here so a change is tested once and picked up
everywhere.

## What the validation checks

`.github/workflows/validate.yaml` runs on every pull request of a consumer:

| Job | What it proves |
| --- | --- |
| Render | [Flate](https://github.com/home-operations/flate) reconciles the whole repository offline: every Kustomization and HelmRelease renders, including Helm charts and `valuesFrom` ConfigMaps. Failed, blocked, or unexpectedly skipped resources fail the job. The diff against the base branch is rendered and classified. |
| Schemas | Kubeconform validates the rendered manifests (Helm output included) against upstream Kubernetes and CRD schemas. |
| Images | Runs when the diff introduces container images. Each one is checked against its registry: the reference the cluster will pull (the pinned digest, or the tag) exists and provides the required platforms. A tag that has moved away from its pinned digest is reported as a warning, since the digest still pulls and Renovate will propose the update. |
| Report | One pull request comment with the render summary, schema result, image table, warnings and the rendered diff. When a check failed, the comment leads with a mention of `assignee` and assigns them, so the failure notifies someone. |
| GitOps validation | The single status Renovate waits for before merging. |

A Renovate image update therefore gets a rendered diff showing the new image
and a registry lookup proving it can be pulled; a chart update gets the full
rendered diff of the chart and a schema check of its output.

## Consuming the workflow

```yaml
# .github/workflows/pr-validate.yaml
on:
  pull_request:
    branches: [main]
  workflow_dispatch:
jobs:
  validate:
    uses: JacobSartin/homelab-ci/.github/workflows/validate.yaml@main
    permissions:
      contents: read
      issues: write
      pull-requests: write
    with:
      runner: actions-runner
      assignee: JacobSartin
      api-versions: monitoring.coreos.com/v1
      allowed-skips: |-
        flux-system/media-cluster
      substitutions: |-
        BASE_DOMAIN=example.invalid
      kubeconform-skip: |-
        tuppr.home-operations.com/v1alpha1/TalosUpgrade
```

Inputs:

- `path`: Flux root to render, relative to the repository (default `.`).
- `api-versions`: comma-separated API versions charts may assume, such as
  `monitoring.coreos.com/v1` for ServiceMonitor templates.
- `allowed-skips`: sources only the live cluster can fetch, one
  `namespace/name` or `Kind namespace/name` per line. Suspended stand-in
  Kustomizations never need listing. Any other skipped resource fails the
  render, because a skipped source silently hides every resource behind it.
- `substitutions`: `NAME=value` lines replacing Flux `postBuild` variables that
  come from SOPS secrets before schema validation. Unknown placeholders become
  `placeholder`.
- `kubeconform-skip`: kinds (or `group/version/kind`) without usable schemas.
- `platforms`: platforms every changed image must provide (default
  `linux/amd64`).
- `assignee`: user mentioned and assigned on the pull request when validation
  fails. Needs `issues: write` from the caller.

## Running checks per kind of change

The render job classifies the rendered diff and exposes the result as workflow
outputs, so checks can be scoped to what actually changed without relying on
Renovate labels or file paths:

| Output | Meaning |
| --- | --- |
| `images-changed` | `true` when the diff introduces container images |
| `helmreleases-changed` | `true` when a HelmRelease object changed (chart version, values, source) |
| `kustomizations-changed` | `true` when a Flux Kustomization object changed |
| `changed-kinds` | comma-separated kinds of rendered objects that changed |
| `changed-helmreleases`, `changed-kustomizations` | comma-separated `namespace/name` lists |

The `Images` job is the in-tree example: it runs only when `images-changed` is
`true`. Add a kind-specific check either here, as a job in `validate.yaml`
conditioned on these outputs (then make the `GitOps validation` job expect it),
or in a consumer as a job that `needs: validate` and reads
`needs.validate.outputs.<name>`. The full classification, including each
changed object and the fields that changed, is in `classification.json` inside
the `gitops-render` artifact.

## Automerge

Renovate merges its own pull requests once the `GitOps validation` check is
green; the policy lives in `cluster/.github/renovate/merge_policy.json5` and
is inherited by every consumer. Renovate's App token may merge workflow-file
changes, and `rebaseWhen: behind-base-branch` rebases and revalidates a pull
request that fell behind before merging it, so two updates to the same file no
longer block each other. No automerge workflow runs in the consumers.

## Modelling cross-repository dependencies

Flate renders one repository at a time. A Kustomization that `dependsOn`
something another repository provides is reported as blocked. Add a suspended
stand-in Kustomization with the same name to the repository (see
`fixtures/cluster/flux/external.yaml`); it resolves the dependency without
rendering anything, and the render job tells you exactly which name is missing
when a new dependency appears.

A self-referencing `GitRepository` with an SSH deploy key is aliased to the
checkout automatically because its URL matches the repository remote. Sources
pointing at other repositories cannot be fetched without their keys; list them
in `allowed-skips`.

## Development

Use Node 24.13 or newer within Node 24.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
actionlint -config-file .github/actionlint.yaml
shellcheck actions/*/*.sh
```

Tests stub Flate, Kubeconform and the GitHub and registry APIs; the fixture in
`fixtures/cluster` is rendered for real by the `Fixture` job of `ci.yaml`, so a
pull request here exercises the reusable workflow end to end before consumers
pick the change up from `main`.

Layout:

- `.github/workflows/validate.yaml`: the reusable workflow. It checks out this
  repository at `job.workflow_sha`, so the actions always match the workflow
  revision a consumer referenced.
- `actions/*`: composite actions. Shell does the rendering; TypeScript in
  `src/` makes the decisions and talks to GitHub through `actions/github-script`,
  which runs `.mts` files without a build step.
- `src/`: exported functions with injectable dependencies; `tests/` exercises
  the same code the actions load.
- `fixtures/cluster`: minimal Flux repository used by the end-to-end job.

Node erases types without checking them; run `npm run typecheck` separately.
