"""Dogfood setup (§7): fresh user -> island -> auto-friend bot -> bot tick grows
the user's house. Prints JSON {user, bot_id, building, bot_building, grown}.

Uses the real app functions (maybe_seed_bot_friend, run_tick). Idempotent-ish:
re-running rewinds the fresh user's journals via replica role.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import text

from app.db import SessionLocal
from app.island_bots import maybe_seed_bot_friend, run_tick
from app.config import get_settings
from app.models import IslandBuildingSocial, IslandStateRecord, User

U = 700000020
D0 = uuid.UUID("d0000000-0000-4000-8000-000000000020")

STATE = {
    "tokens": 120,
    "buildings": [{
        "buildingId": str(D0), "slot": 0, "tpl": "sort", "pack": "base",
        "name": "Dogfood", "rel": f"u/{U}/dogfood.html",
    }],
}


def main() -> None:
    settings = get_settings()
    with SessionLocal() as db:
        # clean rewind for a repeatable dogfood
        db.execute(text("SET session_replication_role = replica"))
        db.execute(text("DELETE FROM island_completion_claims WHERE owner_id=:u OR guest_id=:u"), {"u": U})
        db.execute(text("DELETE FROM island_completion_outcomes WHERE guest_id=:u"), {"u": U})
        db.execute(text("DELETE FROM island_collect_claims WHERE owner_id=:u"), {"u": U})
        db.execute(text("DELETE FROM island_meta_events WHERE user_id=:u"), {"u": U})
        db.execute(text("DELETE FROM island_friendships WHERE user_lo=:u OR user_hi=:u"), {"u": U})
        db.execute(text("DELETE FROM island_bot_daily_plans"), )
        db.execute(text("DELETE FROM puzzle_ledger WHERE user_id=:u"), {"u": U})
        db.execute(text("SET session_replication_role = DEFAULT"))
        if db.get(User, U) is None:
            db.add(User(id=U, username="dogfooder", first_name="Dogfooder", ref_code="dogf20"))
        db.flush()
        rec = db.get(IslandStateRecord, U)
        if rec is None:
            db.add(IslandStateRecord(user_id=U, schema_version=4, revision=1, data=STATE))
        else:
            rec.data = STATE
        row = db.get(IslandBuildingSocial, D0)
        if row is None:
            db.add(IslandBuildingSocial(building_id=D0, owner_id=U, slot=0, foreign_claims=0, pending_gifts=0))
        else:
            row.bot_claims = 0
            row.bot_likes = 0
            row.likes = 0
            row.foreign_claims = 0
            row.pending_gifts = 0
        db.commit()

        # first island creation -> auto-friend bot (the exact endpoint hook)
        maybe_seed_bot_friend(db, U, settings)
        db.commit()
        fr = db.execute(text(
            "SELECT user_lo, user_hi FROM island_friendships WHERE (user_lo=:u OR user_hi=:u) AND source='bot_seed'"
        ), {"u": U}).fetchone()
        assert fr is not None, "auto-friend bot not created"
        bot_id = fr[0] if fr[1] == U else fr[1]

        # a builtin building on the friend bot's island, for the user to visit
        bot_rec = db.get(IslandStateRecord, bot_id)
        bot_building = None
        for b in (bot_rec.data.get("buildings") if bot_rec else []) or []:
            if b.get("builtin"):
                bot_building = b["buildingId"]
                break

    # bot tick near end of UTC day so the full day's plan is due -> grows the house
    late = datetime.now(timezone.utc).replace(hour=23, minute=59, second=0, microsecond=0)
    tick = run_tick(now=late)

    with SessionLocal() as db:
        s = db.get(IslandBuildingSocial, D0)
        grown = {"foreign_claims": int(s.foreign_claims), "bot_claims": int(s.bot_claims),
                 "pending_gifts": int(s.pending_gifts)}
    print(json.dumps({"user": U, "bot_id": bot_id, "building": str(D0),
                      "bot_building": bot_building, "tick": tick, "grown": grown}, default=str))


if __name__ == "__main__":
    main()
