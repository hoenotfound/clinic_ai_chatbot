#!/usr/bin/env bash
# Retry npm audit ONLY when the npm registry or network is temporarily
# unavailable. Never mask a security finding or a persistent registry outage.
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "Usage: bash .github/scripts/npm-audit-with-retry.sh [npm audit flags]" >&2
  exit 2
fi

max_attempts=3
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

for (( attempt=1; attempt<=max_attempts; attempt++ )); do
  echo "npm audit attempt ${attempt}/${max_attempts}"
  # Avoid npm's own multi-minute fetch retry stack. We own the bounded retry
  # policy so a temporary registry outage does not stall the CI job indefinitely.
  if npm_config_fetch_retries=0 npm_config_fetch_timeout=30000 \
     npm audit "$@" >"$log" 2>&1; then
    cat "$log"
    exit 0
  fi

  cat "$log"

  # npm audit returns nonzero both for genuine vulnerability findings and for
  # registry problems. Retry only errors positively identified as transient;
  # keep the normal audit threshold and fail immediately for vulnerabilities.
  if ! grep -Eiq \
      'audit endpoint returned an error|Service Unavailable|Bad Gateway|Gateway Timeout|Too Many Requests|EAI_AGAIN|ECONNRESET|ETIMEDOUT|E502|E503|E504|E429' \
      "$log"; then
    echo "npm audit failed for a non-retryable reason (including security findings)." >&2
    exit 1
  fi

  if (( attempt == max_attempts )); then
    echo "npm audit registry/network error persists after ${max_attempts} attempts; failing CI." >&2
    exit 1
  fi

  echo "Transient npm audit service error; retrying without waiving the security gate." >&2
  sleep $((attempt * 5))
done
exit 1
