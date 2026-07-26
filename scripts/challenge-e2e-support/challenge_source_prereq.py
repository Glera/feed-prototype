"""Seed the V1-A.1 source-level prerequisites for the DOM E2E: an ACTIVE
marble-sort-swipe release (pinned to the REAL hosted content hex so the
content-addressed URL points at a real swipe-platform runtime-releases path) +
a pool of PUBLISHED sort catalog levels. The wired client drives POST
/challenges/source-level itself. Prints JSON.
"""
from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, ".")
from sqlalchemy import text  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import RuntimeRelease  # noqa: E402
from tests.runtime_release_test_support import (  # noqa: E402
    make_fixture_runtime_release_registration_payload,
    make_runtime_release_activation_payload,
)
from tests.test_challenge_source_level_postgres import (  # noqa: E402
    _seed_sort_level, _sort_params, _challenge_digest, _mk_user, SORT_CONTRACT, MARBLE,
)

# A REAL content hex that exists under swipe-platform/runtime-releases/marble-sort-swipe/.
REAL_HEX = "d66b4e440358533410dd505f25b7558187df46ca5d8eea562d8648c62f2f9293"


def _seed_release_real_hex(owner_id=880001):
    reg = make_fixture_runtime_release_registration_payload(
        playable_id=MARBLE, mechanic="sort", variant="base",
        runtime_contract_digest=SORT_CONTRACT, artifact_hex=REAL_HEX,
    )
    d, delivery = reg["descriptor"], reg["delivery"]
    act = make_runtime_release_activation_payload(reg)
    ev = act["hostVerification"]
    with SessionLocal() as db:
        _mk_user(db, owner_id)
        db.add(RuntimeRelease(
            release_id=uuid.UUID(reg["releaseId"]), schema="runtime-release.v1",
            mechanic=d["mechanic"], variant=d["variant"], playable_id=d["playableId"],
            runtime_contract_digest=d["runtimeContractDigest"], runtime_artifact_digest=d["runtimeArtifactDigest"],
            index_path=d["indexPath"], sidecar_path=d["sidecarPath"],
            index_locator=delivery["indexLocator"], sidecar_locator=delivery["sidecarLocator"],
            source_repository=d["sourceRepository"], source_commit=d["sourceCommit"],
            source_tree=d["sourceTree"], source_path=d["sourcePath"],
            qa_baseline_id=d["qaBaselineId"], qa_manifest_digest=d["qaManifestDigest"],
            capabilities=d["capabilities"], release_playable=True, descriptor=d,
            descriptor_hash=reg["descriptorHash"], registration_request_hash=reg["requestHash"],
            state="active", registered_by=owner_id,
            activation_id=uuid.UUID(act["activationId"]), activation_request_hash=act["requestHash"],
            host_evidence_digest=ev["evidenceDigest"], host_evidence=ev, host_origin=ev["origin"],
            host_verified_at=datetime.fromisoformat(ev["verifiedAt"].replace("Z", "+00:00")),
            activated_by=owner_id, activated_at=datetime.now(timezone.utc),
        ))
        db.commit()
        row = db.get(RuntimeRelease, uuid.UUID(reg["releaseId"]))
        return {"release_id": row.release_id, "contract": row.runtime_contract_digest,
                "artifact": row.runtime_artifact_digest, "index_locator": row.index_locator}


def main() -> None:
    release = _seed_release_real_hex()
    hashes = [_seed_sort_level(params=_sort_params(rot), state="published") for rot in range(6)]
    _seed_sort_level(params=_sort_params(20), state="candidate")  # excluded (proves published-only)
    print(json.dumps({
        "release_id": str(release["release_id"]), "contract": release["contract"],
        "artifact": release["artifact"], "index_locator": release["index_locator"],
        "pool_size": len(hashes), "sample_spec_digest_rot0": _challenge_digest(release, _sort_params(0)),
    }, indent=2, default=str))


if __name__ == "__main__":
    main()
