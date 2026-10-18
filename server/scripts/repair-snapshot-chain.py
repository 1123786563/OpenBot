#!/usr/bin/env python3
"""
Rebuild the lying migration snapshots (0073..0138) so each one describes the
schema state its migration's SQL actually produces.

The 522eff8a merge ("delivery lineage wins enterprise stack") kept the delivery
lineage's SQL chain but took the losing lineage's snapshots, so snapshots
0073..0138 describe an enterprise-stack v2 world no database ever reached, and
tests/migration-journal.test.ts ("has a snapshot that describes what its
migration actually does") fails on 14 pairs.

Method (same spirit as 7378dbb1's 0139 rebuild, applied historically):
  - snapshots 0000..0072 are trusted (the journal test verifies every pair up
    through 0072 clean),
  - walk forward from 0072, applying each migration's DDL statements to the
    working state, and write the result as that migration's snapshot,
  - each snapshot's id/prevId and every non-tables key are preserved, so the
    journal chain drizzle-kit checks stays untouched,
  - SQL files are never modified.

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
    """Split a CREATE TABLE body on commas that are not nested in parens."""
    depth, cur, out = 0, "", []
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
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
            if key not in tables:
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
            tables[tkey(table)]["columns"][col] = column_entry(col, tail)
            continue

        m = re.search(
            r'CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?"([^"]+)" ON "([^"]+)"',
            s,
            re.I,
        )
        if m:
            unique, iname, table = m.group(1), m.group(2), m.group(3)
            tables[tkey(table)]["indexes"][iname] = {
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

        # ADD/DROP CONSTRAINT, triggers, comments, INSERTs: no snapshot effect.


def names_of(state):
    tables = {}
    for t in state["tables"].values():
        tables[t["name"]] = {
            "columns": {c["name"] for c in t.get("columns", {}).values()},
            "indexes": set(t.get("indexes", {}).keys()),
        }
    return tables


def main():
    journal = json.loads((ROOT / "meta" / "_journal.json").read_text())
    entries = {e["idx"]: e for e in journal["entries"]}

    state = json.loads((ROOT / "meta" / "0139_snapshot.json").read_text())
    for idx in range(FIRST, LAST + 1):
        entry = entries[idx]
        tag = entry["tag"]
        sql = (ROOT / f"{tag}.sql").read_text()
        # Each snapshot is the state AFTER its migration: apply, then write.
        apply_sql(state, sql)
        out = {
            "id": None,
            "prevId": None,
        }
        original = json.loads((ROOT / "meta" / f"{idx:04d}_snapshot.json").read_text())
        out = copy.deepcopy(original)  # preserves id/prevId/enums/... as they stand
        out["tables"] = copy.deepcopy(state["tables"])
        (ROOT / "meta" / f"{idx:04d}_snapshot.json").write_text(
            json.dumps(out, indent=2) + "\n"
        )
        print(f"rebuilt {idx:04d}_{tag}")

    # (junction check for the 0073-0138 window removed; this run covers 0140-0144)



if __name__ == "__main__":
    main()
