"""Codex R2 evidence — point 1 (fast-win 425 → Retry-After → exactly one claim)
and point 4c (/island/public returns the builtin binding). Drives the real
endpoints with signed initData; asserts DB facts. Prints JSON.
"""
from __future__ import annotations

import json
import os
import time
import uuid

import httpx
from sqlalchemy import text

from app.db import SessionLocal
from mkinit import build as build_init

BASE = os.environ.get("API_BASE", "http://127.0.0.1:5211")
BOT_TOKEN = os.environ["BOT_TOKEN"]
OWNER, GUEST = 700000002, 700000003
BOT_ID = 900000000000001
B0 = "b0000000-0000-4000-8000-000000000000"


def hdr(uid, name):
    return {"Authorization": "tma " + build_init(BOT_TOKEN, uid, name, name.lower(), None)}


def reset_guest():
    with SessionLocal() as db:
        db.execute(text("SET session_replication_role = replica"))
        db.execute(text("DELETE FROM island_completion_outcomes WHERE guest_id=:g"), {"g": GUEST})
        db.execute(text("DELETE FROM island_completion_claims WHERE guest_id=:g"), {"g": GUEST})
        db.execute(text("DELETE FROM island_visits WHERE guest_id=:g"), {"g": GUEST})
        db.execute(text("DELETE FROM puzzle_ledger WHERE idempotency_key LIKE 'island:gift:%'"))
        db.execute(text("UPDATE island_building_social SET foreign_claims=2, pending_gifts=3, bot_claims=0 WHERE building_id=:b"), {"b": B0})
        db.execute(text("SET session_replication_role = DEFAULT"))
        db.commit()


def main():
    out = {}
    reset_guest()
    c = httpx.Client(base_url=BASE, timeout=60.0)
    c.post("/api/session", headers=hdr(OWNER, "owner"))
    c.post("/api/session", headers=hdr(GUEST, "guest"))

    # pending before (for the "+1 exactly" check)
    with SessionLocal() as db:
        pending_before = db.execute(text("SELECT pending_gifts FROM island_building_social WHERE building_id=:b"), {"b": B0}).scalar()

    vid = str(uuid.uuid4())
    c.post("/api/island/visits/start", headers=hdr(GUEST, "guest"),
           json={"visit_id": vid, "owner_id": OWNER, "building_id": B0}).raise_for_status()

    # FAST win: post /result immediately (<< island_play_min_win_ms=8000) → 425
    r1 = c.post(f"/api/island/visits/{vid}/result", headers=hdr(GUEST, "guest"),
                json={"outcome": "completed", "duration_ms": 500})
    out["first_attempt_status"] = r1.status_code
    out["retry_after_header"] = r1.headers.get("Retry-After")
    assert r1.status_code == 425, f"expected 425, got {r1.status_code}: {r1.text}"

    # honour Retry-After (client bounded-retry semantics), then retry SAME visit_id
    retry_after = int(r1.headers.get("Retry-After", "8"))
    time.sleep(retry_after + 0.5)
    r2 = c.post(f"/api/island/visits/{vid}/result", headers=hdr(GUEST, "guest"),
                json={"outcome": "completed", "duration_ms": 500})
    r2.raise_for_status()
    out["retry_result"] = r2.json()

    # a THIRD post (idempotent replay) must not create anything new
    r3 = c.post(f"/api/island/visits/{vid}/result", headers=hdr(GUEST, "guest"),
                json={"outcome": "completed", "duration_ms": 500})
    out["replay_byte_identical"] = (r3.json() == r2.json())

    with SessionLocal() as db:
        q = lambda s: db.execute(text(s), {"g": GUEST, "v": vid, "b": B0})
        out["claims"] = q("SELECT count(*) FROM island_completion_claims WHERE id=:v").scalar()
        out["outcomes"] = q("SELECT count(*) FROM island_completion_outcomes WHERE claim_id=:v").scalar()
        out["outcome_disposition"] = q("SELECT disposition FROM island_completion_outcomes WHERE claim_id=:v").scalar()
        out["gift_ledger_rows"] = q("SELECT count(*) FROM puzzle_ledger WHERE idempotency_key='island:gift:'||:v").scalar()
        pending_after = q("SELECT pending_gifts FROM island_building_social WHERE building_id=:b").scalar()
        out["pending_delta"] = pending_after - pending_before

    assert out["claims"] == 1 and out["outcomes"] == 1 and out["gift_ledger_rows"] == 1, out
    assert out["outcome_disposition"] == "granted", out
    assert out["pending_delta"] == 1, out
    assert out["replay_byte_identical"], out

    # point 5 (F010, server side): after a granted claim the consumed gift is
    # NOT re-offered — gift_available_today flips to false for this guest/building.
    owner_pub = c.get(f"/api/island/public/{OWNER}", headers=hdr(GUEST, "guest")).json()
    b0v = next(x for x in owner_pub["buildings"] if x["buildingId"] == B0)
    out["gift_available_today_after_grant"] = b0v.get("gift_available_today")
    out["stage_after_grant"] = b0v.get("stage")
    assert out["gift_available_today_after_grant"] is False, "F010: consumed gift must not be re-offered"

    # point 4c: /island/public returns the builtin binding for a bot building
    pub = c.get(f"/api/island/public/{BOT_ID}", headers=hdr(GUEST, "guest")).json()
    b0 = pub["buildings"][0]
    out["public_builtin_present"] = bool(b0.get("builtin"))
    out["public_builtin_sample"] = b0.get("builtin")
    out["public_tpl"] = b0.get("tpl")
    assert out["public_builtin_present"], "GET /island/public must expose builtin binding (F002 dep)"

    print(json.dumps(out, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
