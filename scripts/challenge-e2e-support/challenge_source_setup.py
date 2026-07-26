"""Share/Challenge V1 — server-side SOURCE setup for the recipient E2E.

The source (challenger) client flow is not wired yet, so we build it with direct
endpoint calls (the exact V1-A path): seed an ACTIVE marble-sort-swipe fixture
release → source run.start(challenge.v1) → result → create_challenge. Prints JSON
{challenge_id, spec_digest, deep_link, challenger, recipient, playable_id}.

Uses the REAL default marble-sort-swipe adapter (registered in challenge_core),
so the running uvicorn's recipient endpoints accept the same challenge.
"""
from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert

import app.challenge_core as cc
from app.api_challenges import ChallengeCreate, create_challenge
from app.api_results import ResultIn, post_results
from app.api_runs import RunStartIn, start_run
from app.auth import TmaUser
from app.content_identity import jcs_sha256
from app.db import SessionLocal
from app.models import ChallengeTicketBinding, RuntimeRelease, User, Variant

sys.path.insert(0, ".")
from tests.runtime_release_test_support import (  # noqa: E402
    make_fixture_runtime_release_registration_payload,
    make_runtime_release_activation_payload,
)

PLAYABLE = "marble-sort-swipe"
MECHANIC = "marble-sort-swipe"
CHALLENGER = 700000101
RECIPIENT = 700000102

# valid sort.level-spec.v1 params (alias keys, ExactModel)
SORT_PARAMS = {
    "gridCols": 6,
    "gridRows": 5,
    "colorsUsed": 3,
    "cellColorMap": [i % 3 for i in range(30)],
    "targetStacks": [[0], [1], [2], [0]],
    "convSpeedMul": 1.0,
    "modifiers": [],
}


def _tma(uid):
    return TmaUser(id=uid, first_name=f"U{uid}", username=None, language_code="en", is_premium=False)


def _mk_user(db, uid):
    db.execute(pg_insert(User).values(id=uid, first_name=f"U{uid}").on_conflict_do_nothing(index_elements=["id"]))
    db.flush()


def _seed_active_release(owner_id=990101, contract="d" * 64):
    artifact_hex = f"{uuid.uuid4().hex}{uuid.uuid4().hex}"
    reg = make_fixture_runtime_release_registration_payload(
        playable_id=PLAYABLE, mechanic=MECHANIC, variant="base",
        runtime_contract_digest=contract, artifact_hex=artifact_hex,
    )
    d, delivery = reg["descriptor"], reg["delivery"]
    act = make_runtime_release_activation_payload(reg)
    ev = act["hostVerification"]
    with SessionLocal() as db:
        _mk_user(db, owner_id)
        db.add(RuntimeRelease(
            state="active",
            activation_id=uuid.UUID(act["activationId"]),
            activation_request_hash=act["requestHash"],
            host_evidence_digest=ev["evidenceDigest"], host_evidence=ev,
            host_origin=ev["origin"],
            host_verified_at=datetime.fromisoformat(ev["verifiedAt"].replace("Z", "+00:00")),
            activated_by=owner_id, activated_at=datetime.now(timezone.utc),
            release_id=uuid.UUID(reg["releaseId"]), schema="runtime-release.v1",
            mechanic=d["mechanic"], variant=d["variant"], playable_id=d["playableId"],
            runtime_contract_digest=d["runtimeContractDigest"], runtime_artifact_digest=d["runtimeArtifactDigest"],
            index_path=d["indexPath"], sidecar_path=d["sidecarPath"],
            index_locator=delivery["indexLocator"], sidecar_locator=delivery["sidecarLocator"],
            source_repository=d["sourceRepository"], source_commit=d["sourceCommit"],
            source_tree=d["sourceTree"], source_path=d["sourcePath"],
            qa_baseline_id=d["qaBaselineId"], qa_manifest_digest=d["qaManifestDigest"],
            capabilities=d["capabilities"], release_playable=True,
            descriptor=d, descriptor_hash=reg["descriptorHash"],
            registration_request_hash=reg["requestHash"], registered_by=owner_id,
        ))
        db.commit()
        row = db.get(RuntimeRelease, uuid.UUID(reg["releaseId"]))
        return {"release_id": str(row.release_id), "contract": row.runtime_contract_digest,
                "artifact": row.runtime_artifact_digest, "index_locator": row.index_locator}


def main():
    release = _seed_active_release()
    with SessionLocal() as db:
        _mk_user(db, CHALLENGER)
        _mk_user(db, RECIPIENT)
        variant_id = uuid.uuid4()
        db.add(Variant(id=variant_id, parent_mechanic=MECHANIC, schema_version=1, params={"a": 1}, source="manual"))
        db.flush()
        ticket_id, run_id = uuid.uuid4(), f"src-{uuid.uuid4().hex}"
        # source run.start (challenge.v1) — writes challenge_specs + ticket_binding
        start_run(body=RunStartIn.model_validate({
            "schema": cc.CHALLENGE_SOURCE_SCHEMA, "purpose": "challenge_source",
            "ticket_id": str(ticket_id), "run_id": run_id, "mechanic_id": MECHANIC,
            "variant_id": str(variant_id), "kind": "single",
            "challengeSpec": {"playableId": PLAYABLE, "adapterVersion": 1, "schemaVersion": 1, "params": SORT_PARAMS},
        }), caller=_tma(CHALLENGER), db=db, challenge_wire="1")
        spec_digest = db.get(ChallengeTicketBinding, ticket_id).spec_digest
        # source result (writes challenge_spec_bindings)
        post_results(body=ResultIn.model_validate({
            "mechanic_id": MECHANIC, "variant_id": str(variant_id), "run_id": run_id,
            "ticket_id": str(ticket_id), "metric_key": "time_ms", "metric_value": 5000,
            "applied_spec_digest": spec_digest,
        }), caller=_tma(CHALLENGER), db=db)
        # create challenge
        created = create_challenge(body=ChallengeCreate.model_validate({
            "mechanic_id": MECHANIC, "variant_id": str(variant_id), "metric_key": "time_ms",
            "source_run_id": run_id, "request_id": f"req-{uuid.uuid4().hex}",
        }), caller=_tma(CHALLENGER), db=db)
        db.commit()

    out = {"challenge_id": created["challenge_id"], "spec_digest": spec_digest,
           "deep_link": created.get("deep_link"), "share_url": created.get("share_url"),
           "challenger": CHALLENGER, "recipient": RECIPIENT, "playable_id": PLAYABLE,
           "variant_id": str(variant_id), "release": release}
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
