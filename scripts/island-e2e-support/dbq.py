"""Run a single SQL query against the stand DB and print rows as JSON (list of lists)."""
import json
import sys

from sqlalchemy import text

from app.db import SessionLocal

sql = sys.argv[1]
with SessionLocal() as db:
    rows = [list(r) for r in db.execute(text(sql)).fetchall()]
print(json.dumps(rows, default=str))
