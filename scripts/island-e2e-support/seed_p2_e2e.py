"""Seed one exact ticket-bound series chest for the Island P2 browser vertical."""
from __future__ import annotations

import uuid

from sqlalchemy import delete

from app.db import SessionLocal
from app.models import (
    IslandVisitAward,
    IslandBuildingSocial,
    RewardLedger,
    RunTicket,
    User,
    Variant,
    VerifiedRun,
)
from app.run_tickets import utc_now


PLAYER = 700000003
RUN_ID = "island-p2-browser-chest"
TICKET_ID = uuid.UUID("22000000-0000-4000-8000-000000000055")
VARIANT_ID = uuid.UUID("22000000-0000-4000-8000-000000000056")


def main() -> None:
    now = utc_now()
    with SessionLocal() as db:
        db.execute(delete(IslandVisitAward).where(IslandVisitAward.run_id == RUN_ID))
        if db.get(User, PLAYER) is None:
            db.add(User(id=PLAYER, first_name="P2Guest", ref_code="p2guest"))
        if db.get(Variant, VARIANT_ID) is None:
            db.add(
                Variant(
                    id=VARIANT_ID,
                    parent_mechanic="sort",
                    schema_version=1,
                    params={},
                    source="manual",
                )
            )
        for social in db.query(IslandBuildingSocial).filter(
            IslandBuildingSocial.owner_id == 700000002
        ):
            social.pending_gifts = 0
        db.flush()
        # Verified runs are append-only in production. Re-running this disposable
        # fixture reuses the same exact chest identity and only clears the P2
        # award derived from it.
        if db.get(VerifiedRun, RUN_ID) is None:
            db.add(
                RunTicket(
                    id=TICKET_ID,
                    user_id=PLAYER,
                    root_run_id=RUN_ID,
                    kind="series",
                    mechanic_id="marble-sort-swipe",
                    variant_id=VARIANT_ID,
                    expected_levels=2,
                    completed_levels=2,
                    consumed_at=now,
                    expires_at=now,
                )
            )
            db.add(
                VerifiedRun(
                    run_id=RUN_ID,
                    ticket_id=TICKET_ID,
                    user_id=PLAYER,
                    mechanic_id="marble-sort-swipe",
                    variant_id=VARIANT_ID,
                    metric_key="series",
                    metric_value=2,
                )
            )
            db.add(
                RewardLedger(
                    user_id=PLAYER,
                    reason="series_complete",
                    stars=3,
                    idempotency_key=f"lw:{RUN_ID}",
                    meta={
                        "metric_key": "series",
                        "ticket_id": str(TICKET_ID),
                        "variant_id": str(VARIANT_ID),
                    },
                )
            )
        db.commit()
    print(RUN_ID)


if __name__ == "__main__":
    main()
