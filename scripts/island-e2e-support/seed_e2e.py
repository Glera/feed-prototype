"""Seed deterministic Island Social Core E2E fixtures into the stand DB.

Creates test users, an owner island document with:
  slot 0 -> UGC building B0 (collectible; pending_gifts arrive via real guest claim)
  slot 1 -> UGC building B1 (MAX; foreign_claims forced to 10 directly)
  slots 2,3 empty -> foundation CTAs
Idempotent: safe to re-run.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select

from app.db import SessionLocal
from app.models import IslandBuildingSocial, IslandStateRecord, User

OWNER = 700000002
GUEST = 700000003
INVITER = 700000004
ACCEPTER = 700000005

B0 = uuid.UUID("b0000000-0000-4000-8000-000000000000")  # collectible
B1 = uuid.UUID("b1000000-0000-4000-8000-000000000001")  # MAX

USERS = [
    (OWNER, "owner", "IslandOwner"),
    (GUEST, "guest", "IslandGuest"),
    (INVITER, "inviter", "IslandInviter"),
    (ACCEPTER, "accepter", "IslandAccepter"),
]

OWNER_STATE = {
    "tokens": 120,
    "buildings": [
        {
            "buildingId": str(B0),
            "slot": 0,
            "tpl": "sort",
            "pack": "base",
            "name": "Collectible",
            "rel": f"u/{OWNER}/collectible.html",
        },
        {
            "buildingId": str(B1),
            "slot": 1,
            "tpl": "sort",
            "pack": "base",
            "name": "Maxed",
            "rel": f"u/{OWNER}/maxed.html",
        },
    ],
}


def main() -> None:
    with SessionLocal() as db:
        for uid, un, fn in USERS:
            if db.get(User, uid) is None:
                db.add(User(id=uid, username=un, first_name=fn, ref_code=f"e2e{uid % 100000}"))
        db.flush()

        rec = db.get(IslandStateRecord, OWNER)
        if rec is None:
            db.add(IslandStateRecord(user_id=OWNER, schema_version=4, revision=1, data=OWNER_STATE))
        else:
            rec.data = OWNER_STATE
            rec.schema_version = 4
        db.flush()

        # Social rows: B0 starts empty (real guest claim fills pending_gifts);
        # B1 forced to stage 10 (MAX badge) per spec §7 direct-PG allowance.
        for bid, slot, foreign, pending in ((B0, 0, 0, 0), (B1, 1, 10, 0)):
            row = db.get(IslandBuildingSocial, bid)
            if row is None:
                db.add(
                    IslandBuildingSocial(
                        building_id=bid, owner_id=OWNER, slot=slot,
                        foreign_claims=foreign, pending_gifts=pending,
                    )
                )
            else:
                row.bot_claims = 0
                row.bot_likes = 0
                row.likes = 0
                row.foreign_claims = foreign
                row.pending_gifts = pending
        db.commit()

    print(f"seeded owner={OWNER} B0={B0} B1={B1} guest={GUEST} inviter={INVITER} accepter={ACCEPTER}")


if __name__ == "__main__":
    main()
