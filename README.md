# homelab-ci

Shared GitHub Actions for the homelab GitOps repositories (`cluster`,
`media-cluster`, and any future Flux repository). Consumers call two reusable
workflows; everything else lives here so a change is tested once and picked up
everywhere.

## What the validation checks

`.github/workflows/validate.yaml` runs on every pull request of a consumer:

| Job | What it proves |
| --- | --- |
| Render | [Flate](https://github.com/home-operations/flate) reconciles the whole repository offline: every Kustomization and HelmRelease renders, including Helm charts and `valuesFrom` ConfigMaps. Failed, blocked, or unexpectedly skipped resources fail the job. The diff against the base branch is rendered too. |
| Schemas | Kubeconform validates the rendered manifests (Helm output included) against upstream Kubernetes and CRD schemas. |
| Images | Every container image the pull request introduces is checked against its registry: the tag exists, a pinned digest still matches the tag, and the image provides the required platforms. |
| Report | One pull request comment with the render summary, schema result, image table, warnings and the rendered diff. |
| GitOps validation | The single status Renovate automerge waits for. |

A Renovate image update therefore gets a rendered diff showing the new image,
a registry lookup proving it can be pulled, and a schema check, instead of
skipping validation.

`.github/workflows/automerge.yaml` merges validated Renovate pull requests one
at a time, holding the queue after each merge so Flux can roll it out, and
assigns the maintainer when a pull request needs attention. With a GitHub App
token it can merge pull requests that change workflow files, which the default
workflow token cannot.

## Consuming the workflows

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
      pull-requests: write
    with:
      runner: actions-runner
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

Automerge is triggered from the validation workflow run:

```yaml
# .github/workflows/automerge.yaml
on:
  workflow_run:
    workflows: ["Pull Request: Validate"]
    types: [completed]
concurrency:
  group: renovate-automerge
  queue: max
permissions:
  contents: write
  issues: write
  pull-requests: write
jobs:
  automerge:
    if: github.event.workflow_run.event == 'pull_request'
    uses: JacobSartin/homelab-ci/.github/workflows/automerge.yaml@main
    permissions:
      contents: write
      issues: write
      pull-requests: write
    with:
      runner: actions-runner
    secrets:
      app-id: ${{ secrets.BOT_APP_ID }}
      app-private-key: ${{ secrets.BOT_APP_PRIVATE_KEY }}
```

The secrets are optional. Without them the workflow token merges, and pull
requests touching `.github/workflows/` end with the `workflow_permission`
outcome and a notification instead of a silent retry loop. The GitHub App
needs `contents: write`, `pull_requests: write` and `workflows: write`.

Keep the queued concurrency group in the caller: GitHub applies a called
workflow's jobs under the caller's concurrency settings.

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

- `.github/workflows/validate.yaml`, `automerge.yaml`: reusable workflows. They
  check out this repository at `job.workflow_sha`, so the actions always match
  the workflow revision a consumer referenced.
- `actions/*`: composite actions. Shell does the rendering; TypeScript in
  `src/` makes the decisions and talks to GitHub through `actions/github-script`,
  which runs `.mts` files without a build step.
- `src/`: exported functions with injectable dependencies; `tests/` exercises
  the same code the actions load.
- `fixtures/cluster`: minimal Flux repository used by the end-to-end job.

Node erases types without checking them; run `npm run typecheck` separately.
