#!/usr/bin/env bash
set -euo pipefail

resolve_ssh_alias() {
  if [[ -n "${SSH_ALIAS:-}" ]]; then
    printf '%s\n' "$SSH_ALIAS"
    return 0
  fi

  local env_file
  for env_file in .env.local .env; do
    if [[ -f "$env_file" ]]; then
      local line
      line="$(grep -E '^SSH_ALIAS=' "$env_file" | tail -n 1 || true)"
      if [[ -n "$line" ]]; then
        line="${line#SSH_ALIAS=}"
        line="${line%\"}"
        line="${line#\"}"
        line="${line%\'}"
        line="${line#\'}"
        if [[ -n "$line" ]]; then
          printf '%s\n' "$line"
          return 0
        fi
      fi
    fi
  done

  return 1
}

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 '<remote command>'" >&2
  exit 1
fi

if ! ssh_alias="$(resolve_ssh_alias)"; then
  echo "SSH_ALIAS is not set in the environment or env files" >&2
  exit 1
fi

ssh "$ssh_alias" "$*"
