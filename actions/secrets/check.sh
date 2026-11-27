#!/usr/bin/env bash
# Fail when a secret is committed in plaintext. Every tracked file a
# .sops.yaml creation rule matches, and every *.sops.* file, must be
# SOPS-encrypted, and gitleaks must find nothing in the tree. Pre-commit hooks
# check the same locally, but Renovate, web edits and --no-verify skip them.
set -euo pipefail

mapfile -t tracked < <(git ls-files)

# Creation rules match paths relative to the directory of their .sops.yaml.
# path_regex values are read with sed, so they must sit on one line.
candidates=()
for config in "${tracked[@]}"; do
  case ${config##*/} in .sops.yaml | .sops.yml) ;; *) continue ;; esac
  dir=$(dirname "$config")
  prefix=
  [[ "$dir" == . ]] || prefix="$dir/"
  while IFS= read -r regex; do
    [[ -n "$regex" ]] || continue
    for file in "${tracked[@]}"; do
      [[ "$file" == "$prefix"* ]] || continue
      if printf '%s\n' "${file#"$prefix"}" | grep -Eq -- "$regex"; then
        candidates+=("$file")
      fi
    done
  done < <(sed -n -E "s/^[[:space:]-]*path_regex:[[:space:]]*['\"]?([^'\"]*)['\"]?[[:space:]]*$/\1/p" "$config")
done
for file in "${tracked[@]}"; do
  case ${file##*/} in
    .sops.yaml | .sops.yml) ;;
    *.sops.*) candidates+=("$file") ;;
  esac
done

# Keys under data/stringData whose value is not ENC[...]. Names only: the log is public.
plain_keys() {
  awk '
    { sub(/\r$/, "") }
    /^[^ #-]/ { top = $0; sub(/:.*/, "", top) }
    (top == "data" || top == "stringData") && /^ +[^ #][^:]*: *[^ ]/ &&
      !/ENC\[AES256_GCM,/ && !/: *(""|\047\047) *$/ {
      key = $0; sub(/^ +/, "", key); sub(/:.*/, "", key); printf "%s%s", sep, key; sep = ", "
    }
  ' "$1"
}

failed=0
checked=0
if ((${#candidates[@]})); then
  while IFS= read -r file; do
    checked=$((checked + 1))
    status=$(sops filestatus "$file" 2>&1) || :
    case $status in
      *'"encrypted":true'*)
        # filestatus only looks for sops metadata, so a value added by hand passes it.
        keys=$(plain_keys "$file")
        if [[ -n "$keys" ]]; then
          echo "::error file=$file::Plaintext value in an encrypted file ($keys); remove it and set it with 'sops set'"
          failed=1
        fi
        ;;
      *)
        echo "::error file=$file::Not SOPS-encrypted; run 'sops encrypt --in-place $file' before committing"
        failed=1
        ;;
    esac
  done < <(printf '%s\n' "${candidates[@]}" | sort -u)
fi
echo "Checked $checked SOPS file(s)."

if ! gitleaks dir . --redact --no-banner; then
  echo "::error::gitleaks found possible secrets; move them into SOPS, or allowlist false positives in .gitleaks.toml"
  failed=1
fi

exit "$failed"
