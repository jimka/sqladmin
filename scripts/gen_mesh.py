#!/usr/bin/env python3
"""
Generate db/init/04-mesh.sql: the `mesh` test schema.

`mesh` is `hub`'s controlled twin. Both carry the same 4 central tables, the
same 150 satellites under the same names, the same audit quartet, and the same
foreign keys into the hub hierarchy — so both give `users` an in-degree of 153,
`projects` 152, `workorders` 151 and `workorder_rows` 150, and both fold to
roughly 900 distinct foreign-key pairs.

The single difference is how satellites reference *each other*, and it is the
whole point of having two schemas:

  hub   every cross-satellite foreign key points the same direction through a
        fixed prefix order, so the graph is a total order and its longest
        foreign-key chain runs through all 150 satellites. A layered diagram
        puts a chain of N tables into N layers by definition, so `hub` renders
        as ~154 layers of one node each and is enormously wide. That is a
        genuine extreme worth keeping — but its width is set by chain depth,
        which drowns out everything else being measured on it.

  mesh  every satellite is assigned a level, and may only reference satellites
        at a strictly lower level. The result is dense (the same number of
        edges) but shallow (LEVELS deep), so a layered diagram is a handful of
        wide layers rather than one enormous line — the shape a real schema of
        this size has.

Compare a diagram change on both: `hub` for behaviour under pathological depth,
`mesh` for behaviour under realistic density with heavy fan-in.

Deterministic: no randomness beyond the fixed-seed LCG below, so regenerating
without changing the knobs reproduces the file byte for byte.

Usage:
    python3 scripts/gen_mesh.py > db/init/04-mesh.sql
"""

import sys

# --- Knobs -----------------------------------------------------------------

SCHEMA = "mesh"

# The 10 x 15 satellite naming grid, identical to hub's so the two schemas'
# tables correspond one-to-one and a diagram can be compared table by table.
PREFIXES = ["asset", "core", "crm", "doc", "fin", "ops", "plan", "proc", "qa", "sched"]
SUFFIXES = [
    "account", "address", "allocation", "approval", "attachment",
    "category", "comment", "contact", "cost_center", "document",
    "ledger_entry", "material", "resource", "status_history", "tag",
]

# How many levels the satellite DAG is allowed to be deep. Four keeps the
# longest cross-satellite chain at 3 hops, so a layered diagram lands at about
# LEVELS + 1 layers (the hubs are sinks and take the last one) instead of hub's
# 154. Raising this deepens the diagram roughly one layer per level.
LEVELS = 4

# Cross-satellite foreign keys per satellite, by level. Level-1 satellites have
# nothing below them to reference. The counts are what make the graph a *web*
# rather than a ladder: with 2-4 references each, drawn from every lower level
# rather than only the one immediately below, most pairs of levels are linked.
CROSS_FK_RANGE = (2, 4)

# Rows inserted per satellite, matching hub so row-count-sensitive UI behaves
# the same on both.
ROWS_PER_SATELLITE = 8

# Users / projects / workorders / workorder_rows row counts, matching hub.
USER_ROWS = 12
PROJECT_ROWS = 12
WORKORDER_ROWS = 20
WORKORDER_ROW_ROWS = 30

# Cross-satellite summary views, matching hub's count.
SUMMARY_VIEWS = 10


# --- Deterministic pseudo-randomness ---------------------------------------

class Lcg:
    """
    A fixed-seed linear congruential generator.

    Used instead of `random` so the output cannot change when Python's PRNG
    implementation does — this file is checked in and regenerated rarely, so a
    silent diff years later would be worse than the weak randomness matters.
    Constants are glibc's.
    """

    def __init__(self, seed: int) -> None:
        self.state = seed

    def next(self) -> int:
        self.state = (self.state * 1103515245 + 12345) % (2 ** 31)
        return self.state

    def below(self, n: int) -> int:
        """Return a value in [0, n)."""
        return self.next() % n

    def between(self, low: int, high: int) -> int:
        """Return a value in [low, high], inclusive."""
        return low + self.below(high - low + 1)


# --- Model -----------------------------------------------------------------

def satellite_names() -> list[str]:
    """Every satellite table name, in the grid's natural order."""
    return [f"{p}_{s}" for s in SUFFIXES for p in PREFIXES]


def assign_levels(names: list[str], rng: Lcg) -> dict[str, int]:
    """
    Give every satellite a level in [1, LEVELS].

    Assigned by the LCG rather than by position in the grid so that levels do
    not correlate with prefix or suffix: a level that tracked the name would put
    every `asset_*` table in one layer and make the diagram read as ten stripes
    rather than a web.

    Level 1 is deliberately the largest band — a real schema has more leaf
    tables than deeply-dependent ones — which also guarantees every higher level
    has plenty of targets to choose from.
    """
    weights = [40, 30, 20, 10][:LEVELS]  # level 1 .. LEVELS, as percentages
    total = sum(weights)
    levels: dict[str, int] = {}

    for name in names:
        roll = rng.below(total)
        running = 0

        for index, weight in enumerate(weights):
            running += weight

            if roll < running:
                levels[name] = index + 1
                break

    return levels


def assign_cross_refs(
    names: list[str],
    levels: dict[str, int],
    rng: Lcg,
) -> dict[str, list[str]]:
    """
    Choose each satellite's cross-satellite references: only tables at a
    strictly lower level, spread across *all* lower levels rather than just the
    one below, so the graph is a web instead of a layered ladder.

    Returns a name -> referenced-names mapping; level-1 satellites map to [].
    """
    by_level: dict[int, list[str]] = {level: [] for level in range(1, LEVELS + 1)}

    for name in names:
        by_level[levels[name]].append(name)

    refs: dict[str, list[str]] = {}

    for name in names:
        level = levels[name]

        if level == 1:
            refs[name] = []
            continue

        candidates = [n for lower in range(1, level) for n in by_level[lower]]
        wanted = rng.between(*CROSS_FK_RANGE)
        chosen: list[str] = []

        while len(chosen) < wanted and len(chosen) < len(candidates):
            pick = candidates[rng.below(len(candidates))]

            if pick not in chosen:
                chosen.append(pick)

        refs[name] = chosen

    return refs


# --- Emission --------------------------------------------------------------

def emit_header(out) -> None:
    print(f"""-- ---------------------------------------------------------------------------
-- {SCHEMA}: hub's controlled twin -- same size, same fan-in, shallow instead of
-- deep. The four central tables (users, projects, workorders, workorder_rows)
-- and the 150 satellites are named exactly as in hub, and every satellite
-- carries the same audit quartet and the same foreign keys into the
-- project/workorder/workorder_row hierarchy, so the central tables' fan-in is
-- identical: users 153, projects 152, workorders 151, workorder_rows 150.
--
-- What differs is the cross-satellite wiring. In hub those references all point
-- the same direction through a fixed prefix order, which makes the graph a
-- total order whose longest foreign-key chain runs through all 150 satellites;
-- a layered diagram therefore renders hub as ~154 layers of one node each. Here
-- each satellite has a level and may only reference strictly lower levels, so
-- the graph is just as dense but only {LEVELS} deep, and a layered diagram is a
-- handful of wide layers -- the shape a real schema of this size has.
--
-- Use hub to test behaviour under pathological depth, and {SCHEMA} to test it
-- under realistic density with heavy fan-in.
--
-- Generated by scripts/gen_mesh.py (deterministic). To rescale, edit the knobs
-- there and regenerate:  python3 scripts/gen_mesh.py > db/init/04-mesh.sql
-- ---------------------------------------------------------------------------

CREATE SCHEMA {SCHEMA};
""", file=out)


def emit_core_tables(out) -> None:
    """The four central tables, mirroring hub's definitions and row counts."""
    print(f"""-- users: the audit anchor. Every other table's created_by/changed_by lands
-- here, giving it by far the highest fan-in in the schema.
CREATE TABLE {SCHEMA}.users (
    id           serial       PRIMARY KEY,
    username     text         UNIQUE NOT NULL,
    full_name    text         NOT NULL,
    email        text         UNIQUE NOT NULL,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    created_by   integer      REFERENCES {SCHEMA}.users (id),
    changed_at   timestamptz  NOT NULL DEFAULT now(),
    changed_by   integer      REFERENCES {SCHEMA}.users (id)
);
""", file=out)

    rows = []

    for i in range(1, USER_ROWS + 1):
        parent = "NULL" if i == 1 else "1"
        rows.append(f"    ('user{i:02d}', 'User {i:02d}', 'user{i:02d}@example.com', {parent}, {parent})")

    print(f"INSERT INTO {SCHEMA}.users (username, full_name, email, created_by, changed_by) VALUES",
          file=out)
    print(",\n".join(rows) + ";\n", file=out)

    print(f"""-- projects / workorders / workorder_rows: the operational hierarchy almost
-- every satellite hangs off of.
CREATE TABLE {SCHEMA}.projects (
    id           serial       PRIMARY KEY,
    code         text         UNIQUE NOT NULL,
    name         text         NOT NULL,
    status       text         NOT NULL DEFAULT 'active',
    created_at   timestamptz  NOT NULL DEFAULT now(),
    created_by   integer      REFERENCES {SCHEMA}.users (id),
    changed_at   timestamptz  NOT NULL DEFAULT now(),
    changed_by   integer      REFERENCES {SCHEMA}.users (id)
);
""", file=out)

    statuses = ["active", "on_hold", "closed"]
    rows = []

    for i in range(1, PROJECT_ROWS + 1):
        user = (i % USER_ROWS) + 1
        rows.append(f"    ('PRJ-{i:03d}', 'Project {i:03d}', '{statuses[i % 3]}', {user}, {user})")

    print(f"INSERT INTO {SCHEMA}.projects (code, name, status, created_by, changed_by) VALUES",
          file=out)
    print(",\n".join(rows) + ";\n", file=out)

    print(f"""CREATE TABLE {SCHEMA}.workorders (
    id           serial       PRIMARY KEY,
    project_id   integer      NOT NULL REFERENCES {SCHEMA}.projects (id),
    number       text         UNIQUE NOT NULL,
    description  text,
    status       text         NOT NULL DEFAULT 'open',
    created_at   timestamptz  NOT NULL DEFAULT now(),
    created_by   integer      REFERENCES {SCHEMA}.users (id),
    changed_at   timestamptz  NOT NULL DEFAULT now(),
    changed_by   integer      REFERENCES {SCHEMA}.users (id)
);
""", file=out)

    rows = []

    for i in range(1, WORKORDER_ROWS + 1):
        project = (i % PROJECT_ROWS) + 1
        user = (i % USER_ROWS) + 1
        rows.append(f"    ({project}, 'WO-{i:04d}', 'Workorder {i:04d}', 'open', {user}, {user})")

    print(f"INSERT INTO {SCHEMA}.workorders (project_id, number, description, status, created_by, changed_by) VALUES",
          file=out)
    print(",\n".join(rows) + ";\n", file=out)

    print(f"""CREATE TABLE {SCHEMA}.workorder_rows (
    id            serial        PRIMARY KEY,
    workorder_id  integer       NOT NULL REFERENCES {SCHEMA}.workorders (id),
    project_id    integer       REFERENCES {SCHEMA}.projects (id),
    line_no       integer       NOT NULL,
    description   text,
    quantity      numeric(12, 2) NOT NULL DEFAULT 0,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    created_by    integer       REFERENCES {SCHEMA}.users (id),
    changed_at    timestamptz   NOT NULL DEFAULT now(),
    changed_by    integer       REFERENCES {SCHEMA}.users (id)
);
""", file=out)

    rows = []

    for i in range(1, WORKORDER_ROW_ROWS + 1):
        workorder = (i % WORKORDER_ROWS) + 1
        project = (i % PROJECT_ROWS) + 1
        user = (i % USER_ROWS) + 1
        rows.append(f"    ({workorder}, {project}, {i}, 'Row {i:03d}', {i * 3}.50, {user}, {user})")

    print(f"INSERT INTO {SCHEMA}.workorder_rows (workorder_id, project_id, line_no, description, quantity, created_by, changed_by) VALUES",
          file=out)
    print(",\n".join(rows) + ";\n", file=out)


def emit_satellite(out, name: str, level: int, refs: list[str]) -> None:
    """One satellite table plus its rows."""
    columns = [
        "    id                serial       PRIMARY KEY",
        "    code              varchar(24)",
        "    title             text",
        "    amount            numeric(14, 2)",
        "    quantity          integer",
        f"    project_id        integer      REFERENCES {SCHEMA}.projects (id)",
        f"    workorder_id      integer      REFERENCES {SCHEMA}.workorders (id)",
        f"    workorder_row_id  integer      REFERENCES {SCHEMA}.workorder_rows (id)",
    ]

    for ref in refs:
        columns.append(f"    {ref}_id{' ' * max(1, 17 - len(ref) - 3)}integer      REFERENCES {SCHEMA}.{ref} (id)")

    columns.append("    created_at        timestamptz  NOT NULL DEFAULT now()")
    columns.append(f"    created_by        integer      NOT NULL REFERENCES {SCHEMA}.users (id)")
    columns.append("    changed_at        timestamptz  NOT NULL DEFAULT now()")
    columns.append(f"    changed_by        integer      NOT NULL REFERENCES {SCHEMA}.users (id)")

    print(f"-- {name}: level {level}"
          + (f", references {', '.join(refs)}" if refs else ", a leaf (no cross-satellite keys)"),
          file=out)
    print(f"CREATE TABLE {SCHEMA}.{name} (", file=out)
    print(",\n".join(columns), file=out)
    print(");\n", file=out)

    insert_cols = ["code", "title", "amount", "quantity", "project_id", "workorder_id", "workorder_row_id"]
    insert_cols += [f"{ref}_id" for ref in refs]
    insert_cols += ["created_by", "changed_by"]

    rows = []

    for i in range(1, ROWS_PER_SATELLITE + 1):
        values = [
            f"'code-{i:02d}'",
            f"'title-{i:02d}'",
            f"{i * 7}.{(i * 3) % 100:02d}",
            str(i * 10 + 3),
            str((i % PROJECT_ROWS) + 1),
            str((i % WORKORDER_ROWS) + 1),
            str((i % WORKORDER_ROW_ROWS) + 1),
        ]

        # Every third row leaves one cross-satellite key NULL, so the fixture
        # exercises both the set and the unset case on an optional foreign key.
        for index, _ in enumerate(refs):
            blank = (i + index) % 3 == 0
            values.append("NULL" if blank else str(((i + index) % ROWS_PER_SATELLITE) + 1))

        values.append(str((i % USER_ROWS) + 1))
        values.append(str(((i + 1) % USER_ROWS) + 1))
        rows.append("    (" + ", ".join(values) + ")")

    print(f"INSERT INTO {SCHEMA}.{name} ({', '.join(insert_cols)}) VALUES", file=out)
    print(",\n".join(rows) + ";\n", file=out)


def emit_views(out, names: list[str]) -> None:
    """A view per satellite plus cross-satellite summaries, mirroring hub."""
    print("-- A view per satellite plus cross-satellite summaries, the way views", file=out)
    print("-- accrete in a long-lived database -- and enough of them to put the view", file=out)
    print("-- count on par with the table count.\n", file=out)

    for name in names:
        print(f"""CREATE VIEW {SCHEMA}.v_{name} AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM {SCHEMA}.{name} s
    LEFT JOIN {SCHEMA}.users cu      ON cu.id  = s.created_by
    LEFT JOIN {SCHEMA}.users chu     ON chu.id = s.changed_by
    LEFT JOIN {SCHEMA}.projects p    ON p.id   = s.project_id
    LEFT JOIN {SCHEMA}.workorders w  ON w.id   = s.workorder_id;
""", file=out)

    for i in range(SUMMARY_VIEWS):
        first = names[(i * 2) % len(names)]
        second = names[(i * 2 + 1) % len(names)]
        print(f"""CREATE VIEW {SCHEMA}.summary_{i:02d} AS
    SELECT p.code AS project_code,
           count(DISTINCT a.id) AS {first}_count,
           count(DISTINCT b.id) AS {second}_count
    FROM {SCHEMA}.projects p
    LEFT JOIN {SCHEMA}.{first} a ON a.project_id = p.id
    LEFT JOIN {SCHEMA}.{second} b ON b.project_id = p.id
    GROUP BY p.code;
""", file=out)


def main() -> None:
    out = sys.stdout
    rng = Lcg(20260727)

    names = satellite_names()
    levels = assign_levels(names, rng)
    refs = assign_cross_refs(names, levels, rng)

    emit_header(out)
    emit_core_tables(out)

    # Emit level by level so every referenced table already exists when a
    # satellite that points at it is created.
    for level in range(1, LEVELS + 1):
        for name in names:
            if levels[name] == level:
                emit_satellite(out, name, level, refs[name])

    emit_views(out, names)


if __name__ == "__main__":
    main()
