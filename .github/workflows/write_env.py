#!/usr/bin/env python3
"""Materialize .env.local in the workspace from env vars injected from GH Secrets.

deploy.sh's tar step includes the workspace root, so .env.local written here
ships to the server and lands next to the code after extraction — before
`next build` and `pm2 startOrReload` run.
"""
import os
import sys

KEYS = [
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "OPENAI_API_KEY",
    "FIRECRAWL_API_KEY",
    "META_AD_ACCOUNT_ID",
    "META_PAGE_ID",
    "META_SYSTEM_TOKEN",
    "WA_VERIFY_TOKEN",
    "WA_SYSTEM_TOKEN",
    "REVO_SCM_API_KEY",
    "CRON_SECRET",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_CHAT_ID",
]


def needs_quoting(value: str) -> bool:
    return any(c in value for c in (" ", "\t", "#", '"', "'", "\\", "\n"))


def format_line(key: str, value: str) -> str:
    if needs_quoting(value):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
        return f'{key}="{escaped}"'
    return f"{key}={value}"


def main() -> int:
    missing = []
    lines = []
    for key in KEYS:
        val = os.environ.get(key)
        if val is None or val == "":
            missing.append(key)
            continue
        lines.append(format_line(key, val))

    if missing:
        print(f"missing secrets (not written): {missing}", file=sys.stderr)
        # Fail: running prod without env vars is worse than a loud failure.
        return 1

    with open(".env.local", "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote .env.local with {len(lines)} keys")
    return 0


if __name__ == "__main__":
    sys.exit(main())
