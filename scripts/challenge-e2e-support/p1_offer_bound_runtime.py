"""Codex R2 P1-1 DoD — offer-bound runtime.

An offer is issued while release A is active. Then A is RETIRED and a different
release B is ACTIVATED. Replaying the SAME committed offer (source run.start with
sourceOfferRequestId) must still deliver runtime **A** — the offer row is the
authority, `resolve_active_release` must not participate.

Evidence printed as JSON: the release A/B digests, the ticket-binding spec's
release, and the level-bundle runtime locator the client would put in the iframe
src (must be A's content hash, never B's).
"""
from __future__ import annotations

import json
import sys
import uuid

sys.path.insert(0, ".")
from sqlalchemy import text  # noqa: E402
from sqlalchemy.dialects.postgresql import insert as pg_insert  # noqa: E402

import app.challenge_core as cc  # noqa: E402
from app.api_challenges import SourceLevelIn, create_source_level, get_challenge_level_bundle  # noqa: E402
from app.api_runs import RunStartIn, start_run  # noqa: E402
from app.auth import TmaUser  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import ChallengeSpec, ChallengeTicketBinding, RuntimeRelease, User, Variant  # noqa: E402
from tests.test_challenge_source_level_postgres import (  # noqa: E402
    _seed_marble_sort_release, _seed_sort_level, _sort_params,
)

USER = int(sys.argv[1]) if len(sys.argv) > 1 else 700000501


def _tma(uid):
    return TmaUser(id=uid, first_name=f"U{uid}", username=None, language_code="en", is_premium=False)


def main() -> None:
    out = {}
    # ── release A active + published pool ──
    with SessionLocal() as db:
        if not db.execute(text("SELECT count(*) FROM catalog_entries WHERE mechanic='sort' AND state='published'")).scalar():
            for rot in range(6):
                _seed_sort_level(params=_sort_params(rot), state="published")
        db.execute(text("UPDATE runtime_releases SET state='retired', retired_by=activated_by, retired_at=now() "
                        "WHERE playable_id='marble-sort-swipe' AND state='active'"))
        db.commit()
    A = _seed_marble_sort_release(owner_id=880501)
    out["release_A"] = {"id": str(A["release_id"]), "artifact": A["artifact"]}

    # ── issue the offer while A is active, and bind a source ticket to it ──
    request_id = f"p11-{uuid.uuid4().hex}"
    with SessionLocal() as db:
        db.execute(pg_insert(User).values(id=USER, first_name=f"U{USER}").on_conflict_do_nothing(index_elements=["id"]))
        vid = uuid.uuid4()
        db.add(Variant(id=vid, parent_mechanic="marble-sort-swipe", schema_version=1, params={"a": 1}, source="manual"))
        db.flush()
        offer = create_source_level(body=SourceLevelIn(request_id=request_id), caller=_tma(USER), db=db, challenge_wire="1")
        db.commit()
    out["offer"] = {"request_id": request_id, "spec_digest": offer["spec_digest"]}

    # ── retire A, activate a DIFFERENT release B ──
    with SessionLocal() as db:
        db.execute(text("UPDATE runtime_releases SET state='retired', retired_by=activated_by, retired_at=now() "
                        "WHERE release_id=:r"), {"r": str(A["release_id"])})
        db.commit()
    B = _seed_marble_sort_release(owner_id=880502)
    out["release_B"] = {"id": str(B["release_id"]), "artifact": B["artifact"]}
    assert A["artifact"] != B["artifact"], "A and B must differ"
    with SessionLocal() as db:
        out["active_now"] = [
            [str(r[0]), r[1]] for r in db.execute(text(
                "SELECT runtime_artifact_digest, state FROM runtime_releases WHERE playable_id='marble-sort-swipe' ORDER BY state"))
        ]

    # ── replay the committed offer through source run.start (sourceOfferRequestId) ──
    ticket_id, run_id = uuid.uuid4(), f"p11-{uuid.uuid4().hex}"
    with SessionLocal() as db:
        spec = offer["challengeSpec"]
        payload = {
            "schema": cc.CHALLENGE_SOURCE_SCHEMA, "purpose": "challenge_source",
            "ticket_id": str(ticket_id), "run_id": run_id, "mechanic_id": "marble-sort-swipe",
            "variant_id": str(vid), "kind": "single",
            "sourceOfferRequestId": request_id,
            "challengeSpec": {"playableId": spec["playableId"], "adapterVersion": spec["adapterVersion"],
                              "schemaVersion": spec["schemaVersion"], "params": spec["params"]},
        }
        start_run(body=RunStartIn.model_validate(payload), caller=_tma(USER), db=db, challenge_wire="1")
        db.commit()
    with SessionLocal() as db:
        binding = db.get(ChallengeTicketBinding, ticket_id)
        cs = db.get(ChallengeSpec, binding.spec_digest)
        rel = db.get(RuntimeRelease, cs.runtime_release_id)
        out["run_resolved"] = {
            "spec_digest": binding.spec_digest,
            "release_id": str(rel.release_id),
            "artifact": rel.runtime_artifact_digest,
            "state_of_that_release": rel.state,
        }
        # the exact locator the client puts in the iframe src
        bundle = get_challenge_level_bundle(ticket_id=ticket_id, caller=_tma(USER), db=db, challenge_wire="1")
        out["bundle_index_locator"] = bundle["runtime"]["indexLocator"]
        out["bundle_artifact"] = bundle["runtime"]["runtimeArtifactDigest"]

    hexA = A["artifact"].split(":")[-1]
    hexB = B["artifact"].split(":")[-1]
    assert out["run_resolved"]["artifact"] == A["artifact"], f"offer must stay bound to A, got {out['run_resolved']['artifact']}"
    assert out["bundle_artifact"] == A["artifact"], "bundle runtime must be A"
    assert hexA in out["bundle_index_locator"] and hexB not in out["bundle_index_locator"], \
        f"iframe locator must carry A's hash: {out['bundle_index_locator']}"
    out["verdict"] = "PASS: committed offer delivered retired release A while B is active"
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
