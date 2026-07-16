-- SQLAdmin demo seed.
--
-- Runs once, when the Postgres data volume is first created (Docker's
-- /docker-entrypoint-initdb.d hook). Gives Phase 0 a real schema to
-- introspect and render — public.customers is the table Phase 0 targets.
-- Re-seed with: docker compose down -v && docker compose up -d db
--
-- Beyond Phase 0's public.customers/orders, the seed defines four more
-- schemas (sales, inventory, hr, analytics) with tables, views, and a
-- materialized view, wired together with intra- and cross-schema foreign
-- keys. That richer graph is what exercises the schema/database diagrams:
-- the schema-overview edges (cross-schema FK counts), the per-schema
-- container boxes, self-referencing edges (hr.employees.manager_id), and
-- view/materialized-view object kinds. Every base table is seeded with a
-- handful of rows; views/materialized views derive their rows from those.
--
-- The seed also covers every column-to-sequence relationship the Structure
-- tab's Sequence link and the sequence tab's "Owned by column" row can
-- encounter — serial, identity, a shared sequence reached through a DEFAULT,
-- a generated column with no sequence at all, a column matching both
-- dependency arms, and a standalone sequence (public.audit_event_seq). See
-- the sales.invoices/credit_notes block for the full case list.

CREATE TABLE public.customers (
    id          serial         PRIMARY KEY,
    name        text           NOT NULL,
    email       text           UNIQUE NOT NULL,
    balance     numeric(12, 2) NOT NULL DEFAULT 0,
    active      boolean        NOT NULL DEFAULT true,
    created_at  timestamptz    NOT NULL DEFAULT now(),
    notes       text
);

INSERT INTO public.customers (name, email, balance, active, notes) VALUES
    ('Ada Lovelace',    'ada@example.com',    1240.50, true,  'First customer'),
    ('Alan Turing',     'alan@example.com',    980.00, true,  NULL),
    ('Grace Hopper',    'grace@example.com',     0.00, false, 'Inactive'),
    ('Edsger Dijkstra', 'edsger@example.com',   77.25, true,  'VIP');

-- A second table (with a foreign key) so the navigator has more than one
-- object to browse in later phases, and so the type mapping is exercised
-- across serial / text / numeric / boolean / timestamptz columns.
CREATE TABLE public.orders (
    id           serial         PRIMARY KEY,
    customer_id  integer        NOT NULL REFERENCES public.customers (id),
    total        numeric(12, 2) NOT NULL,
    placed_at    timestamptz    NOT NULL DEFAULT now(),
    status       text           NOT NULL DEFAULT 'pending'
);

INSERT INTO public.orders (customer_id, total, status) VALUES
    (1, 120.00, 'shipped'),
    (1,  35.50, 'pending'),
    (2, 500.00, 'delivered'),
    (4,  77.25, 'pending');

-- An application-managed counter: drawn with nextval() from application code,
-- so no column defaults from it and no column owns it. It is the navigator's
-- standalone-sequence case — its info tab must report no owning column.
CREATE SEQUENCE public.audit_event_seq;

-- A view over public, so the navigator (and diagrams) show a view object kind
-- alongside base tables in the schema everyone starts in.
CREATE VIEW public.active_customers AS
    SELECT id, name, email, balance
    FROM public.customers
    WHERE active;

-- ---------------------------------------------------------------------------
-- sales: product catalogue + order line items. order_items reaches back into
-- public.orders (a cross-schema FK: sales -> public) and sideways to
-- sales.products (intra-schema).
-- ---------------------------------------------------------------------------
CREATE SCHEMA sales;

CREATE TABLE sales.products (
    id          serial         PRIMARY KEY,
    sku         text           UNIQUE NOT NULL,
    name        text           NOT NULL,
    price       numeric(12, 2) NOT NULL,
    category    text           NOT NULL,
    created_at  timestamptz    NOT NULL DEFAULT now()
);

INSERT INTO sales.products (sku, name, price, category) VALUES
    ('SKU-001', 'Widget',      9.99,   'Hardware'),
    ('SKU-002', 'Gadget',      19.99,  'Hardware'),
    ('SKU-003', 'Gizmo',       4.50,   'Accessories'),
    ('SKU-004', 'Doohickey',   12.00,  'Accessories'),
    ('SKU-005', 'Contraption', 99.00,  'Machines'),
    ('SKU-006', 'Apparatus',   149.00, 'Machines');

CREATE TABLE sales.order_items (
    id          serial         PRIMARY KEY,
    order_id    integer        NOT NULL REFERENCES public.orders (id),
    product_id  integer        NOT NULL REFERENCES sales.products (id),
    quantity    integer        NOT NULL DEFAULT 1,
    unit_price  numeric(12, 2) NOT NULL
);

INSERT INTO sales.order_items (order_id, product_id, quantity, unit_price) VALUES
    (1, 1, 2, 9.99),
    (1, 3, 1, 4.50),
    (2, 2, 1, 19.99),
    (3, 5, 5, 99.00),
    (3, 6, 1, 149.00),
    (4, 4, 3, 12.00);

CREATE VIEW sales.order_summary AS
    SELECT o.id                         AS order_id,
           c.name                       AS customer,
           p.name                       AS product,
           oi.quantity,
           oi.unit_price,
           oi.quantity * oi.unit_price  AS line_total
    FROM public.orders o
    JOIN public.customers c   ON c.id = o.customer_id
    JOIN sales.order_items oi ON oi.order_id = o.id
    JOIN sales.products p     ON p.id = oi.product_id;

-- ---------------------------------------------------------------------------
-- Billing (sales.invoices / sales.credit_notes) exists to make every way a
-- column can — or cannot — be tied to a sequence reachable from the UI, since
-- the backend's pg_depend introspection has no automated coverage (the tests
-- are pure-logic and never touch a database). Each column below is a case the
-- Structure tab's Sequence link and the sequence tab's "Owned by column" row
-- must get right:
--
--   invoices.id           identity  -> OWNED BY only (no DEFAULT to read)
--   invoices.document_no  DEFAULT   -> document_number_seq, which it does NOT own
--   invoices.total        generated -> NO sequence, despite being generated
--   credit_notes.id       both      -> DEFAULT (document_number_seq) must win
--   products.id (above)   serial    -> both arms agree on products_id_seq
--
-- A shared document number across invoices and credit notes: one counter, so
-- the two document kinds never collide. Deliberately owned by NO column —
-- ownership would tie its lifetime to whichever table declared it.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE sales.document_number_seq;

CREATE TABLE sales.invoices (
    -- Identity, not serial: an identity column has no column default, so the
    -- sequence is reachable only through its OWNED BY dependency.
    id           integer        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Defaults from the shared sequence without owning it.
    document_no  integer        NOT NULL DEFAULT nextval('sales.document_number_seq'),
    order_id     integer        NOT NULL REFERENCES public.orders (id),
    net          numeric(12, 2) NOT NULL,
    vat          numeric(12, 2) NOT NULL DEFAULT 0,
    -- Generated but sequence-free: the Structure tab must show Generated = true
    -- with an EMPTY Sequence cell.
    total        numeric(12, 2) GENERATED ALWAYS AS (net + vat) STORED
);

INSERT INTO sales.invoices (order_id, net, vat) VALUES
    (1, 120.00, 30.00),
    (2,  35.50,  8.88),
    (3, 500.00, 125.00);

-- credit_notes.id was originally a serial and was later repointed at the shared
-- document sequence. The ALTER only replaces the DEFAULT: the original
-- credit_notes_id_seq stays OWNED BY the column, so this one column matches
-- both dependency arms with two DIFFERENT sequences. The DEFAULT is what
-- actually supplies the value, so document_number_seq is the truthful answer.
CREATE TABLE sales.credit_notes (
    id          serial         PRIMARY KEY,
    invoice_id  integer        NOT NULL REFERENCES sales.invoices (id),
    amount      numeric(12, 2) NOT NULL,
    reason      text
);

ALTER TABLE sales.credit_notes
    ALTER COLUMN id SET DEFAULT nextval('sales.document_number_seq');

INSERT INTO sales.credit_notes (invoice_id, amount, reason) VALUES
    (1, 20.00, 'Damaged in transit'),
    (3, 99.00, 'Returned item');

-- ---------------------------------------------------------------------------
-- inventory: warehouses + per-warehouse stock. stock reaches into
-- sales.products (cross-schema: inventory -> sales) and inventory.warehouses
-- (intra-schema).
-- ---------------------------------------------------------------------------
CREATE SCHEMA inventory;

CREATE TABLE inventory.warehouses (
    id     serial  PRIMARY KEY,
    code   text    UNIQUE NOT NULL,
    name   text    NOT NULL,
    city   text    NOT NULL
);

INSERT INTO inventory.warehouses (code, name, city) VALUES
    ('WH-A', 'Main Warehouse', 'Berlin'),
    ('WH-B', 'East Depot',     'Warsaw'),
    ('WH-C', 'West Depot',     'Lisbon');

CREATE TABLE inventory.stock (
    id            serial  PRIMARY KEY,
    product_id    integer NOT NULL REFERENCES sales.products (id),
    warehouse_id  integer NOT NULL REFERENCES inventory.warehouses (id),
    quantity      integer NOT NULL DEFAULT 0,
    UNIQUE (product_id, warehouse_id)
);

INSERT INTO inventory.stock (product_id, warehouse_id, quantity) VALUES
    (1, 1, 500),
    (1, 2, 120),
    (2, 1, 300),
    (3, 3, 50),
    (4, 2, 0),
    (5, 1, 10),
    (6, 3, 5);

CREATE VIEW inventory.low_stock AS
    SELECT w.name AS warehouse,
           p.name AS product,
           s.quantity
    FROM inventory.stock s
    JOIN inventory.warehouses w ON w.id = s.warehouse_id
    JOIN sales.products p       ON p.id = s.product_id
    WHERE s.quantity < 20;

-- ---------------------------------------------------------------------------
-- hr: departments + employees. employees carries a self-referencing FK
-- (manager_id -> hr.employees, exercising a self-loop edge) plus a
-- cross-schema FK to inventory.warehouses (hr -> inventory).
-- ---------------------------------------------------------------------------
CREATE SCHEMA hr;

CREATE TABLE hr.departments (
    id      serial         PRIMARY KEY,
    name    text           UNIQUE NOT NULL,
    budget  numeric(14, 2) NOT NULL DEFAULT 0
);

INSERT INTO hr.departments (name, budget) VALUES
    ('Engineering', 500000.00),
    ('Operations',  250000.00),
    ('Sales',       180000.00),
    ('Support',      90000.00);

CREATE TABLE hr.employees (
    id             serial  PRIMARY KEY,
    name           text    NOT NULL,
    email          text    UNIQUE NOT NULL,
    department_id  integer NOT NULL REFERENCES hr.departments (id),
    manager_id     integer REFERENCES hr.employees (id),
    warehouse_id   integer REFERENCES inventory.warehouses (id)
);

-- manager_id references rows in this same statement; PostgreSQL checks the FK
-- at statement end, so referencing an earlier row's serial id is fine.
INSERT INTO hr.employees (name, email, department_id, manager_id, warehouse_id) VALUES
    ('Nancy Manager', 'nancy@example.com', 1, NULL, 1),
    ('Omar Ops',      'omar@example.com',  2, 1,    2),
    ('Priya Dev',     'priya@example.com', 1, 1,    NULL),
    ('Quinn Sales',   'quinn@example.com', 3, 2,    3),
    ('Rosa Support',  'rosa@example.com',  4, 2,    NULL);

CREATE VIEW hr.employee_directory AS
    SELECT e.name AS employee,
           d.name AS department,
           m.name AS manager
    FROM hr.employees e
    JOIN hr.departments d    ON d.id = e.department_id
    LEFT JOIN hr.employees m ON m.id = e.manager_id;

-- ---------------------------------------------------------------------------
-- analytics: read-only rollups. A materialized view over public plus a plain
-- view over sales, so the navigator/diagrams show both view kinds and a
-- schema built entirely from derived objects.
-- ---------------------------------------------------------------------------
CREATE SCHEMA analytics;

CREATE MATERIALIZED VIEW analytics.customer_orders AS
    SELECT c.id                       AS customer_id,
           c.name,
           count(o.id)                AS order_count,
           coalesce(sum(o.total), 0)  AS total_spent
    FROM public.customers c
    LEFT JOIN public.orders o ON o.customer_id = c.id
    GROUP BY c.id, c.name;

CREATE VIEW analytics.revenue_by_category AS
    SELECT p.category,
           sum(oi.quantity * oi.unit_price) AS revenue
    FROM sales.order_items oi
    JOIN sales.products p ON p.id = oi.product_id
    GROUP BY p.category;
