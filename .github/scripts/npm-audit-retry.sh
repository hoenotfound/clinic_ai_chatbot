#!/usr/bin/env bash
# Keep security audits required; retry only npm registry transport/backend
# failures. A real vulnerability report remains a hard CI failure.
set -euo pipefail

for attempt in 1 2 3; do
  report="$(mktemp)"
  status=0
  timeout 90s npm audit "$@" >"$report" 2>&1 || status=$?
  cat "$report"

  if [ "$status" -eq 0 ]; then
    rm -f "$report"
    exit 0
  fi

  # Do not retry (or mask) a successful advisory response reporting genuine
  # moderate+ vulnerabilities. Only retry failures to query the registry.
  if [ "$status" -ne 124 ] && ! grep -Eiq \
    'npm warn audit (400|408|429|5[0-9][0-9])|audit endpoint returned an error|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|Service Unavailable|Bad Gateway|Gateway Timeout' \
    "$report"; then
    rm -f "$report"
    exit "$status"
  fi

  rm -f "$report"
  if [ "$attempt" -eq 3 ]; then
    echo "npm security audit could not reach a healthy registry after 3 attempts." >&2
    exit "$status"
  fi
  echo "npm registry audit unavailable (attempt $attempt/3); retrying." >&2
  sleep $((attempt * 5))
done
