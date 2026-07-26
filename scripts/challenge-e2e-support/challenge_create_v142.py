"""Server-side V1.4.2 challenge creation (offer-based): source-level offer →
run.start(challenge.v1 echoing the offered spec) → result → create. Used to
seed a spec-bound challenge for the recipient DOM case. Prints JSON.
"""
from __future__ import annotations

import json
import sys
import uuid

sys.path.insert(0, ".")
from app.api_challenges import ChallengeCreate, SourceLevelIn, create_challenge, create_source_level  # noqa: E402
from app.api_results import ResultIn, post_results  # noqa: E402
from app.api_runs import RunStartIn, start_run  # noqa: E402
import app.challenge_core as cc  # noqa: E402
from app.auth import TmaUser  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import ChallengeTicketBinding, Variant  # noqa: E402
from sqlalchemy.dialects.postgresql import insert as pg_insert  # noqa: E402
from app.models import User  # noqa: E402

CHALLENGER = int(sys.argv[1]) if len(sys.argv) > 1 else 700000301
RECIPIENT = int(sys.argv[2]) if len(sys.argv) > 2 else 700000302


def _tma(uid):
    return TmaUser(id=uid, first_name=f"U{uid}", username=None, language_code="en", is_premium=False)


def main():
    with SessionLocal() as db:
        db.execute(pg_insert(User).values(id=CHALLENGER, first_name=f"U{CHALLENGER}").on_conflict_do_nothing(index_elements=["id"]))
        db.execute(pg_insert(User).values(id=RECIPIENT, first_name=f"U{RECIPIENT}").on_conflict_do_nothing(index_elements=["id"]))
        vid = uuid.uuid4()
        db.add(Variant(id=vid, parent_mechanic="marble-sort-swipe", schema_version=1, params={"a": 1}, source="manual"))
        db.flush()
        rid = f"req-{uuid.uuid4().hex}"
        offer = create_source_level(body=SourceLevelIn(request_id=rid), caller=_tma(CHALLENGER), db=db, challenge_wire="1")
        spec = offer["challengeSpec"]
        ticket_id, run_id = uuid.uuid4(), f"chs-{uuid.uuid4().hex}"
        start_run(body=RunStartIn.model_validate({
            "schema": cc.CHALLENGE_SOURCE_SCHEMA, "purpose": "challenge_source",
            "ticket_id": str(ticket_id), "run_id": run_id, "mechanic_id": "marble-sort-swipe",
            "variant_id": str(vid), "kind": "single",
            # v1.4.2 R2 P1-1: address the exact committed offer this run replays.
            "sourceOfferRequestId": rid,
            "challengeSpec": {"playableId": spec["playableId"], "adapterVersion": spec["adapterVersion"],
                              "schemaVersion": spec["schemaVersion"], "params": spec["params"]},
        }), caller=_tma(CHALLENGER), db=db, challenge_wire="1")
        spec_digest = db.get(ChallengeTicketBinding, ticket_id).spec_digest
        post_results(body=ResultIn.model_validate({
            "mechanic_id": "marble-sort-swipe", "variant_id": str(vid), "run_id": run_id,
            "ticket_id": str(ticket_id), "metric_key": "time_ms", "metric_value": 5000,
            "applied_spec_digest": spec_digest,
        }), caller=_tma(CHALLENGER), db=db)
        created = create_challenge(body=ChallengeCreate.model_validate({
            "mechanic_id": "marble-sort-swipe", "variant_id": str(vid), "metric_key": "time_ms",
            "source_run_id": run_id, "request_id": f"crt-{uuid.uuid4().hex}",
        }), caller=_tma(CHALLENGER), db=db)
        db.commit()
    print(json.dumps({"challenge_id": created["challenge_id"], "spec_digest": spec_digest,
                      "deep_link": created.get("deep_link"), "challenger": CHALLENGER, "recipient": RECIPIENT,
                      "params": spec["params"]}, default=str))


if __name__ == "__main__":
    main()
