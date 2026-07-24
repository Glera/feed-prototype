"""Codex R2 evidence — point 4 setup. Mutates two seeded bots' island_states:
  bot A (900000000000002) slot0: tpl != builtin.mechanicId (tpl='merge',
    mechanicId='sort') → client must resolve the runtime from the binding.
  bot B (900000000000003) slot0: builtin.mechanicId='ghost-x-unknown' → client
    must fail closed (no visit).
Prints JSON with each bot's slot-0 buildingId + slot for the browser to target.
"""
from __future__ import annotations

import copy
import json

from sqlalchemy import text
from sqlalchemy.orm.attributes import flag_modified

from app.db import SessionLocal
from app.models import IslandStateRecord

BOT_A = 900000000000002  # tpl != mechanicId
BOT_B = 900000000000003  # unknown mechanicId


def _slot0(rec):
    b = min(rec.data["buildings"], key=lambda x: x["slot"])
    return b


def main() -> None:
    out = {}
    with SessionLocal() as db:
        # clear any prior visits/claims on these bots so "no visit" checks are clean
        db.execute(text("SET session_replication_role = replica"))
        for bot in (BOT_A, BOT_B):
            db.execute(text("DELETE FROM island_completion_claims WHERE owner_id=:b"), {"b": bot})
            db.execute(text("DELETE FROM island_completion_outcomes WHERE building_id IN (SELECT building_id FROM island_building_social WHERE owner_id=:b)"), {"b": bot})
            db.execute(text("DELETE FROM island_visits WHERE owner_id=:b"), {"b": bot})
        db.execute(text("SET session_replication_role = DEFAULT"))

        ra = db.get(IslandStateRecord, BOT_A)
        da = copy.deepcopy(ra.data)
        ba = min(da["buildings"], key=lambda x: x["slot"])
        ba["tpl"] = "merge" if ba.get("builtin", {}).get("mechanicId") == "sort" else "sort"
        ba["builtin"]["mechanicId"] = "sort"
        ra.data = da
        flag_modified(ra, "data")
        out["bot_a"] = {"bot": BOT_A, "buildingId": ba["buildingId"], "slot": ba["slot"],
                        "tpl": ba["tpl"], "mechanicId": ba["builtin"]["mechanicId"]}

        rb = db.get(IslandStateRecord, BOT_B)
        dbd = copy.deepcopy(rb.data)
        bb = min(dbd["buildings"], key=lambda x: x["slot"])
        bb["builtin"]["mechanicId"] = "ghost-x-unknown"
        rb.data = dbd
        flag_modified(rb, "data")
        out["bot_b"] = {"bot": BOT_B, "buildingId": bb["buildingId"], "slot": bb["slot"],
                        "mechanicId": bb["builtin"]["mechanicId"]}
        db.commit()
    print(json.dumps(out, default=str))


if __name__ == "__main__":
    main()
