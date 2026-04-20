#!/usr/bin/env python3
import json
import os
import sys
import urllib.request


def env(name: str) -> str:
    return os.environ.get(name, "") or ""


def http_post(url: str, headers: dict, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8", **headers},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    app_id = env("FEISHU_APP_ID")
    app_secret = env("FEISHU_APP_SECRET")
    chat_id = env("FEISHU_CHAT_ID")

    token_resp = http_post(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        {},
        {"app_id": app_id, "app_secret": app_secret},
    )
    token = token_resp.get("tenant_access_token")
    if not token:
        print("failed to get tenant_access_token:", token_resp, file=sys.stderr)
        return 1

    status = env("DEPLOY_STATUS")
    repo = env("REPO")
    if status == "success":
        title = f"✅ 部署成功 | {repo}"
        color = "green"
    else:
        title = f"❌ 部署失败 | {repo}"
        color = "red"

    commit_sha = env("COMMIT_SHA")
    card = {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": color,
        },
        "elements": [
            {
                "tag": "div",
                "fields": [
                    {"is_short": True, "text": {"tag": "lark_md", "content": f"**状态**\n{status}"}},
                    {"is_short": True, "text": {"tag": "lark_md", "content": f"**PR**\n[#{env('PR_NUMBER')}]({env('PR_URL')})"}},
                    {"is_short": True, "text": {"tag": "lark_md", "content": f"**作者**\n{env('PR_AUTHOR')}"}},
                    {"is_short": True, "text": {"tag": "lark_md", "content": f"**合并人**\n{env('MERGED_BY')}"}},
                    {"is_short": False, "text": {"tag": "lark_md", "content": f"**标题**\n{env('PR_TITLE')}"}},
                    {"is_short": False, "text": {"tag": "lark_md", "content": f"**Commit**\n`{commit_sha[:10]}`"}},
                ],
            },
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "查看部署日志"},
                        "url": env("RUN_URL"),
                        "type": "primary",
                    }
                ],
            },
        ],
    }

    send_resp = http_post(
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
        {"Authorization": f"Bearer {token}"},
        {
            "receive_id": chat_id,
            "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False),
        },
    )
    print("feishu response:", json.dumps(send_resp, ensure_ascii=False))
    if send_resp.get("code", 0) != 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
