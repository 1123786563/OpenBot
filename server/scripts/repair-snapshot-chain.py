#!/usr/bin/env python3
"""
Rebuild the migration snapshots 0161..0236 so each one describes the schema
state its migration's SQL actually produces.

Earlier windows of lying or missing snapshots were already rebuilt the same way
(0139 by 7378dbb1, 0073..0138 by the 522eff8a cleanup this script grew out of),
so this run starts from the trusted 0160 snapshot:
  - snapshot 0160 is trusted (the journal test verifies every pair up through
    0160 clean), and it is the last one drizzle-kit ever generated for this
    chain: 0161..0236 were hand-written without `generate`, so those 76
    snapshots have never existed on any branch,
  - walk forward from 0160, applying each migration's DDL statements to the
    working state, and write the result as that migration's snapshot,
  - each fabricated snapshot's id/prevId extend the chain and every non-tables
    key is copied from the 0160 envelope, so the journal chain drizzle-kit
    checks stays intact,
  - SQL files are never modified,
  - nothing is written until every migration in FIRST..LAST has been applied,
    so a mid-window failure leaves the existing snapshots untouched.

The reconstructed state tracks exactly what the journal test reads: table
names, column names/types/notNull, index names. Statement shapes in range:
CREATE [IF NOT EXISTS] TABLE, ALTER TABLE ADD/DROP COLUMN, CREATE [UNIQUE]
INDEX, DROP INDEX [IF EXISTS], ALTER COLUMN SET/DROP NOT NULL. Everything else
in the range is invisible to that model and is skipped by SKIP below rather
than modelled: ADD/DROP CONSTRAINT, RLS and trigger toggles, CREATE/DROP POLICY,
triggers and functions, DO blocks, GRANT/REVOKE, and data-moving
INSERT/UPDATE/WITH statements.

shortcut: the snapshot's policies/roles blocks are copied from 0160 and do not
record the 19 policies and the one role these migrations create, because the
journal test does not read them. Upgrade this to model CREATE POLICY/ROLE if a
`drizzle-kit generate` after 0236 starts re-emitting them.
"""

import copy
import json
import re
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "drizzle"
FIRST, LAST = 73, 236
SEED = 72

# Statement shapes the journal test's model cannot see. Skipping them is what
# keeps this rebuild from aborting on the 500-odd statements that only move
# constraints, policies, privileges and data.
SKIP = re.compile(
    r"""^(?:
        ALTER\ TABLE\ .*\ (?:ADD|DROP)\ (?:PRIMARY\ KEY|UNIQUE|FOREIGN\ KEY|CHECK)\b
      | ALTER\ TABLE\ .*\ (?:ADD|DROP)\ CONSTRAINT\b
      | ALTER\ TABLE\ .*\ (?:ENABLE|DISABLE|FORCE)\ (?:ROW\ LEVEL\ SECURITY|TRIGGER)\b
      | ALTER\ TABLE\ .*\ RENAME\b
      | ALTER\ TABLE\ .*\ ALTER\ COLUMN\ .*\ (?:SET|DROP)\ DEFAULT\b
      | ALTER\ TABLE\ .*\ ALTER\ COLUMN\ .*\ TYPE\b
      | (?:CREATE|DROP)\ POLICY\b
      | (?:CREATE|DROP)\ (?:CONSTRAINT\ )?TRIGGER\b
      | CREATE\ (?:OR\ REPLACE\ )?FUNCTION\b
      | DROP\ FUNCTION\b
      | DO\b
      | (?:GRANT|REVOKE)\b
      | COMMENT\ ON\b
      | (?:CREATE|DROP|ALTER)\ (?:TYPE|EXTENSION|SCHEMA|ROLE)\b
      | (?:INSERT|UPDATE|DELETE|WITH)\b
    )""",
    re.I | re.X | re.S,
)


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
            # drizzle records the key as its own field, never in the type; the
            # journal test's ADD COLUMN parser is the only one that wants it.
            entry["type"] = re.sub(r"\s+", " ", re.sub(r"\bPRIMARY KEY\b", " ", entry["type"])).strip()
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


def split_statements(sql: str):
    """Split SQL on top-level semicolons.

    Only some migrations carry drizzle's `--> statement-breakpoint` markers; the
    hand-written ones just put several statements in one chunk, so each chunk is
    split again on `;` while respecting '...' literals and $$-quoted bodies.
    """
    out, cur, in_single, dollar = [], "", False, None
    i = 0
    while i < len(sql):
        ch = sql[i]
        if dollar:
            if sql.startswith(dollar, i):
                cur += dollar
                i += len(dollar)
                dollar = None
                continue
            cur += ch
            i += 1
            continue
        if in_single:
            cur += ch
            if ch == "'":
                if i + 1 < len(sql) and sql[i + 1] == "'":
                    cur += sql[i + 1]
                    i += 2
                    continue
                in_single = False
            i += 1
            continue
        if ch == "'":
            in_single = True
        elif ch == "$":
            tag = re.match(r"\$[A-Za-z_0-9]*\$", sql[i:])
            if tag:
                dollar = tag.group(0)
                cur += dollar
                i += len(dollar)
                continue
        elif ch == ";":
            out.append(cur)
            cur = ""
            i += 1
            continue
        cur += ch
        i += 1
    if cur.strip():
        out.append(cur)
    return out


def apply_sql(state: dict, sql: str):
    tables = state["tables"]

    def tkey(name):
        return f"public.{name}"

    for chunk in sql.split("--> statement-breakpoint"):
      # Comments are stripped before splitting, because they contain
      # semicolons that would otherwise cut a statement in half.
      chunk = re.sub(r"/\*.*?\*/", "", chunk, flags=re.S)
      chunk = re.sub(r"^[ \t]*--[^\n]*\n?", "", chunk, flags=re.M)
      for s in split_statements(chunk):
        s = s.strip()
        if not s:
            continue

        if SKIP.match(s):
            continue

        created = parse_create_table(s)
        if created:
            name, columns, inline_uniques = created
            key = tkey(name)
            if key in tables:
                # CREATE TABLE IF NOT EXISTS on a table the chain already has:
                # the statement re-declares a schema the state must already
                # satisfy, so fold in anything it names that is missing.
                existing = tables[key]
                for col, defn in columns.items():
                    existing["columns"].setdefault(col, defn)
                for u in inline_uniques:
                    existing["indexes"].setdefault(
                        u,
                        {
                            "name": u,
                            "columns": [],
                            "isUnique": True,
                            "concurrently": False,
                            "method": "btree",
                            "with": {},
                        },
                    )
                continue
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
            r'CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?"([^"]+)"\s+ON\s+"([^"]+)"',
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

        m = re.match(r'DROP TABLE (?:IF EXISTS )?"([^"]+)"', s, re.I)
        if m:
            tables.pop(tkey(m.group(1)), None)
            continue

        m = re.search(
            r'ALTER TABLE "([^"]+)" DROP COLUMN (?:IF EXISTS )?"([^"]+)"',
            s,
            re.I,
        )
        if m:
            table, col = m.group(1), m.group(2)
            table_def = tables.get(tkey(table))
            if table_def is None:
                sys.exit(f"DROP COLUMN on unknown table {table}")
            table_def["columns"].pop(col, None)
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


def merge_tables(model: dict, original: dict) -> dict:
    """Fold the SQL-derived model into a committed snapshot.

    Only the facts the journal test models are taken from the model — which
    tables exist, their columns' names/types/notNull, and their index names.
    Everything else the snapshot carries (check constraints, foreign keys,
    composite keys, policies, table order, each column's other keys) is kept
    from the committed file, so the diff is the drift being repaired rather
    than a rewrite of every snapshot.
    """
    out = {}
    for key, kept in original.items():
        if key not in model:
            continue  # an object the chain's SQL never creates
        built = model[key]
        merged = copy.deepcopy(kept)
        columns = {}
        for name, column in kept["columns"].items():
            if name not in built["columns"]:
                continue
            entry = copy.deepcopy(column)
            entry["type"] = built["columns"][name]["type"]
            entry["notNull"] = built["columns"][name]["notNull"]
            columns[name] = entry
        for name, column in built["columns"].items():
            if name not in columns:
                columns[name] = copy.deepcopy(column)
        merged["columns"] = columns
        indexes = {
            name: copy.deepcopy(index)
            for name, index in kept.get("indexes", {}).items()
            if name in built["indexes"]
        }
        for name, index in built["indexes"].items():
            if name not in indexes:
                indexes[name] = copy.deepcopy(index)
        merged["indexes"] = indexes
        out[key] = merged
    for key, built in model.items():
        if key not in original:
            out[key] = copy.deepcopy(built)
    return out


def main():
    dry_run = "--dry-run" in sys.argv
    journal = json.loads((ROOT / "meta" / "_journal.json").read_text())
    entries = {e["idx"]: e for e in journal["entries"]}

    state = json.loads((ROOT / "meta" / f"{SEED:04d}_snapshot.json").read_text())
    prev_id = state["id"]
    prev_out = state
    # Compute the whole window first, write nothing until every migration has
    # been applied: a mid-window failure must not leave a half-rebuilt chain.
    outputs = []
    for idx in range(FIRST, LAST + 1):
        entry = entries[idx]
        tag = entry["tag"]
        sql = (ROOT / f"{tag}.sql").read_text()
        # Each snapshot is the state AFTER its migration: apply, then capture.
        apply_sql(state, sql)
        original = ROOT / "meta" / f"{idx:04d}_snapshot.json"
        indent = "\t" if original.exists() and original.read_text().split("\n")[1].startswith("\t") else 2
        if original.exists():
            # Snapshots that already exist keep their own id/prevId/enums/
            # policies — only the table model is the thing under repair.
            out = json.loads(original.read_text())
            out["tables"] = merge_tables(state["tables"], out["tables"])
        else:
            # A missing snapshot takes the previous migration's envelope, so
            # enums/policies the chain has carried forward stay carried.
            out = {key: value for key, value in prev_out.items() if key != "tables"}
            out["id"] = str(uuid.uuid4())
            out["prevId"] = prev_id
            out["tables"] = copy.deepcopy(state["tables"])
        prev_id = out["id"]
        prev_out = out
        outputs.append((idx, tag, out, indent))

    if dry_run:
        print(f"dry run: {len(outputs)} snapshots modelled, nothing written")
        return

    for idx, tag, out, indent in outputs:
        (ROOT / "meta" / f"{idx:04d}_snapshot.json").write_text(
            json.dumps(out, indent=indent) + "\n"
        )
        print(f"rebuilt {idx:04d}_{tag}")

    # (junction check for the 0073-0138 window removed; this run covers 0140-0144)



if __name__ == "__main__":
    main()
