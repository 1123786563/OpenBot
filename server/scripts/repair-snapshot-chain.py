#!/usr/bin/env python3
"""
Rebuild the migration snapshots 0140..0144 so each one describes the schema
state its migration's SQL actually produces.

Earlier windows of lying snapshots were already rebuilt the same way (0139 by
7378dbb1, 0073..0138 by the 522eff8a cleanup this script grew out of), so this
run starts from the trusted 0139 snapshot:
  - snapshot 0139 is trusted (the journal test verifies every pair up through
    0139 clean),
  - walk forward from 0139, applying each migration's DDL statements to the
    working state, and write the result as that migration's snapshot,
  - each snapshot's id/prevId and every non-tables key are preserved, so the
    journal chain drizzle-kit checks stays untouched,
  - SQL files are never modified,
  - nothing is written until every migration in FIRST..LAST has been applied,
    so a mid-window failure leaves the existing snapshots untouched.

The reconstructed state tracks exactly what the journal test reads: table
names, column names/types/notNull, index names. Statement shapes in range:
CREATE [IF NOT EXISTS] TABLE, ALTER TABLE ADD COLUMN, CREATE [UNIQUE] INDEX,
DROP INDEX [IF EXISTS], ALTER COLUMN SET/DROP NOT NULL. ADD/DROP CONSTRAINT
and triggers are invisible to the engine and to drizzle's table diff, and
there are no DROP TABLE / DROP COLUMN / renames in the range.
"""

import copy
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "drizzle"
FIRST, LAST = 140, 144


def declared(tail: str):
    """The journal test's own tail parser (tests/migration-journal.test.ts)."""
    t = re.sub(r"\bNOT NULL\b", " ", tail, flags=re.I)
    t = re.sub(
        r"\bDEFAULT\s+(?:'(?:[^']|'')*'(?:\s*::\s*[\w.]+(?:\[\])?)*|[^\s;]+)",
        " ",
        t,
        flags=re.I,
    )
    return {
        "type": re.sub(r"\s+", " ", t).strip(),
        "notNull": bool(re.search(r"\bNOT NULL\b", tail, re.I)),
    }


def column_entry(name: str, tail: str) -> dict:
    d = declared(tail)
    entry = {
        "name": name,
        "type": d["type"],
        "primaryKey": False,
        "notNull": d["notNull"],
    }
    return entry


def parse_create_table(stmt: str):
    """(table_name, columns) from a CREATE TABLE statement body."""
    m = re.match(
        r'CREATE TABLE (?:IF NOT EXISTS )?"([^"]+)"\s*\((.*)\)\s*;?\s*$',
        stmt,
        re.S,
    )
    if not m:
        return None
    name, body = m.group(1), m.group(2)
    columns = {}
    inline_uniques = []
    for line in split_top_level(body):
        line = line.strip().rstrip(",")
        if not line:
            continue
        um = re.match(r'CONSTRAINT "([^"]+)" UNIQUE\s*\(', line, re.I)
        if um:
            # PostgreSQL stores a UNIQUE constraint as a unique index of the
            # same name; the declared schema models it as a uniqueIndex.
            inline_uniques.append(um.group(1))
            continue
        if re.match(r"CONSTRAINT\b", line, re.I):
            continue
        cm = re.match(r'"([^"]+)"\s+(.*)$', line, re.S)
        if not cm:
            continue
        col, tail = cm.group(1), cm.group(2)
        entry = column_entry(col, tail)
        if re.search(r"\bPRIMARY KEY\b", tail, re.I):
            entry["primaryKey"] = True
            entry["notNull"] = True
        columns[col] = entry
    return name, columns, inline_uniques


def split_top_level(body: str):
    """Split a CREATE TABLE body on commas that are not nested in parens or
    inside a quoted literal (a DEFAULT 'a,b' must stay one column)."""
    depth, cur, out = 0, "", []
    in_quote = False
    i = 0
    while i < len(body):
        ch = body[i]
        if in_quote:
            cur += ch
            if ch == "'":
                if i + 1 < len(body) and body[i + 1] == "'":
                    cur += body[i + 1]  # escaped '' stays inside the literal
                    i += 2
                    continue
                in_quote = False
        elif ch == "'":
            in_quote = True
            cur += ch
        elif ch == "(":
            depth += 1
            cur += ch
        elif ch == ")":
            depth -= 1
            cur += ch
        elif ch == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
        i += 1
    if cur.strip():
        out.append(cur)
    return out


def apply_sql(state: dict, sql: str):
    tables = state["tables"]

    def tkey(name):
        return f"public.{name}"

    for stmt in sql.split("--> statement-breakpoint"):
        # A chunk may open with the statement's own comment block.
        s = re.sub(r"^[ \t]*--[^\n]*\n?", "", stmt, flags=re.M)
        s = s.strip()
        if not s:
            continue

        created = parse_create_table(s)
        if created:
            name, columns, inline_uniques = created
            key = tkey(name)
            if key in tables:
                # The window rebuilds each table exactly once from the trusted
                # baseline; "IF NOT EXISTS" on an already-present table would
                # silently drop this statement's columns/indexes from the
                # rebuilt snapshot.
                sys.exit(
                    f"CREATE TABLE on already-present table {key}; "
                    "snapshot rebuild would silently drop its DDL"
                )
            tables[key] = {
                    "name": name,
                    "schema": "",
                    "columns": columns,
                    "indexes": {
                        u: {
                            "name": u,
                            "columns": [],
                            "isUnique": True,
                            "concurrently": False,
                            "method": "btree",
                            "with": {},
                        }
                        for u in inline_uniques
                    },
                    "foreignKeys": {},
                    "compositePrimaryKeys": {},
                    "uniqueConstraints": {},
                    "policies": {},
                    "checkConstraints": {},
                }
            continue

        m = re.search(
            r'ALTER TABLE "([^"]+)" ADD COLUMN (?:IF NOT EXISTS )?"([^"]+)"([^;]*)',
            s,
            re.I,
        )
        if m:
            table, col, tail = m.group(1), m.group(2), m.group(3)
            table_def = tables.get(tkey(table))
            if table_def is None:
                sys.exit(f"ADD COLUMN on unknown table {table}")
            table_def["columns"][col] = column_entry(col, tail)
            continue

        m = re.search(
            r'CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?"([^"]+)" ON "([^"]+)"',
            s,
            re.I,
        )
        if m:
            unique, iname, table = m.group(1), m.group(2), m.group(3)
            table_def = tables.get(tkey(table))
            if table_def is None:
                sys.exit(f"CREATE INDEX on unknown table {table}")
            table_def["indexes"][iname] = {
                "name": iname,
                "columns": [],
                "isUnique": bool(unique),
                "concurrently": False,
                "method": "btree",
                "with": {},
            }
            continue

        m = re.search(r'DROP INDEX (?:IF EXISTS )?"([^"]+)"', s, re.I)
        if m:
            iname = m.group(1)
            for t in tables.values():
                t.get("indexes", {}).pop(iname, None)
            continue

        m = re.search(
            r'ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" (SET NOT NULL|DROP NOT NULL)',
            s,
            re.I,
        )
        if m:
            table, col, action = m.group(1), m.group(2), m.group(3)
            coldef = tables[tkey(table)]["columns"].get(col)
            if coldef is None:
                sys.exit(f"ALTER COLUMN on unknown column {table}.{col}")
            coldef["notNull"] = action.upper() == "SET NOT NULL"
            continue

        sys.exit(f"unhandled SQL statement in migration; aborting snapshot rebuild: {s[:200]}")


def main():
    journal = json.loads((ROOT / "meta" / "_journal.json").read_text())
    entries = {e["idx"]: e for e in journal["entries"]}

    state = json.loads((ROOT / "meta" / "0139_snapshot.json").read_text())
    # Compute the whole window first, write nothing until every migration has
    # been applied: a mid-window failure must not leave a half-rebuilt chain.
    outputs = []
    for idx in range(FIRST, LAST + 1):
        entry = entries[idx]
        tag = entry["tag"]
        sql = (ROOT / f"{tag}.sql").read_text()
        # Each snapshot is the state AFTER its migration: apply, then capture.
        apply_sql(state, sql)
        original = json.loads((ROOT / "meta" / f"{idx:04d}_snapshot.json").read_text())
        out = copy.deepcopy(original)  # preserves id/prevId/enums/... as they stand
        out["tables"] = copy.deepcopy(state["tables"])
        outputs.append((idx, tag, out))

    for idx, tag, out in outputs:
        (ROOT / "meta" / f"{idx:04d}_snapshot.json").write_text(
            json.dumps(out, indent=2) + "\n"
        )
        print(f"rebuilt {idx:04d}_{tag}")

    # (junction check for the 0073-0138 window removed; this run covers 0140-0144)



if __name__ == "__main__":
    main()
