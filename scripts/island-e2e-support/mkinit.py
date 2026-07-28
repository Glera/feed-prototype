#!/usr/bin/env python3
"""Generate a signed Telegram initData string for local dev/E2E.

Usage: python mkinit.py <user_id> <first_name> [username] [start_param]
Signs with BOT_TOKEN env (must match the backend). Prints the raw initData.
"""
import hashlib
import hmac
import json
import os
import sys
import time
from urllib.parse import urlencode


def build(bot_token: str, user_id: int, first_name: str, username: str | None, start_param: str | None) -> str:
    user = {"id": user_id, "first_name": first_name}
    if username:
        user["username"] = username
    user["photo_url"] = f"https://t.me/i/userpic/320/{user_id}.jpg"
    fields = {
        "user": json.dumps(user, separators=(",", ":"), ensure_ascii=False),
        "auth_date": str(int(time.time())),
        "query_id": f"AAE{user_id}",
    }
    if start_param:
        fields["start_param"] = start_param
    dcs = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    h = hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest()
    fields["hash"] = h
    return urlencode(fields)


if __name__ == "__main__":
    bot_token = os.environ["BOT_TOKEN"]
    uid = int(sys.argv[1])
    fn = sys.argv[2]
    un = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    sp = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
    print(build(bot_token, uid, fn, un, sp))
