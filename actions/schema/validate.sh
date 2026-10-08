#!/usr/bin/env bash
# Schema-validate Flate's rendered output with Kubeconform. Flate replaces
# SOPS-backed postBuild variables with ..PLACEHOLDER_NAME.. tokens and leaves
# unresolved ${NAME} references alone; both are substituted first so hostname
# and address patterns validate against realistic values.
set -euo pipefail

: "${RENDERED_FILE:?RENDERED_FILE is required}"
: "${REPORT_FILE:?REPORT_FILE is required}"
: "${SCHEMA_LOCATION:?SCHEMA_LOCATION is required}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
script="$work/substitutions.sed"
: > "$script"

while IFS='=' read -r name value; do
  [[ -z "$name" ]] && continue
  if [[ ! "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "::error::Invalid substitution name: $name"
    exit 1
  fi
  escaped=$(printf '%s' "$value" | sed 's/[&|\]/\&/g')
  printf 's|\.\.PLACEHOLDER_%s\.\.|%s|g\n' "$name" "$escaped" >> "$script"
  # The ${NAME} text is a literal sed pattern, not a shell expansion.
  # shellcheck disable=SC2016
  printf 's|\${%s}|%s|g\n' "$name" "$escaped" >> "$script"
done <<< "${SUBSTITUTIONS:-}"
printf 's|\.\.PLACEHOLDER_[A-Za-z0-9_]*\.\.|placeholder|g\n' >> "$script"
# shellcheck disable=SC2016
printf 's|\${[A-Za-z_][A-Za-z0-9_]*}|placeholder|g\n' >> "$script"
sed -f "$script" "$RENDERED_FILE" > "$work/rendered.yaml"

skip="Secret,ConfigMap"
if [[ -n "${SKIP_KINDS:-}" ]]; then
  extra=$(printf '%s\n' "$SKIP_KINDS" | tr ',' '\n' | sed '/^[[:space:]]*$/d' | paste -sd, -)
  [[ -n "$extra" ]] && skip="$skip,$extra"
fi

set +e
kubeconform \
  -strict \
  -ignore-missing-schemas \
  -skip "$skip" \
  -schema-location default \
  -schema-location "$SCHEMA_LOCATION" \
  -summary \
  -output text \
  "$work/rendered.yaml" > "$work/kubeconform.txt" 2>&1
status=$?
set -e

cat "$work/kubeconform.txt"
summary=$(grep -E '^Summary:' "$work/kubeconform.txt" | sed 's/^Summary: //' || true)
problems=$(grep -vE '^Summary:' "$work/kubeconform.txt" | sed -E 's|^[^ ]*rendered\.yaml - ||' || true)
{
  if (( status == 0 )); then
    echo "✅ Kubeconform: ${summary:-no output}."
  else
    echo "❌ Kubeconform: ${summary:-exited with $status}."
    echo
    echo '```'
    echo "$problems"
    echo '```'
  fi
} > "$REPORT_FILE"
exit "$status"
