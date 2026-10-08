#!/usr/bin/env bash
# Render a Flux repository with Flate and leave machine-readable results in
# OUTPUT_DIR for the evaluation, schema, image and report steps.
set -euo pipefail

: "${OUTPUT_DIR:?OUTPUT_DIR is required}"
path=${FLATE_PATH:-.}
mkdir -p "$OUTPUT_DIR"

# The install action exports FLATE_BASE=<default branch>; diffs pass --base
# explicitly and every other command must render the full tree.
export FLATE_BASE=""
export FLATE_NO_PROGRESS=true

echo "::group::flate test all"
test_status=0
flate test all --path "$path" | tee "$OUTPUT_DIR/test.txt" || test_status=$?
echo "::endgroup::"
if (( test_status != 0 )); then
  echo "flate test exited with $test_status; the evaluation step reports the failing resources."
fi

echo "::group::flate build all"
flate build all --path "$path" > "$OUTPUT_DIR/rendered.yaml"
echo "::endgroup::"

if [[ -n "${RENDER_BASE:-}" ]]; then
  echo "::group::flate diff all --base $RENDER_BASE"
  if ! flate diff all --path "$path" --base "$RENDER_BASE" -o github > "$OUTPUT_DIR/diff.md"; then
    echo "::warning::Flate could not diff against $RENDER_BASE; the current revision was still validated."
    printf '! Diff unavailable: the baseline revision %s did not render. The current revision passed validation.\n' "$RENDER_BASE" > "$OUTPUT_DIR/diff.md"
  fi
  echo "::endgroup::"
  echo "::group::flate diff images --base $RENDER_BASE"
  if ! flate diff images --path "$path" --base "$RENDER_BASE" -o json > "$OUTPUT_DIR/images.json"; then
    echo "::warning::Flate could not list changed images; verifying every image instead."
    flate get images --path "$path" -o json > "$OUTPUT_DIR/images.json"
  fi
  echo "::endgroup::"
else
  : > "$OUTPUT_DIR/diff.md"
  echo "::group::flate get images"
  flate get images --path "$path" -o json > "$OUTPUT_DIR/images.json"
  echo "::endgroup::"
fi
