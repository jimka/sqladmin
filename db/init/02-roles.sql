-- SQLAdmin demo roles.
--
-- Runs after 01-seed.sql (filenames order Docker's initdb hook). Where the
-- first script builds the schema graph, this one populates pg_roles with a
-- deliberately varied cast so two surfaces have something real to show:
--   * the Roles view — every attribute column it renders (superuser, createdb,
--     createrole, login, connection limit, valid-until), plus role memberships
--     and per-role table grants;
--   * the login screen — each LOGIN role below is a working account. Its
--     PASSWORD equals its role name (demo only — never a real credential).
--
-- Sign in against database `sqladmin` as any of: dba, platform, analyst,
-- app_service, hr_manager, intern (password == username).
--
-- Re-seed with: docker compose down -v && docker compose up -d db

-- ---------------------------------------------------------------------------
-- Group roles (NOLOGIN) — reusable privilege bundles other roles inherit.
-- They appear in the Roles view as non-login roles and as membership targets.
-- ---------------------------------------------------------------------------

-- Read everything: USAGE on every schema + SELECT on every table/view. The
-- materialized view is granted explicitly — GRANT ... ON ALL TABLES covers
-- tables and views but not materialized views.
CREATE ROLE readonly NOLOGIN;
GRANT USAGE ON SCHEMA public, sales, inventory, hr, analytics TO readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public, sales, inventory, hr, analytics TO readonly;
GRANT SELECT ON analytics.customer_orders TO readonly;

-- Read/write on the operational schemas: inherits readonly's SELECT, adds the
-- write verbs and sequence usage on public + sales so inserts can allocate ids.
CREATE ROLE readwrite NOLOGIN;
GRANT readonly TO readwrite;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, sales TO readwrite;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public, sales TO readwrite;

-- ---------------------------------------------------------------------------
-- Login roles — the accounts the login screen can actually sign in as. Each
-- carries a distinct rights profile so switching accounts visibly changes what
-- the navigator can browse.
-- ---------------------------------------------------------------------------

-- A second superuser besides the bootstrap `sqladmin` — sees and does anything.
CREATE ROLE dba LOGIN SUPERUSER PASSWORD 'dba';

-- Platform operator: can create databases and roles, but is NOT a superuser —
-- shows the createdb/createrole attributes lit without superuser.
CREATE ROLE platform LOGIN CREATEDB CREATEROLE PASSWORD 'platform';

-- Read-only analyst: inherits the readonly bundle, so it can SELECT across
-- every schema but write nothing.
CREATE ROLE analyst LOGIN PASSWORD 'analyst' IN ROLE readonly;

-- Application service account: inherits readwrite (CRUD on public + sales,
-- read elsewhere) — the shape a backend app would connect as.
CREATE ROLE app_service LOGIN PASSWORD 'app_service' IN ROLE readwrite;

-- Departmental owner: full rights on the hr schema only; no access granted
-- elsewhere (it can still see role/catalog metadata, like any role).
CREATE ROLE hr_manager LOGIN PASSWORD 'hr_manager';
GRANT USAGE ON SCHEMA hr TO hr_manager;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hr TO hr_manager;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hr TO hr_manager;

-- Constrained account: read-only on public only, capped at 2 concurrent
-- connections and expiring at year-end — exercises the connection-limit and
-- valid-until columns in the Roles view.
CREATE ROLE intern LOGIN PASSWORD 'intern' CONNECTION LIMIT 2 VALID UNTIL '2026-12-31';
GRANT USAGE ON SCHEMA public TO intern;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO intern;
