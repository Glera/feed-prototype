"""Reset the stand DB to a deterministic Island Social Core browser-E2E baseline.

Idempotent. Clears append-only journals + derived counters for the test cohort,
then sets: B0 (foreign=2, pending=3), B1 (foreign=10 = MAX), a fixed friend code
for the inviter, and no friendships (browser flow forms a fresh one).
"""
from __future__ import annotations

from sqlalchemy import text

from app.db import SessionLocal

OWNER, GUEST, INVITER = 700000002, 700000003, 700000004
B0 = "b0000000-0000-4000-8000-000000000000"
B1 = "b1000000-0000-4000-8000-000000000001"
FIXED_CODE = "E2EFRIEND1"


def main() -> None:
    with SessionLocal() as db:
        ex = db.execute
        # Disposable-DB test reset only: the append-only journals are guarded by a
        # BEFORE trigger in production; replica role lets the harness rewind them.
        ex(text("SET session_replication_role = replica"))
        ex(text("DELETE FROM island_completion_outcomes"))
        ex(text("DELETE FROM island_completion_claims"))
        ex(text("DELETE FROM island_collect_claims"))
        ex(text("DELETE FROM island_visits"))
        ex(text("DELETE FROM puzzle_ledger WHERE idempotency_key LIKE 'island:%'"))
        ex(text("DELETE FROM island_friendships"))
        ex(text("DELETE FROM island_meta_events"))
        # deterministic friend code for the browser accept flow
        ex(text("DELETE FROM island_friend_codes WHERE code=:c OR user_id=:u"), {"c": FIXED_CODE, "u": INVITER})
        ex(text("INSERT INTO island_friend_codes (user_id, code, created_at) VALUES (:u,:c, now())"),
           {"u": INVITER, "c": FIXED_CODE})
        # social baselines
        ex(text("UPDATE island_building_social SET foreign_claims=2, pending_gifts=3, bot_claims=0, bot_likes=0, likes=0 WHERE building_id=:b"), {"b": B0})
        ex(text("UPDATE island_building_social SET foreign_claims=10, pending_gifts=0, bot_claims=0, bot_likes=0, likes=0 WHERE building_id=:b"), {"b": B1})
        db.commit()
    print(f"reset baseline: B0(foreign=2,pending=3) B1(foreign=10,MAX) code={FIXED_CODE}")


if __name__ == "__main__":
    main()
