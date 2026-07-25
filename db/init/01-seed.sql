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

-- ---------------------------------------------------------------------------
-- wide: stress tables for very-wide-table rendering. Column counts step up
-- (10, 15, 20, 25, 30, 40, 60) so horizontal scrolling, the column grid, and
-- the Structure tab can be exercised against real tables of increasing width.
-- wide.cols_60 is the 50+-column case; non-key columns rotate through a
-- representative spread of types (int / text / numeric / boolean / date /
-- timestamptz / varchar / bigint). Each table is seeded with a few rows.
-- ---------------------------------------------------------------------------
CREATE SCHEMA wide;

CREATE TABLE wide.cols_10 (
    id  serial  PRIMARY KEY,
    col_002_int      integer,
    col_003_txt      text,
    col_004_num      numeric(12, 2),
    col_005_flag     boolean,
    col_006_day      date,
    col_007_ts       timestamptz,
    col_008_code     varchar(16),
    col_009_big      bigint,
    col_010_int      integer
);

INSERT INTO wide.cols_10 (col_002_int, col_003_txt, col_004_num, col_005_flag, col_006_day, col_007_ts, col_008_code, col_009_big, col_010_int) VALUES
    (201, 'r1c3', 41.05, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-1', 9000001, 1001),
    (202, 'r2c3', 42.06, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-2', 9000002, 1002),
    (203, 'r3c3', 43.07, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-3', 9000003, 1003),
    (204, 'r4c3', 44.08, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-4', 9000004, 1004),
    (205, 'r5c3', 45.09, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-5', 9000005, 1005),
    (206, 'r6c3', 46.10, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-6', 9000006, 1006),
    (207, 'r7c3', 47.11, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-7', 9000007, 1007),
    (208, 'r8c3', 48.12, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-8', 9000008, 1008),
    (209, 'r9c3', 49.13, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-9', 9000009, 1009),
    (210, 'r10c3', 410.14, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-10', 9000010, 1010),
    (211, 'r11c3', 411.15, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-11', 9000011, 1011),
    (212, 'r12c3', 412.16, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-12', 9000012, 1012),
    (213, 'r13c3', 413.17, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-13', 9000013, 1013),
    (214, 'r14c3', 414.18, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-14', 9000014, 1014),
    (215, 'r15c3', 415.19, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-15', 9000015, 1015),
    (216, 'r16c3', 416.20, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-16', 9000016, 1016),
    (217, 'r17c3', 417.21, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-17', 9000017, 1017),
    (218, 'r18c3', 418.22, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-18', 9000018, 1018),
    (219, 'r19c3', 419.23, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-19', 9000019, 1019),
    (220, 'r20c3', 420.24, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-20', 9000020, 1020),
    (221, 'r21c3', 421.25, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-21', 9000021, 1021),
    (222, 'r22c3', 422.26, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-22', 9000022, 1022),
    (223, 'r23c3', 423.27, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-23', 9000023, 1023),
    (224, 'r24c3', 424.28, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-24', 9000024, 1024),
    (225, 'r25c3', 425.29, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-25', 9000025, 1025),
    (226, 'r26c3', 426.30, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-26', 9000026, 1026),
    (227, 'r27c3', 427.31, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-27', 9000027, 1027),
    (228, 'r28c3', 428.32, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-28', 9000028, 1028),
    (229, 'r29c3', 429.33, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-29', 9000029, 1029),
    (230, 'r30c3', 430.34, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-30', 9000030, 1030),
    (231, 'r31c3', 431.35, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-31', 9000031, 1031),
    (232, 'r32c3', 432.36, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-32', 9000032, 1032),
    (233, 'r33c3', 433.37, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-33', 9000033, 1033),
    (234, 'r34c3', 434.38, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-34', 9000034, 1034),
    (235, 'r35c3', 435.39, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-35', 9000035, 1035),
    (236, 'r36c3', 436.40, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-36', 9000036, 1036),
    (237, 'r37c3', 437.41, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-37', 9000037, 1037),
    (238, 'r38c3', 438.42, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-38', 9000038, 1038),
    (239, 'r39c3', 439.43, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-39', 9000039, 1039),
    (240, 'r40c3', 440.44, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-40', 9000040, 1040),
    (241, 'r41c3', 441.45, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-41', 9000041, 1041),
    (242, 'r42c3', 442.46, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-42', 9000042, 1042),
    (243, 'r43c3', 443.47, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-43', 9000043, 1043),
    (244, 'r44c3', 444.48, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-44', 9000044, 1044),
    (245, 'r45c3', 445.49, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-45', 9000045, 1045),
    (246, 'r46c3', 446.50, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-46', 9000046, 1046),
    (247, 'r47c3', 447.51, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-47', 9000047, 1047),
    (248, 'r48c3', 448.52, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-48', 9000048, 1048),
    (249, 'r49c3', 449.53, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-49', 9000049, 1049),
    (250, 'r50c3', 450.54, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-50', 9000050, 1050),
    (251, 'r51c3', 451.55, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-51', 9000051, 1051),
    (252, 'r52c3', 452.56, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-52', 9000052, 1052),
    (253, 'r53c3', 453.57, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-53', 9000053, 1053),
    (254, 'r54c3', 454.58, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-54', 9000054, 1054),
    (255, 'r55c3', 455.59, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-55', 9000055, 1055),
    (256, 'r56c3', 456.60, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-56', 9000056, 1056),
    (257, 'r57c3', 457.61, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-57', 9000057, 1057),
    (258, 'r58c3', 458.62, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-58', 9000058, 1058),
    (259, 'r59c3', 459.63, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-59', 9000059, 1059),
    (260, 'r60c3', 460.64, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-60', 9000060, 1060),
    (261, 'r61c3', 461.65, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-61', 9000061, 1061),
    (262, 'r62c3', 462.66, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-62', 9000062, 1062),
    (263, 'r63c3', 463.67, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-63', 9000063, 1063),
    (264, 'r64c3', 464.68, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-64', 9000064, 1064),
    (265, 'r65c3', 465.69, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-65', 9000065, 1065),
    (266, 'r66c3', 466.70, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-66', 9000066, 1066),
    (267, 'r67c3', 467.71, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-67', 9000067, 1067),
    (268, 'r68c3', 468.72, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-68', 9000068, 1068),
    (269, 'r69c3', 469.73, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-69', 9000069, 1069),
    (270, 'r70c3', 470.74, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-70', 9000070, 1070),
    (271, 'r71c3', 471.75, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-71', 9000071, 1071),
    (272, 'r72c3', 472.76, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-72', 9000072, 1072),
    (273, 'r73c3', 473.77, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-73', 9000073, 1073),
    (274, 'r74c3', 474.78, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-74', 9000074, 1074),
    (275, 'r75c3', 475.79, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-75', 9000075, 1075),
    (276, 'r76c3', 476.80, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-76', 9000076, 1076),
    (277, 'r77c3', 477.81, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-77', 9000077, 1077),
    (278, 'r78c3', 478.82, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-78', 9000078, 1078),
    (279, 'r79c3', 479.83, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-79', 9000079, 1079),
    (280, 'r80c3', 480.84, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-80', 9000080, 1080),
    (281, 'r81c3', 481.85, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-81', 9000081, 1081),
    (282, 'r82c3', 482.86, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-82', 9000082, 1082),
    (283, 'r83c3', 483.87, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-83', 9000083, 1083),
    (284, 'r84c3', 484.88, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-84', 9000084, 1084),
    (285, 'r85c3', 485.89, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-85', 9000085, 1085),
    (286, 'r86c3', 486.90, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-86', 9000086, 1086),
    (287, 'r87c3', 487.91, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-87', 9000087, 1087),
    (288, 'r88c3', 488.92, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-88', 9000088, 1088),
    (289, 'r89c3', 489.93, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-89', 9000089, 1089),
    (290, 'r90c3', 490.94, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-90', 9000090, 1090),
    (291, 'r91c3', 491.95, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-91', 9000091, 1091),
    (292, 'r92c3', 492.96, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-92', 9000092, 1092),
    (293, 'r93c3', 493.97, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-93', 9000093, 1093),
    (294, 'r94c3', 494.98, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-94', 9000094, 1094),
    (295, 'r95c3', 495.99, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-95', 9000095, 1095),
    (296, 'r96c3', 496.00, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-96', 9000096, 1096),
    (297, 'r97c3', 497.01, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-97', 9000097, 1097),
    (298, 'r98c3', 498.02, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-98', 9000098, 1098),
    (299, 'r99c3', 499.03, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-99', 9000099, 1099),
    (300, 'r100c3', 4100.04, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-100', 9000100, 1100),
    (301, 'r101c3', 4101.05, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-101', 9000101, 1101),
    (302, 'r102c3', 4102.06, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-102', 9000102, 1102),
    (303, 'r103c3', 4103.07, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-103', 9000103, 1103),
    (304, 'r104c3', 4104.08, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-104', 9000104, 1104),
    (305, 'r105c3', 4105.09, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-105', 9000105, 1105),
    (306, 'r106c3', 4106.10, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-106', 9000106, 1106),
    (307, 'r107c3', 4107.11, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-107', 9000107, 1107),
    (308, 'r108c3', 4108.12, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-108', 9000108, 1108),
    (309, 'r109c3', 4109.13, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-109', 9000109, 1109),
    (310, 'r110c3', 4110.14, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-110', 9000110, 1110),
    (311, 'r111c3', 4111.15, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-111', 9000111, 1111),
    (312, 'r112c3', 4112.16, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-112', 9000112, 1112),
    (313, 'r113c3', 4113.17, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-113', 9000113, 1113),
    (314, 'r114c3', 4114.18, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-114', 9000114, 1114),
    (315, 'r115c3', 4115.19, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-115', 9000115, 1115),
    (316, 'r116c3', 4116.20, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-116', 9000116, 1116),
    (317, 'r117c3', 4117.21, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-117', 9000117, 1117),
    (318, 'r118c3', 4118.22, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-118', 9000118, 1118),
    (319, 'r119c3', 4119.23, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-119', 9000119, 1119),
    (320, 'r120c3', 4120.24, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-120', 9000120, 1120);

CREATE TABLE wide.cols_15 (
    id  serial  PRIMARY KEY,
    col_002_int      integer,
    col_003_txt      text,
    col_004_num      numeric(12, 2),
    col_005_flag     boolean,
    col_006_day      date,
    col_007_ts       timestamptz,
    col_008_code     varchar(16),
    col_009_big      bigint,
    col_010_int      integer,
    col_011_txt      text,
    col_012_num      numeric(12, 2),
    col_013_flag     boolean,
    col_014_day      date,
    col_015_ts       timestamptz
);

INSERT INTO wide.cols_15 (col_002_int, col_003_txt, col_004_num, col_005_flag, col_006_day, col_007_ts, col_008_code, col_009_big, col_010_int, col_011_txt, col_012_num, col_013_flag, col_014_day, col_015_ts) VALUES
    (201, 'r1c3', 41.05, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-1', 9000001, 1001, 'r1c11', 121.13, true, '2026-03-02', '2026-04-02 12:00:00+00'),
    (202, 'r2c3', 42.06, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-2', 9000002, 1002, 'r2c11', 122.14, false, '2026-03-03', '2026-04-03 12:00:00+00'),
    (203, 'r3c3', 43.07, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-3', 9000003, 1003, 'r3c11', 123.15, true, '2026-03-04', '2026-04-04 12:00:00+00'),
    (204, 'r4c3', 44.08, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-4', 9000004, 1004, 'r4c11', 124.16, false, '2026-03-05', '2026-04-05 12:00:00+00'),
    (205, 'r5c3', 45.09, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-5', 9000005, 1005, 'r5c11', 125.17, true, '2026-03-06', '2026-04-06 12:00:00+00'),
    (206, 'r6c3', 46.10, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-6', 9000006, 1006, 'r6c11', 126.18, false, '2026-03-07', '2026-04-07 12:00:00+00'),
    (207, 'r7c3', 47.11, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-7', 9000007, 1007, 'r7c11', 127.19, true, '2026-03-08', '2026-04-08 12:00:00+00'),
    (208, 'r8c3', 48.12, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-8', 9000008, 1008, 'r8c11', 128.20, false, '2026-03-09', '2026-04-09 12:00:00+00'),
    (209, 'r9c3', 49.13, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-9', 9000009, 1009, 'r9c11', 129.21, true, '2026-03-10', '2026-04-10 12:00:00+00'),
    (210, 'r10c3', 410.14, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-10', 9000010, 1010, 'r10c11', 1210.22, false, '2026-03-11', '2026-04-11 12:00:00+00'),
    (211, 'r11c3', 411.15, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-11', 9000011, 1011, 'r11c11', 1211.23, true, '2026-03-12', '2026-04-12 12:00:00+00'),
    (212, 'r12c3', 412.16, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-12', 9000012, 1012, 'r12c11', 1212.24, false, '2026-03-13', '2026-04-13 12:00:00+00'),
    (213, 'r13c3', 413.17, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-13', 9000013, 1013, 'r13c11', 1213.25, true, '2026-03-14', '2026-04-14 12:00:00+00'),
    (214, 'r14c3', 414.18, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-14', 9000014, 1014, 'r14c11', 1214.26, false, '2026-03-15', '2026-04-15 12:00:00+00'),
    (215, 'r15c3', 415.19, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-15', 9000015, 1015, 'r15c11', 1215.27, true, '2026-03-16', '2026-04-16 12:00:00+00'),
    (216, 'r16c3', 416.20, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-16', 9000016, 1016, 'r16c11', 1216.28, false, '2026-03-17', '2026-04-17 12:00:00+00'),
    (217, 'r17c3', 417.21, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-17', 9000017, 1017, 'r17c11', 1217.29, true, '2026-03-18', '2026-04-18 12:00:00+00'),
    (218, 'r18c3', 418.22, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-18', 9000018, 1018, 'r18c11', 1218.30, false, '2026-03-19', '2026-04-19 12:00:00+00'),
    (219, 'r19c3', 419.23, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-19', 9000019, 1019, 'r19c11', 1219.31, true, '2026-03-20', '2026-04-20 12:00:00+00'),
    (220, 'r20c3', 420.24, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-20', 9000020, 1020, 'r20c11', 1220.32, false, '2026-03-21', '2026-04-21 12:00:00+00'),
    (221, 'r21c3', 421.25, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-21', 9000021, 1021, 'r21c11', 1221.33, true, '2026-03-22', '2026-04-22 12:00:00+00'),
    (222, 'r22c3', 422.26, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-22', 9000022, 1022, 'r22c11', 1222.34, false, '2026-03-23', '2026-04-23 12:00:00+00'),
    (223, 'r23c3', 423.27, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-23', 9000023, 1023, 'r23c11', 1223.35, true, '2026-03-24', '2026-04-24 12:00:00+00'),
    (224, 'r24c3', 424.28, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-24', 9000024, 1024, 'r24c11', 1224.36, false, '2026-03-25', '2026-04-25 12:00:00+00'),
    (225, 'r25c3', 425.29, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-25', 9000025, 1025, 'r25c11', 1225.37, true, '2026-03-26', '2026-04-26 12:00:00+00'),
    (226, 'r26c3', 426.30, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-26', 9000026, 1026, 'r26c11', 1226.38, false, '2026-03-27', '2026-04-27 12:00:00+00'),
    (227, 'r27c3', 427.31, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-27', 9000027, 1027, 'r27c11', 1227.39, true, '2026-03-01', '2026-04-01 12:00:00+00'),
    (228, 'r28c3', 428.32, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-28', 9000028, 1028, 'r28c11', 1228.40, false, '2026-03-02', '2026-04-02 12:00:00+00'),
    (229, 'r29c3', 429.33, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-29', 9000029, 1029, 'r29c11', 1229.41, true, '2026-03-03', '2026-04-03 12:00:00+00'),
    (230, 'r30c3', 430.34, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-30', 9000030, 1030, 'r30c11', 1230.42, false, '2026-03-04', '2026-04-04 12:00:00+00'),
    (231, 'r31c3', 431.35, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-31', 9000031, 1031, 'r31c11', 1231.43, true, '2026-03-05', '2026-04-05 12:00:00+00'),
    (232, 'r32c3', 432.36, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-32', 9000032, 1032, 'r32c11', 1232.44, false, '2026-03-06', '2026-04-06 12:00:00+00'),
    (233, 'r33c3', 433.37, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-33', 9000033, 1033, 'r33c11', 1233.45, true, '2026-03-07', '2026-04-07 12:00:00+00'),
    (234, 'r34c3', 434.38, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-34', 9000034, 1034, 'r34c11', 1234.46, false, '2026-03-08', '2026-04-08 12:00:00+00'),
    (235, 'r35c3', 435.39, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-35', 9000035, 1035, 'r35c11', 1235.47, true, '2026-03-09', '2026-04-09 12:00:00+00'),
    (236, 'r36c3', 436.40, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-36', 9000036, 1036, 'r36c11', 1236.48, false, '2026-03-10', '2026-04-10 12:00:00+00'),
    (237, 'r37c3', 437.41, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-37', 9000037, 1037, 'r37c11', 1237.49, true, '2026-03-11', '2026-04-11 12:00:00+00'),
    (238, 'r38c3', 438.42, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-38', 9000038, 1038, 'r38c11', 1238.50, false, '2026-03-12', '2026-04-12 12:00:00+00'),
    (239, 'r39c3', 439.43, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-39', 9000039, 1039, 'r39c11', 1239.51, true, '2026-03-13', '2026-04-13 12:00:00+00'),
    (240, 'r40c3', 440.44, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-40', 9000040, 1040, 'r40c11', 1240.52, false, '2026-03-14', '2026-04-14 12:00:00+00'),
    (241, 'r41c3', 441.45, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-41', 9000041, 1041, 'r41c11', 1241.53, true, '2026-03-15', '2026-04-15 12:00:00+00'),
    (242, 'r42c3', 442.46, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-42', 9000042, 1042, 'r42c11', 1242.54, false, '2026-03-16', '2026-04-16 12:00:00+00'),
    (243, 'r43c3', 443.47, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-43', 9000043, 1043, 'r43c11', 1243.55, true, '2026-03-17', '2026-04-17 12:00:00+00'),
    (244, 'r44c3', 444.48, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-44', 9000044, 1044, 'r44c11', 1244.56, false, '2026-03-18', '2026-04-18 12:00:00+00'),
    (245, 'r45c3', 445.49, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-45', 9000045, 1045, 'r45c11', 1245.57, true, '2026-03-19', '2026-04-19 12:00:00+00'),
    (246, 'r46c3', 446.50, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-46', 9000046, 1046, 'r46c11', 1246.58, false, '2026-03-20', '2026-04-20 12:00:00+00'),
    (247, 'r47c3', 447.51, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-47', 9000047, 1047, 'r47c11', 1247.59, true, '2026-03-21', '2026-04-21 12:00:00+00'),
    (248, 'r48c3', 448.52, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-48', 9000048, 1048, 'r48c11', 1248.60, false, '2026-03-22', '2026-04-22 12:00:00+00'),
    (249, 'r49c3', 449.53, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-49', 9000049, 1049, 'r49c11', 1249.61, true, '2026-03-23', '2026-04-23 12:00:00+00'),
    (250, 'r50c3', 450.54, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-50', 9000050, 1050, 'r50c11', 1250.62, false, '2026-03-24', '2026-04-24 12:00:00+00'),
    (251, 'r51c3', 451.55, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-51', 9000051, 1051, 'r51c11', 1251.63, true, '2026-03-25', '2026-04-25 12:00:00+00'),
    (252, 'r52c3', 452.56, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-52', 9000052, 1052, 'r52c11', 1252.64, false, '2026-03-26', '2026-04-26 12:00:00+00'),
    (253, 'r53c3', 453.57, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-53', 9000053, 1053, 'r53c11', 1253.65, true, '2026-03-27', '2026-04-27 12:00:00+00'),
    (254, 'r54c3', 454.58, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-54', 9000054, 1054, 'r54c11', 1254.66, false, '2026-03-01', '2026-04-01 12:00:00+00'),
    (255, 'r55c3', 455.59, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-55', 9000055, 1055, 'r55c11', 1255.67, true, '2026-03-02', '2026-04-02 12:00:00+00'),
    (256, 'r56c3', 456.60, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-56', 9000056, 1056, 'r56c11', 1256.68, false, '2026-03-03', '2026-04-03 12:00:00+00'),
    (257, 'r57c3', 457.61, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-57', 9000057, 1057, 'r57c11', 1257.69, true, '2026-03-04', '2026-04-04 12:00:00+00'),
    (258, 'r58c3', 458.62, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-58', 9000058, 1058, 'r58c11', 1258.70, false, '2026-03-05', '2026-04-05 12:00:00+00'),
    (259, 'r59c3', 459.63, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-59', 9000059, 1059, 'r59c11', 1259.71, true, '2026-03-06', '2026-04-06 12:00:00+00'),
    (260, 'r60c3', 460.64, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-60', 9000060, 1060, 'r60c11', 1260.72, false, '2026-03-07', '2026-04-07 12:00:00+00'),
    (261, 'r61c3', 461.65, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-61', 9000061, 1061, 'r61c11', 1261.73, true, '2026-03-08', '2026-04-08 12:00:00+00'),
    (262, 'r62c3', 462.66, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-62', 9000062, 1062, 'r62c11', 1262.74, false, '2026-03-09', '2026-04-09 12:00:00+00'),
    (263, 'r63c3', 463.67, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-63', 9000063, 1063, 'r63c11', 1263.75, true, '2026-03-10', '2026-04-10 12:00:00+00'),
    (264, 'r64c3', 464.68, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-64', 9000064, 1064, 'r64c11', 1264.76, false, '2026-03-11', '2026-04-11 12:00:00+00'),
    (265, 'r65c3', 465.69, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-65', 9000065, 1065, 'r65c11', 1265.77, true, '2026-03-12', '2026-04-12 12:00:00+00'),
    (266, 'r66c3', 466.70, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-66', 9000066, 1066, 'r66c11', 1266.78, false, '2026-03-13', '2026-04-13 12:00:00+00'),
    (267, 'r67c3', 467.71, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-67', 9000067, 1067, 'r67c11', 1267.79, true, '2026-03-14', '2026-04-14 12:00:00+00'),
    (268, 'r68c3', 468.72, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-68', 9000068, 1068, 'r68c11', 1268.80, false, '2026-03-15', '2026-04-15 12:00:00+00'),
    (269, 'r69c3', 469.73, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-69', 9000069, 1069, 'r69c11', 1269.81, true, '2026-03-16', '2026-04-16 12:00:00+00'),
    (270, 'r70c3', 470.74, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-70', 9000070, 1070, 'r70c11', 1270.82, false, '2026-03-17', '2026-04-17 12:00:00+00'),
    (271, 'r71c3', 471.75, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-71', 9000071, 1071, 'r71c11', 1271.83, true, '2026-03-18', '2026-04-18 12:00:00+00'),
    (272, 'r72c3', 472.76, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-72', 9000072, 1072, 'r72c11', 1272.84, false, '2026-03-19', '2026-04-19 12:00:00+00'),
    (273, 'r73c3', 473.77, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-73', 9000073, 1073, 'r73c11', 1273.85, true, '2026-03-20', '2026-04-20 12:00:00+00'),
    (274, 'r74c3', 474.78, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-74', 9000074, 1074, 'r74c11', 1274.86, false, '2026-03-21', '2026-04-21 12:00:00+00'),
    (275, 'r75c3', 475.79, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-75', 9000075, 1075, 'r75c11', 1275.87, true, '2026-03-22', '2026-04-22 12:00:00+00'),
    (276, 'r76c3', 476.80, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-76', 9000076, 1076, 'r76c11', 1276.88, false, '2026-03-23', '2026-04-23 12:00:00+00'),
    (277, 'r77c3', 477.81, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-77', 9000077, 1077, 'r77c11', 1277.89, true, '2026-03-24', '2026-04-24 12:00:00+00'),
    (278, 'r78c3', 478.82, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-78', 9000078, 1078, 'r78c11', 1278.90, false, '2026-03-25', '2026-04-25 12:00:00+00'),
    (279, 'r79c3', 479.83, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-79', 9000079, 1079, 'r79c11', 1279.91, true, '2026-03-26', '2026-04-26 12:00:00+00'),
    (280, 'r80c3', 480.84, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-80', 9000080, 1080, 'r80c11', 1280.92, false, '2026-03-27', '2026-04-27 12:00:00+00'),
    (281, 'r81c3', 481.85, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-81', 9000081, 1081, 'r81c11', 1281.93, true, '2026-03-01', '2026-04-01 12:00:00+00'),
    (282, 'r82c3', 482.86, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-82', 9000082, 1082, 'r82c11', 1282.94, false, '2026-03-02', '2026-04-02 12:00:00+00'),
    (283, 'r83c3', 483.87, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-83', 9000083, 1083, 'r83c11', 1283.95, true, '2026-03-03', '2026-04-03 12:00:00+00'),
    (284, 'r84c3', 484.88, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-84', 9000084, 1084, 'r84c11', 1284.96, false, '2026-03-04', '2026-04-04 12:00:00+00'),
    (285, 'r85c3', 485.89, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-85', 9000085, 1085, 'r85c11', 1285.97, true, '2026-03-05', '2026-04-05 12:00:00+00'),
    (286, 'r86c3', 486.90, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-86', 9000086, 1086, 'r86c11', 1286.98, false, '2026-03-06', '2026-04-06 12:00:00+00'),
    (287, 'r87c3', 487.91, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-87', 9000087, 1087, 'r87c11', 1287.99, true, '2026-03-07', '2026-04-07 12:00:00+00'),
    (288, 'r88c3', 488.92, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-88', 9000088, 1088, 'r88c11', 1288.00, false, '2026-03-08', '2026-04-08 12:00:00+00'),
    (289, 'r89c3', 489.93, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-89', 9000089, 1089, 'r89c11', 1289.01, true, '2026-03-09', '2026-04-09 12:00:00+00'),
    (290, 'r90c3', 490.94, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-90', 9000090, 1090, 'r90c11', 1290.02, false, '2026-03-10', '2026-04-10 12:00:00+00'),
    (291, 'r91c3', 491.95, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-91', 9000091, 1091, 'r91c11', 1291.03, true, '2026-03-11', '2026-04-11 12:00:00+00'),
    (292, 'r92c3', 492.96, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-92', 9000092, 1092, 'r92c11', 1292.04, false, '2026-03-12', '2026-04-12 12:00:00+00'),
    (293, 'r93c3', 493.97, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-93', 9000093, 1093, 'r93c11', 1293.05, true, '2026-03-13', '2026-04-13 12:00:00+00'),
    (294, 'r94c3', 494.98, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-94', 9000094, 1094, 'r94c11', 1294.06, false, '2026-03-14', '2026-04-14 12:00:00+00'),
    (295, 'r95c3', 495.99, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-95', 9000095, 1095, 'r95c11', 1295.07, true, '2026-03-15', '2026-04-15 12:00:00+00'),
    (296, 'r96c3', 496.00, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-96', 9000096, 1096, 'r96c11', 1296.08, false, '2026-03-16', '2026-04-16 12:00:00+00'),
    (297, 'r97c3', 497.01, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-97', 9000097, 1097, 'r97c11', 1297.09, true, '2026-03-17', '2026-04-17 12:00:00+00'),
    (298, 'r98c3', 498.02, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-98', 9000098, 1098, 'r98c11', 1298.10, false, '2026-03-18', '2026-04-18 12:00:00+00'),
    (299, 'r99c3', 499.03, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-99', 9000099, 1099, 'r99c11', 1299.11, true, '2026-03-19', '2026-04-19 12:00:00+00'),
    (300, 'r100c3', 4100.04, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-100', 9000100, 1100, 'r100c11', 12100.12, false, '2026-03-20', '2026-04-20 12:00:00+00'),
    (301, 'r101c3', 4101.05, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-101', 9000101, 1101, 'r101c11', 12101.13, true, '2026-03-21', '2026-04-21 12:00:00+00'),
    (302, 'r102c3', 4102.06, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-102', 9000102, 1102, 'r102c11', 12102.14, false, '2026-03-22', '2026-04-22 12:00:00+00'),
    (303, 'r103c3', 4103.07, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-103', 9000103, 1103, 'r103c11', 12103.15, true, '2026-03-23', '2026-04-23 12:00:00+00'),
    (304, 'r104c3', 4104.08, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-104', 9000104, 1104, 'r104c11', 12104.16, false, '2026-03-24', '2026-04-24 12:00:00+00'),
    (305, 'r105c3', 4105.09, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-105', 9000105, 1105, 'r105c11', 12105.17, true, '2026-03-25', '2026-04-25 12:00:00+00'),
    (306, 'r106c3', 4106.10, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-106', 9000106, 1106, 'r106c11', 12106.18, false, '2026-03-26', '2026-04-26 12:00:00+00'),
    (307, 'r107c3', 4107.11, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-107', 9000107, 1107, 'r107c11', 12107.19, true, '2026-03-27', '2026-04-27 12:00:00+00'),
    (308, 'r108c3', 4108.12, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-108', 9000108, 1108, 'r108c11', 12108.20, false, '2026-03-01', '2026-04-01 12:00:00+00'),
    (309, 'r109c3', 4109.13, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-109', 9000109, 1109, 'r109c11', 12109.21, true, '2026-03-02', '2026-04-02 12:00:00+00'),
    (310, 'r110c3', 4110.14, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-110', 9000110, 1110, 'r110c11', 12110.22, false, '2026-03-03', '2026-04-03 12:00:00+00'),
    (311, 'r111c3', 4111.15, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-111', 9000111, 1111, 'r111c11', 12111.23, true, '2026-03-04', '2026-04-04 12:00:00+00'),
    (312, 'r112c3', 4112.16, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-112', 9000112, 1112, 'r112c11', 12112.24, false, '2026-03-05', '2026-04-05 12:00:00+00'),
    (313, 'r113c3', 4113.17, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-113', 9000113, 1113, 'r113c11', 12113.25, true, '2026-03-06', '2026-04-06 12:00:00+00'),
    (314, 'r114c3', 4114.18, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-114', 9000114, 1114, 'r114c11', 12114.26, false, '2026-03-07', '2026-04-07 12:00:00+00'),
    (315, 'r115c3', 4115.19, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-115', 9000115, 1115, 'r115c11', 12115.27, true, '2026-03-08', '2026-04-08 12:00:00+00'),
    (316, 'r116c3', 4116.20, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-116', 9000116, 1116, 'r116c11', 12116.28, false, '2026-03-09', '2026-04-09 12:00:00+00'),
    (317, 'r117c3', 4117.21, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-117', 9000117, 1117, 'r117c11', 12117.29, true, '2026-03-10', '2026-04-10 12:00:00+00'),
    (318, 'r118c3', 4118.22, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-118', 9000118, 1118, 'r118c11', 12118.30, false, '2026-03-11', '2026-04-11 12:00:00+00'),
    (319, 'r119c3', 4119.23, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-119', 9000119, 1119, 'r119c11', 12119.31, true, '2026-03-12', '2026-04-12 12:00:00+00'),
    (320, 'r120c3', 4120.24, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-120', 9000120, 1120, 'r120c11', 12120.32, false, '2026-03-13', '2026-04-13 12:00:00+00');

CREATE TABLE wide.cols_20 (
    id  serial  PRIMARY KEY,
    col_002_int      integer,
    col_003_txt      text,
    col_004_num      numeric(12, 2),
    col_005_flag     boolean,
    col_006_day      date,
    col_007_ts       timestamptz,
    col_008_code     varchar(16),
    col_009_big      bigint,
    col_010_int      integer,
    col_011_txt      text,
    col_012_num      numeric(12, 2),
    col_013_flag     boolean,
    col_014_day      date,
    col_015_ts       timestamptz,
    col_016_code     varchar(16),
    col_017_big      bigint,
    col_018_int      integer,
    col_019_txt      text,
    col_020_num      numeric(12, 2)
);

INSERT INTO wide.cols_20 (col_002_int, col_003_txt, col_004_num, col_005_flag, col_006_day, col_007_ts, col_008_code, col_009_big, col_010_int, col_011_txt, col_012_num, col_013_flag, col_014_day, col_015_ts, col_016_code, col_017_big, col_018_int, col_019_txt, col_020_num) VALUES
    (201, 'r1c3', 41.05, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-1', 9000001, 1001, 'r1c11', 121.13, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-1', 17000001, 1801, 'r1c19', 201.21),
    (202, 'r2c3', 42.06, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-2', 9000002, 1002, 'r2c11', 122.14, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-2', 17000002, 1802, 'r2c19', 202.22),
    (203, 'r3c3', 43.07, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-3', 9000003, 1003, 'r3c11', 123.15, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-3', 17000003, 1803, 'r3c19', 203.23),
    (204, 'r4c3', 44.08, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-4', 9000004, 1004, 'r4c11', 124.16, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-4', 17000004, 1804, 'r4c19', 204.24),
    (205, 'r5c3', 45.09, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-5', 9000005, 1005, 'r5c11', 125.17, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-5', 17000005, 1805, 'r5c19', 205.25),
    (206, 'r6c3', 46.10, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-6', 9000006, 1006, 'r6c11', 126.18, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-6', 17000006, 1806, 'r6c19', 206.26),
    (207, 'r7c3', 47.11, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-7', 9000007, 1007, 'r7c11', 127.19, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-7', 17000007, 1807, 'r7c19', 207.27),
    (208, 'r8c3', 48.12, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-8', 9000008, 1008, 'r8c11', 128.20, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-8', 17000008, 1808, 'r8c19', 208.28),
    (209, 'r9c3', 49.13, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-9', 9000009, 1009, 'r9c11', 129.21, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-9', 17000009, 1809, 'r9c19', 209.29),
    (210, 'r10c3', 410.14, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-10', 9000010, 1010, 'r10c11', 1210.22, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-10', 17000010, 1810, 'r10c19', 2010.30),
    (211, 'r11c3', 411.15, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-11', 9000011, 1011, 'r11c11', 1211.23, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-11', 17000011, 1811, 'r11c19', 2011.31),
    (212, 'r12c3', 412.16, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-12', 9000012, 1012, 'r12c11', 1212.24, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-12', 17000012, 1812, 'r12c19', 2012.32),
    (213, 'r13c3', 413.17, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-13', 9000013, 1013, 'r13c11', 1213.25, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-13', 17000013, 1813, 'r13c19', 2013.33),
    (214, 'r14c3', 414.18, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-14', 9000014, 1014, 'r14c11', 1214.26, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-14', 17000014, 1814, 'r14c19', 2014.34),
    (215, 'r15c3', 415.19, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-15', 9000015, 1015, 'r15c11', 1215.27, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-15', 17000015, 1815, 'r15c19', 2015.35),
    (216, 'r16c3', 416.20, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-16', 9000016, 1016, 'r16c11', 1216.28, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-16', 17000016, 1816, 'r16c19', 2016.36),
    (217, 'r17c3', 417.21, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-17', 9000017, 1017, 'r17c11', 1217.29, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-17', 17000017, 1817, 'r17c19', 2017.37),
    (218, 'r18c3', 418.22, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-18', 9000018, 1018, 'r18c11', 1218.30, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-18', 17000018, 1818, 'r18c19', 2018.38),
    (219, 'r19c3', 419.23, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-19', 9000019, 1019, 'r19c11', 1219.31, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-19', 17000019, 1819, 'r19c19', 2019.39),
    (220, 'r20c3', 420.24, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-20', 9000020, 1020, 'r20c11', 1220.32, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-20', 17000020, 1820, 'r20c19', 2020.40),
    (221, 'r21c3', 421.25, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-21', 9000021, 1021, 'r21c11', 1221.33, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-21', 17000021, 1821, 'r21c19', 2021.41),
    (222, 'r22c3', 422.26, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-22', 9000022, 1022, 'r22c11', 1222.34, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-22', 17000022, 1822, 'r22c19', 2022.42),
    (223, 'r23c3', 423.27, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-23', 9000023, 1023, 'r23c11', 1223.35, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-23', 17000023, 1823, 'r23c19', 2023.43),
    (224, 'r24c3', 424.28, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-24', 9000024, 1024, 'r24c11', 1224.36, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-24', 17000024, 1824, 'r24c19', 2024.44),
    (225, 'r25c3', 425.29, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-25', 9000025, 1025, 'r25c11', 1225.37, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-25', 17000025, 1825, 'r25c19', 2025.45),
    (226, 'r26c3', 426.30, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-26', 9000026, 1026, 'r26c11', 1226.38, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-26', 17000026, 1826, 'r26c19', 2026.46),
    (227, 'r27c3', 427.31, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-27', 9000027, 1027, 'r27c11', 1227.39, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-27', 17000027, 1827, 'r27c19', 2027.47),
    (228, 'r28c3', 428.32, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-28', 9000028, 1028, 'r28c11', 1228.40, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-28', 17000028, 1828, 'r28c19', 2028.48),
    (229, 'r29c3', 429.33, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-29', 9000029, 1029, 'r29c11', 1229.41, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-29', 17000029, 1829, 'r29c19', 2029.49),
    (230, 'r30c3', 430.34, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-30', 9000030, 1030, 'r30c11', 1230.42, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-30', 17000030, 1830, 'r30c19', 2030.50),
    (231, 'r31c3', 431.35, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-31', 9000031, 1031, 'r31c11', 1231.43, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-31', 17000031, 1831, 'r31c19', 2031.51),
    (232, 'r32c3', 432.36, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-32', 9000032, 1032, 'r32c11', 1232.44, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-32', 17000032, 1832, 'r32c19', 2032.52),
    (233, 'r33c3', 433.37, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-33', 9000033, 1033, 'r33c11', 1233.45, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-33', 17000033, 1833, 'r33c19', 2033.53),
    (234, 'r34c3', 434.38, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-34', 9000034, 1034, 'r34c11', 1234.46, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-34', 17000034, 1834, 'r34c19', 2034.54),
    (235, 'r35c3', 435.39, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-35', 9000035, 1035, 'r35c11', 1235.47, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-35', 17000035, 1835, 'r35c19', 2035.55),
    (236, 'r36c3', 436.40, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-36', 9000036, 1036, 'r36c11', 1236.48, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-36', 17000036, 1836, 'r36c19', 2036.56),
    (237, 'r37c3', 437.41, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-37', 9000037, 1037, 'r37c11', 1237.49, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-37', 17000037, 1837, 'r37c19', 2037.57),
    (238, 'r38c3', 438.42, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-38', 9000038, 1038, 'r38c11', 1238.50, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-38', 17000038, 1838, 'r38c19', 2038.58),
    (239, 'r39c3', 439.43, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-39', 9000039, 1039, 'r39c11', 1239.51, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-39', 17000039, 1839, 'r39c19', 2039.59),
    (240, 'r40c3', 440.44, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-40', 9000040, 1040, 'r40c11', 1240.52, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-40', 17000040, 1840, 'r40c19', 2040.60),
    (241, 'r41c3', 441.45, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-41', 9000041, 1041, 'r41c11', 1241.53, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-41', 17000041, 1841, 'r41c19', 2041.61),
    (242, 'r42c3', 442.46, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-42', 9000042, 1042, 'r42c11', 1242.54, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-42', 17000042, 1842, 'r42c19', 2042.62),
    (243, 'r43c3', 443.47, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-43', 9000043, 1043, 'r43c11', 1243.55, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-43', 17000043, 1843, 'r43c19', 2043.63),
    (244, 'r44c3', 444.48, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-44', 9000044, 1044, 'r44c11', 1244.56, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-44', 17000044, 1844, 'r44c19', 2044.64),
    (245, 'r45c3', 445.49, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-45', 9000045, 1045, 'r45c11', 1245.57, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-45', 17000045, 1845, 'r45c19', 2045.65),
    (246, 'r46c3', 446.50, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-46', 9000046, 1046, 'r46c11', 1246.58, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-46', 17000046, 1846, 'r46c19', 2046.66),
    (247, 'r47c3', 447.51, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-47', 9000047, 1047, 'r47c11', 1247.59, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-47', 17000047, 1847, 'r47c19', 2047.67),
    (248, 'r48c3', 448.52, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-48', 9000048, 1048, 'r48c11', 1248.60, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-48', 17000048, 1848, 'r48c19', 2048.68),
    (249, 'r49c3', 449.53, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-49', 9000049, 1049, 'r49c11', 1249.61, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-49', 17000049, 1849, 'r49c19', 2049.69),
    (250, 'r50c3', 450.54, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-50', 9000050, 1050, 'r50c11', 1250.62, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-50', 17000050, 1850, 'r50c19', 2050.70),
    (251, 'r51c3', 451.55, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-51', 9000051, 1051, 'r51c11', 1251.63, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-51', 17000051, 1851, 'r51c19', 2051.71),
    (252, 'r52c3', 452.56, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-52', 9000052, 1052, 'r52c11', 1252.64, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-52', 17000052, 1852, 'r52c19', 2052.72),
    (253, 'r53c3', 453.57, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-53', 9000053, 1053, 'r53c11', 1253.65, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-53', 17000053, 1853, 'r53c19', 2053.73),
    (254, 'r54c3', 454.58, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-54', 9000054, 1054, 'r54c11', 1254.66, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-54', 17000054, 1854, 'r54c19', 2054.74),
    (255, 'r55c3', 455.59, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-55', 9000055, 1055, 'r55c11', 1255.67, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-55', 17000055, 1855, 'r55c19', 2055.75),
    (256, 'r56c3', 456.60, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-56', 9000056, 1056, 'r56c11', 1256.68, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-56', 17000056, 1856, 'r56c19', 2056.76),
    (257, 'r57c3', 457.61, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-57', 9000057, 1057, 'r57c11', 1257.69, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-57', 17000057, 1857, 'r57c19', 2057.77),
    (258, 'r58c3', 458.62, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-58', 9000058, 1058, 'r58c11', 1258.70, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-58', 17000058, 1858, 'r58c19', 2058.78),
    (259, 'r59c3', 459.63, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-59', 9000059, 1059, 'r59c11', 1259.71, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-59', 17000059, 1859, 'r59c19', 2059.79),
    (260, 'r60c3', 460.64, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-60', 9000060, 1060, 'r60c11', 1260.72, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-60', 17000060, 1860, 'r60c19', 2060.80),
    (261, 'r61c3', 461.65, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-61', 9000061, 1061, 'r61c11', 1261.73, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-61', 17000061, 1861, 'r61c19', 2061.81),
    (262, 'r62c3', 462.66, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-62', 9000062, 1062, 'r62c11', 1262.74, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-62', 17000062, 1862, 'r62c19', 2062.82),
    (263, 'r63c3', 463.67, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-63', 9000063, 1063, 'r63c11', 1263.75, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-63', 17000063, 1863, 'r63c19', 2063.83),
    (264, 'r64c3', 464.68, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-64', 9000064, 1064, 'r64c11', 1264.76, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-64', 17000064, 1864, 'r64c19', 2064.84),
    (265, 'r65c3', 465.69, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-65', 9000065, 1065, 'r65c11', 1265.77, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-65', 17000065, 1865, 'r65c19', 2065.85),
    (266, 'r66c3', 466.70, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-66', 9000066, 1066, 'r66c11', 1266.78, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-66', 17000066, 1866, 'r66c19', 2066.86),
    (267, 'r67c3', 467.71, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-67', 9000067, 1067, 'r67c11', 1267.79, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-67', 17000067, 1867, 'r67c19', 2067.87),
    (268, 'r68c3', 468.72, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-68', 9000068, 1068, 'r68c11', 1268.80, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-68', 17000068, 1868, 'r68c19', 2068.88),
    (269, 'r69c3', 469.73, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-69', 9000069, 1069, 'r69c11', 1269.81, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-69', 17000069, 1869, 'r69c19', 2069.89),
    (270, 'r70c3', 470.74, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-70', 9000070, 1070, 'r70c11', 1270.82, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-70', 17000070, 1870, 'r70c19', 2070.90),
    (271, 'r71c3', 471.75, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-71', 9000071, 1071, 'r71c11', 1271.83, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-71', 17000071, 1871, 'r71c19', 2071.91),
    (272, 'r72c3', 472.76, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-72', 9000072, 1072, 'r72c11', 1272.84, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-72', 17000072, 1872, 'r72c19', 2072.92),
    (273, 'r73c3', 473.77, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-73', 9000073, 1073, 'r73c11', 1273.85, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-73', 17000073, 1873, 'r73c19', 2073.93),
    (274, 'r74c3', 474.78, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-74', 9000074, 1074, 'r74c11', 1274.86, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-74', 17000074, 1874, 'r74c19', 2074.94),
    (275, 'r75c3', 475.79, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-75', 9000075, 1075, 'r75c11', 1275.87, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-75', 17000075, 1875, 'r75c19', 2075.95),
    (276, 'r76c3', 476.80, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-76', 9000076, 1076, 'r76c11', 1276.88, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-76', 17000076, 1876, 'r76c19', 2076.96),
    (277, 'r77c3', 477.81, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-77', 9000077, 1077, 'r77c11', 1277.89, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-77', 17000077, 1877, 'r77c19', 2077.97),
    (278, 'r78c3', 478.82, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-78', 9000078, 1078, 'r78c11', 1278.90, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-78', 17000078, 1878, 'r78c19', 2078.98),
    (279, 'r79c3', 479.83, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-79', 9000079, 1079, 'r79c11', 1279.91, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-79', 17000079, 1879, 'r79c19', 2079.99),
    (280, 'r80c3', 480.84, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-80', 9000080, 1080, 'r80c11', 1280.92, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-80', 17000080, 1880, 'r80c19', 2080.00),
    (281, 'r81c3', 481.85, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-81', 9000081, 1081, 'r81c11', 1281.93, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-81', 17000081, 1881, 'r81c19', 2081.01),
    (282, 'r82c3', 482.86, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-82', 9000082, 1082, 'r82c11', 1282.94, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-82', 17000082, 1882, 'r82c19', 2082.02),
    (283, 'r83c3', 483.87, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-83', 9000083, 1083, 'r83c11', 1283.95, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-83', 17000083, 1883, 'r83c19', 2083.03),
    (284, 'r84c3', 484.88, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-84', 9000084, 1084, 'r84c11', 1284.96, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-84', 17000084, 1884, 'r84c19', 2084.04),
    (285, 'r85c3', 485.89, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-85', 9000085, 1085, 'r85c11', 1285.97, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-85', 17000085, 1885, 'r85c19', 2085.05),
    (286, 'r86c3', 486.90, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-86', 9000086, 1086, 'r86c11', 1286.98, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-86', 17000086, 1886, 'r86c19', 2086.06),
    (287, 'r87c3', 487.91, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-87', 9000087, 1087, 'r87c11', 1287.99, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-87', 17000087, 1887, 'r87c19', 2087.07),
    (288, 'r88c3', 488.92, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-88', 9000088, 1088, 'r88c11', 1288.00, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-88', 17000088, 1888, 'r88c19', 2088.08),
    (289, 'r89c3', 489.93, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-89', 9000089, 1089, 'r89c11', 1289.01, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-89', 17000089, 1889, 'r89c19', 2089.09),
    (290, 'r90c3', 490.94, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-90', 9000090, 1090, 'r90c11', 1290.02, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-90', 17000090, 1890, 'r90c19', 2090.10),
    (291, 'r91c3', 491.95, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-91', 9000091, 1091, 'r91c11', 1291.03, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-91', 17000091, 1891, 'r91c19', 2091.11),
    (292, 'r92c3', 492.96, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-92', 9000092, 1092, 'r92c11', 1292.04, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-92', 17000092, 1892, 'r92c19', 2092.12),
    (293, 'r93c3', 493.97, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-93', 9000093, 1093, 'r93c11', 1293.05, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-93', 17000093, 1893, 'r93c19', 2093.13),
    (294, 'r94c3', 494.98, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-94', 9000094, 1094, 'r94c11', 1294.06, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-94', 17000094, 1894, 'r94c19', 2094.14),
    (295, 'r95c3', 495.99, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-95', 9000095, 1095, 'r95c11', 1295.07, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-95', 17000095, 1895, 'r95c19', 2095.15),
    (296, 'r96c3', 496.00, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-96', 9000096, 1096, 'r96c11', 1296.08, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-96', 17000096, 1896, 'r96c19', 2096.16),
    (297, 'r97c3', 497.01, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-97', 9000097, 1097, 'r97c11', 1297.09, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-97', 17000097, 1897, 'r97c19', 2097.17),
    (298, 'r98c3', 498.02, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-98', 9000098, 1098, 'r98c11', 1298.10, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-98', 17000098, 1898, 'r98c19', 2098.18),
    (299, 'r99c3', 499.03, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-99', 9000099, 1099, 'r99c11', 1299.11, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-99', 17000099, 1899, 'r99c19', 2099.19),
    (300, 'r100c3', 4100.04, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-100', 9000100, 1100, 'r100c11', 12100.12, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-100', 17000100, 1900, 'r100c19', 20100.20),
    (301, 'r101c3', 4101.05, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-101', 9000101, 1101, 'r101c11', 12101.13, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-101', 17000101, 1901, 'r101c19', 20101.21),
    (302, 'r102c3', 4102.06, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-102', 9000102, 1102, 'r102c11', 12102.14, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-102', 17000102, 1902, 'r102c19', 20102.22),
    (303, 'r103c3', 4103.07, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-103', 9000103, 1103, 'r103c11', 12103.15, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-103', 17000103, 1903, 'r103c19', 20103.23),
    (304, 'r104c3', 4104.08, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-104', 9000104, 1104, 'r104c11', 12104.16, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-104', 17000104, 1904, 'r104c19', 20104.24),
    (305, 'r105c3', 4105.09, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-105', 9000105, 1105, 'r105c11', 12105.17, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-105', 17000105, 1905, 'r105c19', 20105.25),
    (306, 'r106c3', 4106.10, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-106', 9000106, 1106, 'r106c11', 12106.18, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-106', 17000106, 1906, 'r106c19', 20106.26),
    (307, 'r107c3', 4107.11, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-107', 9000107, 1107, 'r107c11', 12107.19, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-107', 17000107, 1907, 'r107c19', 20107.27),
    (308, 'r108c3', 4108.12, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-108', 9000108, 1108, 'r108c11', 12108.20, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-108', 17000108, 1908, 'r108c19', 20108.28),
    (309, 'r109c3', 4109.13, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-109', 9000109, 1109, 'r109c11', 12109.21, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-109', 17000109, 1909, 'r109c19', 20109.29),
    (310, 'r110c3', 4110.14, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-110', 9000110, 1110, 'r110c11', 12110.22, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-110', 17000110, 1910, 'r110c19', 20110.30),
    (311, 'r111c3', 4111.15, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-111', 9000111, 1111, 'r111c11', 12111.23, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-111', 17000111, 1911, 'r111c19', 20111.31),
    (312, 'r112c3', 4112.16, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-112', 9000112, 1112, 'r112c11', 12112.24, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-112', 17000112, 1912, 'r112c19', 20112.32),
    (313, 'r113c3', 4113.17, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-113', 9000113, 1113, 'r113c11', 12113.25, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-113', 17000113, 1913, 'r113c19', 20113.33),
    (314, 'r114c3', 4114.18, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-114', 9000114, 1114, 'r114c11', 12114.26, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-114', 17000114, 1914, 'r114c19', 20114.34),
    (315, 'r115c3', 4115.19, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-115', 9000115, 1115, 'r115c11', 12115.27, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-115', 17000115, 1915, 'r115c19', 20115.35),
    (316, 'r116c3', 4116.20, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-116', 9000116, 1116, 'r116c11', 12116.28, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-116', 17000116, 1916, 'r116c19', 20116.36),
    (317, 'r117c3', 4117.21, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-117', 9000117, 1117, 'r117c11', 12117.29, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-117', 17000117, 1917, 'r117c19', 20117.37),
    (318, 'r118c3', 4118.22, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-118', 9000118, 1118, 'r118c11', 12118.30, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-118', 17000118, 1918, 'r118c19', 20118.38),
    (319, 'r119c3', 4119.23, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-119', 9000119, 1119, 'r119c11', 12119.31, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-119', 17000119, 1919, 'r119c19', 20119.39),
    (320, 'r120c3', 4120.24, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-120', 9000120, 1120, 'r120c11', 12120.32, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-120', 17000120, 1920, 'r120c19', 20120.40);

CREATE TABLE wide.cols_25 (
    id  serial  PRIMARY KEY,
    col_002_int      integer,
    col_003_txt      text,
    col_004_num      numeric(12, 2),
    col_005_flag     boolean,
    col_006_day      date,
    col_007_ts       timestamptz,
    col_008_code     varchar(16),
    col_009_big      bigint,
    col_010_int      integer,
    col_011_txt      text,
    col_012_num      numeric(12, 2),
    col_013_flag     boolean,
    col_014_day      date,
    col_015_ts       timestamptz,
    col_016_code     varchar(16),
    col_017_big      bigint,
    col_018_int      integer,
    col_019_txt      text,
    col_020_num      numeric(12, 2),
    col_021_flag     boolean,
    col_022_day      date,
    col_023_ts       timestamptz,
    col_024_code     varchar(16),
    col_025_big      bigint
);

INSERT INTO wide.cols_25 (col_002_int, col_003_txt, col_004_num, col_005_flag, col_006_day, col_007_ts, col_008_code, col_009_big, col_010_int, col_011_txt, col_012_num, col_013_flag, col_014_day, col_015_ts, col_016_code, col_017_big, col_018_int, col_019_txt, col_020_num, col_021_flag, col_022_day, col_023_ts, col_024_code, col_025_big) VALUES
    (201, 'r1c3', 41.05, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-1', 9000001, 1001, 'r1c11', 121.13, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-1', 17000001, 1801, 'r1c19', 201.21, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-1', 25000001),
    (202, 'r2c3', 42.06, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-2', 9000002, 1002, 'r2c11', 122.14, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-2', 17000002, 1802, 'r2c19', 202.22, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-2', 25000002),
    (203, 'r3c3', 43.07, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-3', 9000003, 1003, 'r3c11', 123.15, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-3', 17000003, 1803, 'r3c19', 203.23, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-3', 25000003),
    (204, 'r4c3', 44.08, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-4', 9000004, 1004, 'r4c11', 124.16, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-4', 17000004, 1804, 'r4c19', 204.24, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-4', 25000004),
    (205, 'r5c3', 45.09, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-5', 9000005, 1005, 'r5c11', 125.17, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-5', 17000005, 1805, 'r5c19', 205.25, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-5', 25000005),
    (206, 'r6c3', 46.10, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-6', 9000006, 1006, 'r6c11', 126.18, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-6', 17000006, 1806, 'r6c19', 206.26, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-6', 25000006),
    (207, 'r7c3', 47.11, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-7', 9000007, 1007, 'r7c11', 127.19, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-7', 17000007, 1807, 'r7c19', 207.27, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-7', 25000007),
    (208, 'r8c3', 48.12, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-8', 9000008, 1008, 'r8c11', 128.20, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-8', 17000008, 1808, 'r8c19', 208.28, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-8', 25000008),
    (209, 'r9c3', 49.13, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-9', 9000009, 1009, 'r9c11', 129.21, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-9', 17000009, 1809, 'r9c19', 209.29, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-9', 25000009),
    (210, 'r10c3', 410.14, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-10', 9000010, 1010, 'r10c11', 1210.22, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-10', 17000010, 1810, 'r10c19', 2010.30, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-10', 25000010),
    (211, 'r11c3', 411.15, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-11', 9000011, 1011, 'r11c11', 1211.23, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-11', 17000011, 1811, 'r11c19', 2011.31, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-11', 25000011),
    (212, 'r12c3', 412.16, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-12', 9000012, 1012, 'r12c11', 1212.24, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-12', 17000012, 1812, 'r12c19', 2012.32, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-12', 25000012),
    (213, 'r13c3', 413.17, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-13', 9000013, 1013, 'r13c11', 1213.25, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-13', 17000013, 1813, 'r13c19', 2013.33, true, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-13', 25000013),
    (214, 'r14c3', 414.18, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-14', 9000014, 1014, 'r14c11', 1214.26, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-14', 17000014, 1814, 'r14c19', 2014.34, false, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-14', 25000014),
    (215, 'r15c3', 415.19, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-15', 9000015, 1015, 'r15c11', 1215.27, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-15', 17000015, 1815, 'r15c19', 2015.35, true, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-15', 25000015),
    (216, 'r16c3', 416.20, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-16', 9000016, 1016, 'r16c11', 1216.28, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-16', 17000016, 1816, 'r16c19', 2016.36, false, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-16', 25000016),
    (217, 'r17c3', 417.21, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-17', 9000017, 1017, 'r17c11', 1217.29, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-17', 17000017, 1817, 'r17c19', 2017.37, true, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-17', 25000017),
    (218, 'r18c3', 418.22, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-18', 9000018, 1018, 'r18c11', 1218.30, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-18', 17000018, 1818, 'r18c19', 2018.38, false, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-18', 25000018),
    (219, 'r19c3', 419.23, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-19', 9000019, 1019, 'r19c11', 1219.31, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-19', 17000019, 1819, 'r19c19', 2019.39, true, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-19', 25000019),
    (220, 'r20c3', 420.24, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-20', 9000020, 1020, 'r20c11', 1220.32, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-20', 17000020, 1820, 'r20c19', 2020.40, false, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-20', 25000020),
    (221, 'r21c3', 421.25, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-21', 9000021, 1021, 'r21c11', 1221.33, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-21', 17000021, 1821, 'r21c19', 2021.41, true, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-21', 25000021),
    (222, 'r22c3', 422.26, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-22', 9000022, 1022, 'r22c11', 1222.34, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-22', 17000022, 1822, 'r22c19', 2022.42, false, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-22', 25000022),
    (223, 'r23c3', 423.27, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-23', 9000023, 1023, 'r23c11', 1223.35, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-23', 17000023, 1823, 'r23c19', 2023.43, true, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-23', 25000023),
    (224, 'r24c3', 424.28, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-24', 9000024, 1024, 'r24c11', 1224.36, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-24', 17000024, 1824, 'r24c19', 2024.44, false, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-24', 25000024),
    (225, 'r25c3', 425.29, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-25', 9000025, 1025, 'r25c11', 1225.37, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-25', 17000025, 1825, 'r25c19', 2025.45, true, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-25', 25000025),
    (226, 'r26c3', 426.30, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-26', 9000026, 1026, 'r26c11', 1226.38, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-26', 17000026, 1826, 'r26c19', 2026.46, false, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-26', 25000026),
    (227, 'r27c3', 427.31, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-27', 9000027, 1027, 'r27c11', 1227.39, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-27', 17000027, 1827, 'r27c19', 2027.47, true, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-27', 25000027),
    (228, 'r28c3', 428.32, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-28', 9000028, 1028, 'r28c11', 1228.40, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-28', 17000028, 1828, 'r28c19', 2028.48, false, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-28', 25000028),
    (229, 'r29c3', 429.33, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-29', 9000029, 1029, 'r29c11', 1229.41, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-29', 17000029, 1829, 'r29c19', 2029.49, true, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-29', 25000029),
    (230, 'r30c3', 430.34, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-30', 9000030, 1030, 'r30c11', 1230.42, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-30', 17000030, 1830, 'r30c19', 2030.50, false, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-30', 25000030),
    (231, 'r31c3', 431.35, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-31', 9000031, 1031, 'r31c11', 1231.43, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-31', 17000031, 1831, 'r31c19', 2031.51, true, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-31', 25000031),
    (232, 'r32c3', 432.36, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-32', 9000032, 1032, 'r32c11', 1232.44, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-32', 17000032, 1832, 'r32c19', 2032.52, false, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-32', 25000032),
    (233, 'r33c3', 433.37, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-33', 9000033, 1033, 'r33c11', 1233.45, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-33', 17000033, 1833, 'r33c19', 2033.53, true, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-33', 25000033),
    (234, 'r34c3', 434.38, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-34', 9000034, 1034, 'r34c11', 1234.46, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-34', 17000034, 1834, 'r34c19', 2034.54, false, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-34', 25000034),
    (235, 'r35c3', 435.39, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-35', 9000035, 1035, 'r35c11', 1235.47, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-35', 17000035, 1835, 'r35c19', 2035.55, true, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-35', 25000035),
    (236, 'r36c3', 436.40, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-36', 9000036, 1036, 'r36c11', 1236.48, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-36', 17000036, 1836, 'r36c19', 2036.56, false, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-36', 25000036),
    (237, 'r37c3', 437.41, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-37', 9000037, 1037, 'r37c11', 1237.49, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-37', 17000037, 1837, 'r37c19', 2037.57, true, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-37', 25000037),
    (238, 'r38c3', 438.42, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-38', 9000038, 1038, 'r38c11', 1238.50, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-38', 17000038, 1838, 'r38c19', 2038.58, false, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-38', 25000038),
    (239, 'r39c3', 439.43, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-39', 9000039, 1039, 'r39c11', 1239.51, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-39', 17000039, 1839, 'r39c19', 2039.59, true, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-39', 25000039),
    (240, 'r40c3', 440.44, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-40', 9000040, 1040, 'r40c11', 1240.52, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-40', 17000040, 1840, 'r40c19', 2040.60, false, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-40', 25000040),
    (241, 'r41c3', 441.45, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-41', 9000041, 1041, 'r41c11', 1241.53, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-41', 17000041, 1841, 'r41c19', 2041.61, true, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-41', 25000041),
    (242, 'r42c3', 442.46, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-42', 9000042, 1042, 'r42c11', 1242.54, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-42', 17000042, 1842, 'r42c19', 2042.62, false, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-42', 25000042),
    (243, 'r43c3', 443.47, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-43', 9000043, 1043, 'r43c11', 1243.55, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-43', 17000043, 1843, 'r43c19', 2043.63, true, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-43', 25000043),
    (244, 'r44c3', 444.48, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-44', 9000044, 1044, 'r44c11', 1244.56, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-44', 17000044, 1844, 'r44c19', 2044.64, false, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-44', 25000044),
    (245, 'r45c3', 445.49, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-45', 9000045, 1045, 'r45c11', 1245.57, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-45', 17000045, 1845, 'r45c19', 2045.65, true, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-45', 25000045),
    (246, 'r46c3', 446.50, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-46', 9000046, 1046, 'r46c11', 1246.58, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-46', 17000046, 1846, 'r46c19', 2046.66, false, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-46', 25000046),
    (247, 'r47c3', 447.51, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-47', 9000047, 1047, 'r47c11', 1247.59, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-47', 17000047, 1847, 'r47c19', 2047.67, true, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-47', 25000047),
    (248, 'r48c3', 448.52, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-48', 9000048, 1048, 'r48c11', 1248.60, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-48', 17000048, 1848, 'r48c19', 2048.68, false, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-48', 25000048),
    (249, 'r49c3', 449.53, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-49', 9000049, 1049, 'r49c11', 1249.61, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-49', 17000049, 1849, 'r49c19', 2049.69, true, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-49', 25000049),
    (250, 'r50c3', 450.54, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-50', 9000050, 1050, 'r50c11', 1250.62, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-50', 17000050, 1850, 'r50c19', 2050.70, false, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-50', 25000050),
    (251, 'r51c3', 451.55, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-51', 9000051, 1051, 'r51c11', 1251.63, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-51', 17000051, 1851, 'r51c19', 2051.71, true, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-51', 25000051),
    (252, 'r52c3', 452.56, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-52', 9000052, 1052, 'r52c11', 1252.64, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-52', 17000052, 1852, 'r52c19', 2052.72, false, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-52', 25000052),
    (253, 'r53c3', 453.57, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-53', 9000053, 1053, 'r53c11', 1253.65, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-53', 17000053, 1853, 'r53c19', 2053.73, true, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-53', 25000053),
    (254, 'r54c3', 454.58, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-54', 9000054, 1054, 'r54c11', 1254.66, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-54', 17000054, 1854, 'r54c19', 2054.74, false, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-54', 25000054),
    (255, 'r55c3', 455.59, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-55', 9000055, 1055, 'r55c11', 1255.67, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-55', 17000055, 1855, 'r55c19', 2055.75, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-55', 25000055),
    (256, 'r56c3', 456.60, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-56', 9000056, 1056, 'r56c11', 1256.68, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-56', 17000056, 1856, 'r56c19', 2056.76, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-56', 25000056),
    (257, 'r57c3', 457.61, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-57', 9000057, 1057, 'r57c11', 1257.69, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-57', 17000057, 1857, 'r57c19', 2057.77, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-57', 25000057),
    (258, 'r58c3', 458.62, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-58', 9000058, 1058, 'r58c11', 1258.70, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-58', 17000058, 1858, 'r58c19', 2058.78, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-58', 25000058),
    (259, 'r59c3', 459.63, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-59', 9000059, 1059, 'r59c11', 1259.71, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-59', 17000059, 1859, 'r59c19', 2059.79, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-59', 25000059),
    (260, 'r60c3', 460.64, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-60', 9000060, 1060, 'r60c11', 1260.72, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-60', 17000060, 1860, 'r60c19', 2060.80, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-60', 25000060),
    (261, 'r61c3', 461.65, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-61', 9000061, 1061, 'r61c11', 1261.73, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-61', 17000061, 1861, 'r61c19', 2061.81, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-61', 25000061),
    (262, 'r62c3', 462.66, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-62', 9000062, 1062, 'r62c11', 1262.74, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-62', 17000062, 1862, 'r62c19', 2062.82, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-62', 25000062),
    (263, 'r63c3', 463.67, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-63', 9000063, 1063, 'r63c11', 1263.75, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-63', 17000063, 1863, 'r63c19', 2063.83, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-63', 25000063),
    (264, 'r64c3', 464.68, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-64', 9000064, 1064, 'r64c11', 1264.76, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-64', 17000064, 1864, 'r64c19', 2064.84, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-64', 25000064),
    (265, 'r65c3', 465.69, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-65', 9000065, 1065, 'r65c11', 1265.77, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-65', 17000065, 1865, 'r65c19', 2065.85, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-65', 25000065),
    (266, 'r66c3', 466.70, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-66', 9000066, 1066, 'r66c11', 1266.78, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-66', 17000066, 1866, 'r66c19', 2066.86, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-66', 25000066),
    (267, 'r67c3', 467.71, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-67', 9000067, 1067, 'r67c11', 1267.79, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-67', 17000067, 1867, 'r67c19', 2067.87, true, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-67', 25000067),
    (268, 'r68c3', 468.72, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-68', 9000068, 1068, 'r68c11', 1268.80, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-68', 17000068, 1868, 'r68c19', 2068.88, false, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-68', 25000068),
    (269, 'r69c3', 469.73, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-69', 9000069, 1069, 'r69c11', 1269.81, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-69', 17000069, 1869, 'r69c19', 2069.89, true, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-69', 25000069),
    (270, 'r70c3', 470.74, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-70', 9000070, 1070, 'r70c11', 1270.82, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-70', 17000070, 1870, 'r70c19', 2070.90, false, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-70', 25000070),
    (271, 'r71c3', 471.75, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-71', 9000071, 1071, 'r71c11', 1271.83, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-71', 17000071, 1871, 'r71c19', 2071.91, true, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-71', 25000071),
    (272, 'r72c3', 472.76, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-72', 9000072, 1072, 'r72c11', 1272.84, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-72', 17000072, 1872, 'r72c19', 2072.92, false, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-72', 25000072),
    (273, 'r73c3', 473.77, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-73', 9000073, 1073, 'r73c11', 1273.85, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-73', 17000073, 1873, 'r73c19', 2073.93, true, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-73', 25000073),
    (274, 'r74c3', 474.78, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-74', 9000074, 1074, 'r74c11', 1274.86, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-74', 17000074, 1874, 'r74c19', 2074.94, false, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-74', 25000074),
    (275, 'r75c3', 475.79, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-75', 9000075, 1075, 'r75c11', 1275.87, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-75', 17000075, 1875, 'r75c19', 2075.95, true, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-75', 25000075),
    (276, 'r76c3', 476.80, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-76', 9000076, 1076, 'r76c11', 1276.88, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-76', 17000076, 1876, 'r76c19', 2076.96, false, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-76', 25000076),
    (277, 'r77c3', 477.81, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-77', 9000077, 1077, 'r77c11', 1277.89, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-77', 17000077, 1877, 'r77c19', 2077.97, true, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-77', 25000077),
    (278, 'r78c3', 478.82, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-78', 9000078, 1078, 'r78c11', 1278.90, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-78', 17000078, 1878, 'r78c19', 2078.98, false, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-78', 25000078),
    (279, 'r79c3', 479.83, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-79', 9000079, 1079, 'r79c11', 1279.91, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-79', 17000079, 1879, 'r79c19', 2079.99, true, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-79', 25000079),
    (280, 'r80c3', 480.84, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-80', 9000080, 1080, 'r80c11', 1280.92, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-80', 17000080, 1880, 'r80c19', 2080.00, false, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-80', 25000080),
    (281, 'r81c3', 481.85, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-81', 9000081, 1081, 'r81c11', 1281.93, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-81', 17000081, 1881, 'r81c19', 2081.01, true, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-81', 25000081),
    (282, 'r82c3', 482.86, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-82', 9000082, 1082, 'r82c11', 1282.94, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-82', 17000082, 1882, 'r82c19', 2082.02, false, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-82', 25000082),
    (283, 'r83c3', 483.87, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-83', 9000083, 1083, 'r83c11', 1283.95, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-83', 17000083, 1883, 'r83c19', 2083.03, true, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-83', 25000083),
    (284, 'r84c3', 484.88, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-84', 9000084, 1084, 'r84c11', 1284.96, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-84', 17000084, 1884, 'r84c19', 2084.04, false, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-84', 25000084),
    (285, 'r85c3', 485.89, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-85', 9000085, 1085, 'r85c11', 1285.97, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-85', 17000085, 1885, 'r85c19', 2085.05, true, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-85', 25000085),
    (286, 'r86c3', 486.90, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-86', 9000086, 1086, 'r86c11', 1286.98, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-86', 17000086, 1886, 'r86c19', 2086.06, false, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-86', 25000086),
    (287, 'r87c3', 487.91, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-87', 9000087, 1087, 'r87c11', 1287.99, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-87', 17000087, 1887, 'r87c19', 2087.07, true, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-87', 25000087),
    (288, 'r88c3', 488.92, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-88', 9000088, 1088, 'r88c11', 1288.00, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-88', 17000088, 1888, 'r88c19', 2088.08, false, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-88', 25000088),
    (289, 'r89c3', 489.93, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-89', 9000089, 1089, 'r89c11', 1289.01, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-89', 17000089, 1889, 'r89c19', 2089.09, true, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-89', 25000089),
    (290, 'r90c3', 490.94, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-90', 9000090, 1090, 'r90c11', 1290.02, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-90', 17000090, 1890, 'r90c19', 2090.10, false, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-90', 25000090),
    (291, 'r91c3', 491.95, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-91', 9000091, 1091, 'r91c11', 1291.03, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-91', 17000091, 1891, 'r91c19', 2091.11, true, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-91', 25000091),
    (292, 'r92c3', 492.96, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-92', 9000092, 1092, 'r92c11', 1292.04, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-92', 17000092, 1892, 'r92c19', 2092.12, false, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-92', 25000092),
    (293, 'r93c3', 493.97, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-93', 9000093, 1093, 'r93c11', 1293.05, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-93', 17000093, 1893, 'r93c19', 2093.13, true, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-93', 25000093),
    (294, 'r94c3', 494.98, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-94', 9000094, 1094, 'r94c11', 1294.06, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-94', 17000094, 1894, 'r94c19', 2094.14, false, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-94', 25000094),
    (295, 'r95c3', 495.99, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-95', 9000095, 1095, 'r95c11', 1295.07, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-95', 17000095, 1895, 'r95c19', 2095.15, true, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-95', 25000095),
    (296, 'r96c3', 496.00, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-96', 9000096, 1096, 'r96c11', 1296.08, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-96', 17000096, 1896, 'r96c19', 2096.16, false, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-96', 25000096),
    (297, 'r97c3', 497.01, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-97', 9000097, 1097, 'r97c11', 1297.09, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-97', 17000097, 1897, 'r97c19', 2097.17, true, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-97', 25000097),
    (298, 'r98c3', 498.02, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-98', 9000098, 1098, 'r98c11', 1298.10, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-98', 17000098, 1898, 'r98c19', 2098.18, false, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-98', 25000098),
    (299, 'r99c3', 499.03, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-99', 9000099, 1099, 'r99c11', 1299.11, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-99', 17000099, 1899, 'r99c19', 2099.19, true, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-99', 25000099),
    (300, 'r100c3', 4100.04, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-100', 9000100, 1100, 'r100c11', 12100.12, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-100', 17000100, 1900, 'r100c19', 20100.20, false, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-100', 25000100),
    (301, 'r101c3', 4101.05, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-101', 9000101, 1101, 'r101c11', 12101.13, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-101', 17000101, 1901, 'r101c19', 20101.21, true, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-101', 25000101),
    (302, 'r102c3', 4102.06, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-102', 9000102, 1102, 'r102c11', 12102.14, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-102', 17000102, 1902, 'r102c19', 20102.22, false, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-102', 25000102),
    (303, 'r103c3', 4103.07, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-103', 9000103, 1103, 'r103c11', 12103.15, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-103', 17000103, 1903, 'r103c19', 20103.23, true, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-103', 25000103),
    (304, 'r104c3', 4104.08, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-104', 9000104, 1104, 'r104c11', 12104.16, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-104', 17000104, 1904, 'r104c19', 20104.24, false, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-104', 25000104),
    (305, 'r105c3', 4105.09, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-105', 9000105, 1105, 'r105c11', 12105.17, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-105', 17000105, 1905, 'r105c19', 20105.25, true, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-105', 25000105),
    (306, 'r106c3', 4106.10, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-106', 9000106, 1106, 'r106c11', 12106.18, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-106', 17000106, 1906, 'r106c19', 20106.26, false, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-106', 25000106),
    (307, 'r107c3', 4107.11, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-107', 9000107, 1107, 'r107c11', 12107.19, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-107', 17000107, 1907, 'r107c19', 20107.27, true, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-107', 25000107),
    (308, 'r108c3', 4108.12, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-108', 9000108, 1108, 'r108c11', 12108.20, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-108', 17000108, 1908, 'r108c19', 20108.28, false, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-108', 25000108),
    (309, 'r109c3', 4109.13, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-109', 9000109, 1109, 'r109c11', 12109.21, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-109', 17000109, 1909, 'r109c19', 20109.29, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-109', 25000109),
    (310, 'r110c3', 4110.14, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-110', 9000110, 1110, 'r110c11', 12110.22, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-110', 17000110, 1910, 'r110c19', 20110.30, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-110', 25000110),
    (311, 'r111c3', 4111.15, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-111', 9000111, 1111, 'r111c11', 12111.23, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-111', 17000111, 1911, 'r111c19', 20111.31, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-111', 25000111),
    (312, 'r112c3', 4112.16, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-112', 9000112, 1112, 'r112c11', 12112.24, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-112', 17000112, 1912, 'r112c19', 20112.32, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-112', 25000112),
    (313, 'r113c3', 4113.17, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-113', 9000113, 1113, 'r113c11', 12113.25, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-113', 17000113, 1913, 'r113c19', 20113.33, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-113', 25000113),
    (314, 'r114c3', 4114.18, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-114', 9000114, 1114, 'r114c11', 12114.26, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-114', 17000114, 1914, 'r114c19', 20114.34, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-114', 25000114),
    (315, 'r115c3', 4115.19, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-115', 9000115, 1115, 'r115c11', 12115.27, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-115', 17000115, 1915, 'r115c19', 20115.35, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-115', 25000115),
    (316, 'r116c3', 4116.20, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-116', 9000116, 1116, 'r116c11', 12116.28, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-116', 17000116, 1916, 'r116c19', 20116.36, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-116', 25000116),
    (317, 'r117c3', 4117.21, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-117', 9000117, 1117, 'r117c11', 12117.29, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-117', 17000117, 1917, 'r117c19', 20117.37, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-117', 25000117),
    (318, 'r118c3', 4118.22, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-118', 9000118, 1118, 'r118c11', 12118.30, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-118', 17000118, 1918, 'r118c19', 20118.38, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-118', 25000118),
    (319, 'r119c3', 4119.23, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-119', 9000119, 1119, 'r119c11', 12119.31, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-119', 17000119, 1919, 'r119c19', 20119.39, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-119', 25000119),
    (320, 'r120c3', 4120.24, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-120', 9000120, 1120, 'r120c11', 12120.32, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-120', 17000120, 1920, 'r120c19', 20120.40, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-120', 25000120);

CREATE TABLE wide.cols_30 (
    id  serial  PRIMARY KEY,
    col_002_int      integer,
    col_003_txt      text,
    col_004_num      numeric(12, 2),
    col_005_flag     boolean,
    col_006_day      date,
    col_007_ts       timestamptz,
    col_008_code     varchar(16),
    col_009_big      bigint,
    col_010_int      integer,
    col_011_txt      text,
    col_012_num      numeric(12, 2),
    col_013_flag     boolean,
    col_014_day      date,
    col_015_ts       timestamptz,
    col_016_code     varchar(16),
    col_017_big      bigint,
    col_018_int      integer,
    col_019_txt      text,
    col_020_num      numeric(12, 2),
    col_021_flag     boolean,
    col_022_day      date,
    col_023_ts       timestamptz,
    col_024_code     varchar(16),
    col_025_big      bigint,
    col_026_int      integer,
    col_027_txt      text,
    col_028_num      numeric(12, 2),
    col_029_flag     boolean,
    col_030_day      date
);

INSERT INTO wide.cols_30 (col_002_int, col_003_txt, col_004_num, col_005_flag, col_006_day, col_007_ts, col_008_code, col_009_big, col_010_int, col_011_txt, col_012_num, col_013_flag, col_014_day, col_015_ts, col_016_code, col_017_big, col_018_int, col_019_txt, col_020_num, col_021_flag, col_022_day, col_023_ts, col_024_code, col_025_big, col_026_int, col_027_txt, col_028_num, col_029_flag, col_030_day) VALUES
    (201, 'r1c3', 41.05, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-1', 9000001, 1001, 'r1c11', 121.13, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-1', 17000001, 1801, 'r1c19', 201.21, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-1', 25000001, 2601, 'r1c27', 281.29, true, '2026-07-02'),
    (202, 'r2c3', 42.06, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-2', 9000002, 1002, 'r2c11', 122.14, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-2', 17000002, 1802, 'r2c19', 202.22, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-2', 25000002, 2602, 'r2c27', 282.30, false, '2026-07-03'),
    (203, 'r3c3', 43.07, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-3', 9000003, 1003, 'r3c11', 123.15, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-3', 17000003, 1803, 'r3c19', 203.23, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-3', 25000003, 2603, 'r3c27', 283.31, true, '2026-07-04'),
    (204, 'r4c3', 44.08, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-4', 9000004, 1004, 'r4c11', 124.16, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-4', 17000004, 1804, 'r4c19', 204.24, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-4', 25000004, 2604, 'r4c27', 284.32, false, '2026-07-05'),
    (205, 'r5c3', 45.09, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-5', 9000005, 1005, 'r5c11', 125.17, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-5', 17000005, 1805, 'r5c19', 205.25, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-5', 25000005, 2605, 'r5c27', 285.33, true, '2026-07-06'),
    (206, 'r6c3', 46.10, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-6', 9000006, 1006, 'r6c11', 126.18, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-6', 17000006, 1806, 'r6c19', 206.26, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-6', 25000006, 2606, 'r6c27', 286.34, false, '2026-07-07'),
    (207, 'r7c3', 47.11, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-7', 9000007, 1007, 'r7c11', 127.19, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-7', 17000007, 1807, 'r7c19', 207.27, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-7', 25000007, 2607, 'r7c27', 287.35, true, '2026-07-08'),
    (208, 'r8c3', 48.12, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-8', 9000008, 1008, 'r8c11', 128.20, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-8', 17000008, 1808, 'r8c19', 208.28, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-8', 25000008, 2608, 'r8c27', 288.36, false, '2026-07-09'),
    (209, 'r9c3', 49.13, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-9', 9000009, 1009, 'r9c11', 129.21, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-9', 17000009, 1809, 'r9c19', 209.29, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-9', 25000009, 2609, 'r9c27', 289.37, true, '2026-07-10'),
    (210, 'r10c3', 410.14, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-10', 9000010, 1010, 'r10c11', 1210.22, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-10', 17000010, 1810, 'r10c19', 2010.30, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-10', 25000010, 2610, 'r10c27', 2810.38, false, '2026-07-11'),
    (211, 'r11c3', 411.15, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-11', 9000011, 1011, 'r11c11', 1211.23, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-11', 17000011, 1811, 'r11c19', 2011.31, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-11', 25000011, 2611, 'r11c27', 2811.39, true, '2026-07-12'),
    (212, 'r12c3', 412.16, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-12', 9000012, 1012, 'r12c11', 1212.24, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-12', 17000012, 1812, 'r12c19', 2012.32, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-12', 25000012, 2612, 'r12c27', 2812.40, false, '2026-07-13'),
    (213, 'r13c3', 413.17, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-13', 9000013, 1013, 'r13c11', 1213.25, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-13', 17000013, 1813, 'r13c19', 2013.33, true, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-13', 25000013, 2613, 'r13c27', 2813.41, true, '2026-07-14'),
    (214, 'r14c3', 414.18, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-14', 9000014, 1014, 'r14c11', 1214.26, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-14', 17000014, 1814, 'r14c19', 2014.34, false, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-14', 25000014, 2614, 'r14c27', 2814.42, false, '2026-07-15'),
    (215, 'r15c3', 415.19, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-15', 9000015, 1015, 'r15c11', 1215.27, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-15', 17000015, 1815, 'r15c19', 2015.35, true, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-15', 25000015, 2615, 'r15c27', 2815.43, true, '2026-07-16'),
    (216, 'r16c3', 416.20, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-16', 9000016, 1016, 'r16c11', 1216.28, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-16', 17000016, 1816, 'r16c19', 2016.36, false, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-16', 25000016, 2616, 'r16c27', 2816.44, false, '2026-07-17'),
    (217, 'r17c3', 417.21, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-17', 9000017, 1017, 'r17c11', 1217.29, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-17', 17000017, 1817, 'r17c19', 2017.37, true, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-17', 25000017, 2617, 'r17c27', 2817.45, true, '2026-07-18'),
    (218, 'r18c3', 418.22, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-18', 9000018, 1018, 'r18c11', 1218.30, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-18', 17000018, 1818, 'r18c19', 2018.38, false, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-18', 25000018, 2618, 'r18c27', 2818.46, false, '2026-07-19'),
    (219, 'r19c3', 419.23, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-19', 9000019, 1019, 'r19c11', 1219.31, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-19', 17000019, 1819, 'r19c19', 2019.39, true, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-19', 25000019, 2619, 'r19c27', 2819.47, true, '2026-07-20'),
    (220, 'r20c3', 420.24, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-20', 9000020, 1020, 'r20c11', 1220.32, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-20', 17000020, 1820, 'r20c19', 2020.40, false, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-20', 25000020, 2620, 'r20c27', 2820.48, false, '2026-07-21'),
    (221, 'r21c3', 421.25, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-21', 9000021, 1021, 'r21c11', 1221.33, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-21', 17000021, 1821, 'r21c19', 2021.41, true, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-21', 25000021, 2621, 'r21c27', 2821.49, true, '2026-07-22'),
    (222, 'r22c3', 422.26, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-22', 9000022, 1022, 'r22c11', 1222.34, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-22', 17000022, 1822, 'r22c19', 2022.42, false, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-22', 25000022, 2622, 'r22c27', 2822.50, false, '2026-07-23'),
    (223, 'r23c3', 423.27, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-23', 9000023, 1023, 'r23c11', 1223.35, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-23', 17000023, 1823, 'r23c19', 2023.43, true, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-23', 25000023, 2623, 'r23c27', 2823.51, true, '2026-07-24'),
    (224, 'r24c3', 424.28, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-24', 9000024, 1024, 'r24c11', 1224.36, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-24', 17000024, 1824, 'r24c19', 2024.44, false, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-24', 25000024, 2624, 'r24c27', 2824.52, false, '2026-07-25'),
    (225, 'r25c3', 425.29, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-25', 9000025, 1025, 'r25c11', 1225.37, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-25', 17000025, 1825, 'r25c19', 2025.45, true, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-25', 25000025, 2625, 'r25c27', 2825.53, true, '2026-07-26'),
    (226, 'r26c3', 426.30, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-26', 9000026, 1026, 'r26c11', 1226.38, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-26', 17000026, 1826, 'r26c19', 2026.46, false, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-26', 25000026, 2626, 'r26c27', 2826.54, false, '2026-07-27'),
    (227, 'r27c3', 427.31, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-27', 9000027, 1027, 'r27c11', 1227.39, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-27', 17000027, 1827, 'r27c19', 2027.47, true, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-27', 25000027, 2627, 'r27c27', 2827.55, true, '2026-07-01'),
    (228, 'r28c3', 428.32, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-28', 9000028, 1028, 'r28c11', 1228.40, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-28', 17000028, 1828, 'r28c19', 2028.48, false, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-28', 25000028, 2628, 'r28c27', 2828.56, false, '2026-07-02'),
    (229, 'r29c3', 429.33, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-29', 9000029, 1029, 'r29c11', 1229.41, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-29', 17000029, 1829, 'r29c19', 2029.49, true, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-29', 25000029, 2629, 'r29c27', 2829.57, true, '2026-07-03'),
    (230, 'r30c3', 430.34, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-30', 9000030, 1030, 'r30c11', 1230.42, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-30', 17000030, 1830, 'r30c19', 2030.50, false, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-30', 25000030, 2630, 'r30c27', 2830.58, false, '2026-07-04'),
    (231, 'r31c3', 431.35, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-31', 9000031, 1031, 'r31c11', 1231.43, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-31', 17000031, 1831, 'r31c19', 2031.51, true, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-31', 25000031, 2631, 'r31c27', 2831.59, true, '2026-07-05'),
    (232, 'r32c3', 432.36, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-32', 9000032, 1032, 'r32c11', 1232.44, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-32', 17000032, 1832, 'r32c19', 2032.52, false, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-32', 25000032, 2632, 'r32c27', 2832.60, false, '2026-07-06'),
    (233, 'r33c3', 433.37, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-33', 9000033, 1033, 'r33c11', 1233.45, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-33', 17000033, 1833, 'r33c19', 2033.53, true, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-33', 25000033, 2633, 'r33c27', 2833.61, true, '2026-07-07'),
    (234, 'r34c3', 434.38, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-34', 9000034, 1034, 'r34c11', 1234.46, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-34', 17000034, 1834, 'r34c19', 2034.54, false, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-34', 25000034, 2634, 'r34c27', 2834.62, false, '2026-07-08'),
    (235, 'r35c3', 435.39, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-35', 9000035, 1035, 'r35c11', 1235.47, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-35', 17000035, 1835, 'r35c19', 2035.55, true, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-35', 25000035, 2635, 'r35c27', 2835.63, true, '2026-07-09'),
    (236, 'r36c3', 436.40, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-36', 9000036, 1036, 'r36c11', 1236.48, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-36', 17000036, 1836, 'r36c19', 2036.56, false, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-36', 25000036, 2636, 'r36c27', 2836.64, false, '2026-07-10'),
    (237, 'r37c3', 437.41, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-37', 9000037, 1037, 'r37c11', 1237.49, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-37', 17000037, 1837, 'r37c19', 2037.57, true, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-37', 25000037, 2637, 'r37c27', 2837.65, true, '2026-07-11'),
    (238, 'r38c3', 438.42, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-38', 9000038, 1038, 'r38c11', 1238.50, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-38', 17000038, 1838, 'r38c19', 2038.58, false, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-38', 25000038, 2638, 'r38c27', 2838.66, false, '2026-07-12'),
    (239, 'r39c3', 439.43, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-39', 9000039, 1039, 'r39c11', 1239.51, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-39', 17000039, 1839, 'r39c19', 2039.59, true, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-39', 25000039, 2639, 'r39c27', 2839.67, true, '2026-07-13'),
    (240, 'r40c3', 440.44, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-40', 9000040, 1040, 'r40c11', 1240.52, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-40', 17000040, 1840, 'r40c19', 2040.60, false, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-40', 25000040, 2640, 'r40c27', 2840.68, false, '2026-07-14'),
    (241, 'r41c3', 441.45, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-41', 9000041, 1041, 'r41c11', 1241.53, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-41', 17000041, 1841, 'r41c19', 2041.61, true, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-41', 25000041, 2641, 'r41c27', 2841.69, true, '2026-07-15'),
    (242, 'r42c3', 442.46, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-42', 9000042, 1042, 'r42c11', 1242.54, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-42', 17000042, 1842, 'r42c19', 2042.62, false, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-42', 25000042, 2642, 'r42c27', 2842.70, false, '2026-07-16'),
    (243, 'r43c3', 443.47, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-43', 9000043, 1043, 'r43c11', 1243.55, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-43', 17000043, 1843, 'r43c19', 2043.63, true, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-43', 25000043, 2643, 'r43c27', 2843.71, true, '2026-07-17'),
    (244, 'r44c3', 444.48, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-44', 9000044, 1044, 'r44c11', 1244.56, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-44', 17000044, 1844, 'r44c19', 2044.64, false, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-44', 25000044, 2644, 'r44c27', 2844.72, false, '2026-07-18'),
    (245, 'r45c3', 445.49, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-45', 9000045, 1045, 'r45c11', 1245.57, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-45', 17000045, 1845, 'r45c19', 2045.65, true, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-45', 25000045, 2645, 'r45c27', 2845.73, true, '2026-07-19'),
    (246, 'r46c3', 446.50, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-46', 9000046, 1046, 'r46c11', 1246.58, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-46', 17000046, 1846, 'r46c19', 2046.66, false, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-46', 25000046, 2646, 'r46c27', 2846.74, false, '2026-07-20'),
    (247, 'r47c3', 447.51, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-47', 9000047, 1047, 'r47c11', 1247.59, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-47', 17000047, 1847, 'r47c19', 2047.67, true, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-47', 25000047, 2647, 'r47c27', 2847.75, true, '2026-07-21'),
    (248, 'r48c3', 448.52, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-48', 9000048, 1048, 'r48c11', 1248.60, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-48', 17000048, 1848, 'r48c19', 2048.68, false, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-48', 25000048, 2648, 'r48c27', 2848.76, false, '2026-07-22'),
    (249, 'r49c3', 449.53, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-49', 9000049, 1049, 'r49c11', 1249.61, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-49', 17000049, 1849, 'r49c19', 2049.69, true, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-49', 25000049, 2649, 'r49c27', 2849.77, true, '2026-07-23'),
    (250, 'r50c3', 450.54, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-50', 9000050, 1050, 'r50c11', 1250.62, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-50', 17000050, 1850, 'r50c19', 2050.70, false, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-50', 25000050, 2650, 'r50c27', 2850.78, false, '2026-07-24'),
    (251, 'r51c3', 451.55, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-51', 9000051, 1051, 'r51c11', 1251.63, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-51', 17000051, 1851, 'r51c19', 2051.71, true, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-51', 25000051, 2651, 'r51c27', 2851.79, true, '2026-07-25'),
    (252, 'r52c3', 452.56, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-52', 9000052, 1052, 'r52c11', 1252.64, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-52', 17000052, 1852, 'r52c19', 2052.72, false, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-52', 25000052, 2652, 'r52c27', 2852.80, false, '2026-07-26'),
    (253, 'r53c3', 453.57, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-53', 9000053, 1053, 'r53c11', 1253.65, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-53', 17000053, 1853, 'r53c19', 2053.73, true, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-53', 25000053, 2653, 'r53c27', 2853.81, true, '2026-07-27'),
    (254, 'r54c3', 454.58, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-54', 9000054, 1054, 'r54c11', 1254.66, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-54', 17000054, 1854, 'r54c19', 2054.74, false, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-54', 25000054, 2654, 'r54c27', 2854.82, false, '2026-07-01'),
    (255, 'r55c3', 455.59, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-55', 9000055, 1055, 'r55c11', 1255.67, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-55', 17000055, 1855, 'r55c19', 2055.75, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-55', 25000055, 2655, 'r55c27', 2855.83, true, '2026-07-02'),
    (256, 'r56c3', 456.60, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-56', 9000056, 1056, 'r56c11', 1256.68, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-56', 17000056, 1856, 'r56c19', 2056.76, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-56', 25000056, 2656, 'r56c27', 2856.84, false, '2026-07-03'),
    (257, 'r57c3', 457.61, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-57', 9000057, 1057, 'r57c11', 1257.69, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-57', 17000057, 1857, 'r57c19', 2057.77, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-57', 25000057, 2657, 'r57c27', 2857.85, true, '2026-07-04'),
    (258, 'r58c3', 458.62, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-58', 9000058, 1058, 'r58c11', 1258.70, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-58', 17000058, 1858, 'r58c19', 2058.78, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-58', 25000058, 2658, 'r58c27', 2858.86, false, '2026-07-05'),
    (259, 'r59c3', 459.63, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-59', 9000059, 1059, 'r59c11', 1259.71, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-59', 17000059, 1859, 'r59c19', 2059.79, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-59', 25000059, 2659, 'r59c27', 2859.87, true, '2026-07-06'),
    (260, 'r60c3', 460.64, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-60', 9000060, 1060, 'r60c11', 1260.72, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-60', 17000060, 1860, 'r60c19', 2060.80, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-60', 25000060, 2660, 'r60c27', 2860.88, false, '2026-07-07'),
    (261, 'r61c3', 461.65, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-61', 9000061, 1061, 'r61c11', 1261.73, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-61', 17000061, 1861, 'r61c19', 2061.81, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-61', 25000061, 2661, 'r61c27', 2861.89, true, '2026-07-08'),
    (262, 'r62c3', 462.66, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-62', 9000062, 1062, 'r62c11', 1262.74, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-62', 17000062, 1862, 'r62c19', 2062.82, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-62', 25000062, 2662, 'r62c27', 2862.90, false, '2026-07-09'),
    (263, 'r63c3', 463.67, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-63', 9000063, 1063, 'r63c11', 1263.75, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-63', 17000063, 1863, 'r63c19', 2063.83, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-63', 25000063, 2663, 'r63c27', 2863.91, true, '2026-07-10'),
    (264, 'r64c3', 464.68, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-64', 9000064, 1064, 'r64c11', 1264.76, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-64', 17000064, 1864, 'r64c19', 2064.84, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-64', 25000064, 2664, 'r64c27', 2864.92, false, '2026-07-11'),
    (265, 'r65c3', 465.69, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-65', 9000065, 1065, 'r65c11', 1265.77, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-65', 17000065, 1865, 'r65c19', 2065.85, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-65', 25000065, 2665, 'r65c27', 2865.93, true, '2026-07-12'),
    (266, 'r66c3', 466.70, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-66', 9000066, 1066, 'r66c11', 1266.78, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-66', 17000066, 1866, 'r66c19', 2066.86, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-66', 25000066, 2666, 'r66c27', 2866.94, false, '2026-07-13'),
    (267, 'r67c3', 467.71, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-67', 9000067, 1067, 'r67c11', 1267.79, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-67', 17000067, 1867, 'r67c19', 2067.87, true, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-67', 25000067, 2667, 'r67c27', 2867.95, true, '2026-07-14'),
    (268, 'r68c3', 468.72, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-68', 9000068, 1068, 'r68c11', 1268.80, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-68', 17000068, 1868, 'r68c19', 2068.88, false, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-68', 25000068, 2668, 'r68c27', 2868.96, false, '2026-07-15'),
    (269, 'r69c3', 469.73, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-69', 9000069, 1069, 'r69c11', 1269.81, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-69', 17000069, 1869, 'r69c19', 2069.89, true, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-69', 25000069, 2669, 'r69c27', 2869.97, true, '2026-07-16'),
    (270, 'r70c3', 470.74, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-70', 9000070, 1070, 'r70c11', 1270.82, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-70', 17000070, 1870, 'r70c19', 2070.90, false, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-70', 25000070, 2670, 'r70c27', 2870.98, false, '2026-07-17'),
    (271, 'r71c3', 471.75, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-71', 9000071, 1071, 'r71c11', 1271.83, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-71', 17000071, 1871, 'r71c19', 2071.91, true, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-71', 25000071, 2671, 'r71c27', 2871.99, true, '2026-07-18'),
    (272, 'r72c3', 472.76, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-72', 9000072, 1072, 'r72c11', 1272.84, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-72', 17000072, 1872, 'r72c19', 2072.92, false, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-72', 25000072, 2672, 'r72c27', 2872.00, false, '2026-07-19'),
    (273, 'r73c3', 473.77, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-73', 9000073, 1073, 'r73c11', 1273.85, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-73', 17000073, 1873, 'r73c19', 2073.93, true, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-73', 25000073, 2673, 'r73c27', 2873.01, true, '2026-07-20'),
    (274, 'r74c3', 474.78, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-74', 9000074, 1074, 'r74c11', 1274.86, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-74', 17000074, 1874, 'r74c19', 2074.94, false, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-74', 25000074, 2674, 'r74c27', 2874.02, false, '2026-07-21'),
    (275, 'r75c3', 475.79, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-75', 9000075, 1075, 'r75c11', 1275.87, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-75', 17000075, 1875, 'r75c19', 2075.95, true, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-75', 25000075, 2675, 'r75c27', 2875.03, true, '2026-07-22'),
    (276, 'r76c3', 476.80, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-76', 9000076, 1076, 'r76c11', 1276.88, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-76', 17000076, 1876, 'r76c19', 2076.96, false, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-76', 25000076, 2676, 'r76c27', 2876.04, false, '2026-07-23'),
    (277, 'r77c3', 477.81, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-77', 9000077, 1077, 'r77c11', 1277.89, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-77', 17000077, 1877, 'r77c19', 2077.97, true, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-77', 25000077, 2677, 'r77c27', 2877.05, true, '2026-07-24'),
    (278, 'r78c3', 478.82, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-78', 9000078, 1078, 'r78c11', 1278.90, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-78', 17000078, 1878, 'r78c19', 2078.98, false, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-78', 25000078, 2678, 'r78c27', 2878.06, false, '2026-07-25'),
    (279, 'r79c3', 479.83, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-79', 9000079, 1079, 'r79c11', 1279.91, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-79', 17000079, 1879, 'r79c19', 2079.99, true, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-79', 25000079, 2679, 'r79c27', 2879.07, true, '2026-07-26'),
    (280, 'r80c3', 480.84, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-80', 9000080, 1080, 'r80c11', 1280.92, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-80', 17000080, 1880, 'r80c19', 2080.00, false, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-80', 25000080, 2680, 'r80c27', 2880.08, false, '2026-07-27'),
    (281, 'r81c3', 481.85, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-81', 9000081, 1081, 'r81c11', 1281.93, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-81', 17000081, 1881, 'r81c19', 2081.01, true, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-81', 25000081, 2681, 'r81c27', 2881.09, true, '2026-07-01'),
    (282, 'r82c3', 482.86, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-82', 9000082, 1082, 'r82c11', 1282.94, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-82', 17000082, 1882, 'r82c19', 2082.02, false, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-82', 25000082, 2682, 'r82c27', 2882.10, false, '2026-07-02'),
    (283, 'r83c3', 483.87, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-83', 9000083, 1083, 'r83c11', 1283.95, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-83', 17000083, 1883, 'r83c19', 2083.03, true, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-83', 25000083, 2683, 'r83c27', 2883.11, true, '2026-07-03'),
    (284, 'r84c3', 484.88, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-84', 9000084, 1084, 'r84c11', 1284.96, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-84', 17000084, 1884, 'r84c19', 2084.04, false, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-84', 25000084, 2684, 'r84c27', 2884.12, false, '2026-07-04'),
    (285, 'r85c3', 485.89, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-85', 9000085, 1085, 'r85c11', 1285.97, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-85', 17000085, 1885, 'r85c19', 2085.05, true, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-85', 25000085, 2685, 'r85c27', 2885.13, true, '2026-07-05'),
    (286, 'r86c3', 486.90, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-86', 9000086, 1086, 'r86c11', 1286.98, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-86', 17000086, 1886, 'r86c19', 2086.06, false, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-86', 25000086, 2686, 'r86c27', 2886.14, false, '2026-07-06'),
    (287, 'r87c3', 487.91, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-87', 9000087, 1087, 'r87c11', 1287.99, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-87', 17000087, 1887, 'r87c19', 2087.07, true, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-87', 25000087, 2687, 'r87c27', 2887.15, true, '2026-07-07'),
    (288, 'r88c3', 488.92, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-88', 9000088, 1088, 'r88c11', 1288.00, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-88', 17000088, 1888, 'r88c19', 2088.08, false, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-88', 25000088, 2688, 'r88c27', 2888.16, false, '2026-07-08'),
    (289, 'r89c3', 489.93, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-89', 9000089, 1089, 'r89c11', 1289.01, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-89', 17000089, 1889, 'r89c19', 2089.09, true, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-89', 25000089, 2689, 'r89c27', 2889.17, true, '2026-07-09'),
    (290, 'r90c3', 490.94, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-90', 9000090, 1090, 'r90c11', 1290.02, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-90', 17000090, 1890, 'r90c19', 2090.10, false, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-90', 25000090, 2690, 'r90c27', 2890.18, false, '2026-07-10'),
    (291, 'r91c3', 491.95, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-91', 9000091, 1091, 'r91c11', 1291.03, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-91', 17000091, 1891, 'r91c19', 2091.11, true, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-91', 25000091, 2691, 'r91c27', 2891.19, true, '2026-07-11'),
    (292, 'r92c3', 492.96, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-92', 9000092, 1092, 'r92c11', 1292.04, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-92', 17000092, 1892, 'r92c19', 2092.12, false, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-92', 25000092, 2692, 'r92c27', 2892.20, false, '2026-07-12'),
    (293, 'r93c3', 493.97, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-93', 9000093, 1093, 'r93c11', 1293.05, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-93', 17000093, 1893, 'r93c19', 2093.13, true, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-93', 25000093, 2693, 'r93c27', 2893.21, true, '2026-07-13'),
    (294, 'r94c3', 494.98, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-94', 9000094, 1094, 'r94c11', 1294.06, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-94', 17000094, 1894, 'r94c19', 2094.14, false, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-94', 25000094, 2694, 'r94c27', 2894.22, false, '2026-07-14'),
    (295, 'r95c3', 495.99, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-95', 9000095, 1095, 'r95c11', 1295.07, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-95', 17000095, 1895, 'r95c19', 2095.15, true, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-95', 25000095, 2695, 'r95c27', 2895.23, true, '2026-07-15'),
    (296, 'r96c3', 496.00, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-96', 9000096, 1096, 'r96c11', 1296.08, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-96', 17000096, 1896, 'r96c19', 2096.16, false, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-96', 25000096, 2696, 'r96c27', 2896.24, false, '2026-07-16'),
    (297, 'r97c3', 497.01, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-97', 9000097, 1097, 'r97c11', 1297.09, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-97', 17000097, 1897, 'r97c19', 2097.17, true, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-97', 25000097, 2697, 'r97c27', 2897.25, true, '2026-07-17'),
    (298, 'r98c3', 498.02, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-98', 9000098, 1098, 'r98c11', 1298.10, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-98', 17000098, 1898, 'r98c19', 2098.18, false, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-98', 25000098, 2698, 'r98c27', 2898.26, false, '2026-07-18'),
    (299, 'r99c3', 499.03, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-99', 9000099, 1099, 'r99c11', 1299.11, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-99', 17000099, 1899, 'r99c19', 2099.19, true, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-99', 25000099, 2699, 'r99c27', 2899.27, true, '2026-07-19'),
    (300, 'r100c3', 4100.04, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-100', 9000100, 1100, 'r100c11', 12100.12, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-100', 17000100, 1900, 'r100c19', 20100.20, false, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-100', 25000100, 2700, 'r100c27', 28100.28, false, '2026-07-20'),
    (301, 'r101c3', 4101.05, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-101', 9000101, 1101, 'r101c11', 12101.13, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-101', 17000101, 1901, 'r101c19', 20101.21, true, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-101', 25000101, 2701, 'r101c27', 28101.29, true, '2026-07-21'),
    (302, 'r102c3', 4102.06, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-102', 9000102, 1102, 'r102c11', 12102.14, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-102', 17000102, 1902, 'r102c19', 20102.22, false, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-102', 25000102, 2702, 'r102c27', 28102.30, false, '2026-07-22'),
    (303, 'r103c3', 4103.07, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-103', 9000103, 1103, 'r103c11', 12103.15, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-103', 17000103, 1903, 'r103c19', 20103.23, true, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-103', 25000103, 2703, 'r103c27', 28103.31, true, '2026-07-23'),
    (304, 'r104c3', 4104.08, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-104', 9000104, 1104, 'r104c11', 12104.16, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-104', 17000104, 1904, 'r104c19', 20104.24, false, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-104', 25000104, 2704, 'r104c27', 28104.32, false, '2026-07-24'),
    (305, 'r105c3', 4105.09, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-105', 9000105, 1105, 'r105c11', 12105.17, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-105', 17000105, 1905, 'r105c19', 20105.25, true, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-105', 25000105, 2705, 'r105c27', 28105.33, true, '2026-07-25'),
    (306, 'r106c3', 4106.10, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-106', 9000106, 1106, 'r106c11', 12106.18, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-106', 17000106, 1906, 'r106c19', 20106.26, false, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-106', 25000106, 2706, 'r106c27', 28106.34, false, '2026-07-26'),
    (307, 'r107c3', 4107.11, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-107', 9000107, 1107, 'r107c11', 12107.19, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-107', 17000107, 1907, 'r107c19', 20107.27, true, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-107', 25000107, 2707, 'r107c27', 28107.35, true, '2026-07-27'),
    (308, 'r108c3', 4108.12, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-108', 9000108, 1108, 'r108c11', 12108.20, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-108', 17000108, 1908, 'r108c19', 20108.28, false, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-108', 25000108, 2708, 'r108c27', 28108.36, false, '2026-07-01'),
    (309, 'r109c3', 4109.13, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-109', 9000109, 1109, 'r109c11', 12109.21, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-109', 17000109, 1909, 'r109c19', 20109.29, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-109', 25000109, 2709, 'r109c27', 28109.37, true, '2026-07-02'),
    (310, 'r110c3', 4110.14, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-110', 9000110, 1110, 'r110c11', 12110.22, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-110', 17000110, 1910, 'r110c19', 20110.30, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-110', 25000110, 2710, 'r110c27', 28110.38, false, '2026-07-03'),
    (311, 'r111c3', 4111.15, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-111', 9000111, 1111, 'r111c11', 12111.23, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-111', 17000111, 1911, 'r111c19', 20111.31, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-111', 25000111, 2711, 'r111c27', 28111.39, true, '2026-07-04'),
    (312, 'r112c3', 4112.16, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-112', 9000112, 1112, 'r112c11', 12112.24, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-112', 17000112, 1912, 'r112c19', 20112.32, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-112', 25000112, 2712, 'r112c27', 28112.40, false, '2026-07-05'),
    (313, 'r113c3', 4113.17, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-113', 9000113, 1113, 'r113c11', 12113.25, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-113', 17000113, 1913, 'r113c19', 20113.33, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-113', 25000113, 2713, 'r113c27', 28113.41, true, '2026-07-06'),
    (314, 'r114c3', 4114.18, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-114', 9000114, 1114, 'r114c11', 12114.26, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-114', 17000114, 1914, 'r114c19', 20114.34, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-114', 25000114, 2714, 'r114c27', 28114.42, false, '2026-07-07'),
    (315, 'r115c3', 4115.19, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-115', 9000115, 1115, 'r115c11', 12115.27, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-115', 17000115, 1915, 'r115c19', 20115.35, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-115', 25000115, 2715, 'r115c27', 28115.43, true, '2026-07-08'),
    (316, 'r116c3', 4116.20, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-116', 9000116, 1116, 'r116c11', 12116.28, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-116', 17000116, 1916, 'r116c19', 20116.36, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-116', 25000116, 2716, 'r116c27', 28116.44, false, '2026-07-09'),
    (317, 'r117c3', 4117.21, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-117', 9000117, 1117, 'r117c11', 12117.29, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-117', 17000117, 1917, 'r117c19', 20117.37, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-117', 25000117, 2717, 'r117c27', 28117.45, true, '2026-07-10'),
    (318, 'r118c3', 4118.22, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-118', 9000118, 1118, 'r118c11', 12118.30, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-118', 17000118, 1918, 'r118c19', 20118.38, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-118', 25000118, 2718, 'r118c27', 28118.46, false, '2026-07-11'),
    (319, 'r119c3', 4119.23, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-119', 9000119, 1119, 'r119c11', 12119.31, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-119', 17000119, 1919, 'r119c19', 20119.39, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-119', 25000119, 2719, 'r119c27', 28119.47, true, '2026-07-12'),
    (320, 'r120c3', 4120.24, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-120', 9000120, 1120, 'r120c11', 12120.32, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-120', 17000120, 1920, 'r120c19', 20120.40, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-120', 25000120, 2720, 'r120c27', 28120.48, false, '2026-07-13');

CREATE TABLE wide.cols_40 (
    id  serial  PRIMARY KEY,
    col_002_int      integer,
    col_003_txt      text,
    col_004_num      numeric(12, 2),
    col_005_flag     boolean,
    col_006_day      date,
    col_007_ts       timestamptz,
    col_008_code     varchar(16),
    col_009_big      bigint,
    col_010_int      integer,
    col_011_txt      text,
    col_012_num      numeric(12, 2),
    col_013_flag     boolean,
    col_014_day      date,
    col_015_ts       timestamptz,
    col_016_code     varchar(16),
    col_017_big      bigint,
    col_018_int      integer,
    col_019_txt      text,
    col_020_num      numeric(12, 2),
    col_021_flag     boolean,
    col_022_day      date,
    col_023_ts       timestamptz,
    col_024_code     varchar(16),
    col_025_big      bigint,
    col_026_int      integer,
    col_027_txt      text,
    col_028_num      numeric(12, 2),
    col_029_flag     boolean,
    col_030_day      date,
    col_031_ts       timestamptz,
    col_032_code     varchar(16),
    col_033_big      bigint,
    col_034_int      integer,
    col_035_txt      text,
    col_036_num      numeric(12, 2),
    col_037_flag     boolean,
    col_038_day      date,
    col_039_ts       timestamptz,
    col_040_code     varchar(16)
);

INSERT INTO wide.cols_40 (col_002_int, col_003_txt, col_004_num, col_005_flag, col_006_day, col_007_ts, col_008_code, col_009_big, col_010_int, col_011_txt, col_012_num, col_013_flag, col_014_day, col_015_ts, col_016_code, col_017_big, col_018_int, col_019_txt, col_020_num, col_021_flag, col_022_day, col_023_ts, col_024_code, col_025_big, col_026_int, col_027_txt, col_028_num, col_029_flag, col_030_day, col_031_ts, col_032_code, col_033_big, col_034_int, col_035_txt, col_036_num, col_037_flag, col_038_day, col_039_ts, col_040_code) VALUES
    (201, 'r1c3', 41.05, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-1', 9000001, 1001, 'r1c11', 121.13, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-1', 17000001, 1801, 'r1c19', 201.21, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-1', 25000001, 2601, 'r1c27', 281.29, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C032-1', 33000001, 3401, 'r1c35', 361.37, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C040-1'),
    (202, 'r2c3', 42.06, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-2', 9000002, 1002, 'r2c11', 122.14, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-2', 17000002, 1802, 'r2c19', 202.22, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-2', 25000002, 2602, 'r2c27', 282.30, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C032-2', 33000002, 3402, 'r2c35', 362.38, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C040-2'),
    (203, 'r3c3', 43.07, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-3', 9000003, 1003, 'r3c11', 123.15, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-3', 17000003, 1803, 'r3c19', 203.23, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-3', 25000003, 2603, 'r3c27', 283.31, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C032-3', 33000003, 3403, 'r3c35', 363.39, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C040-3'),
    (204, 'r4c3', 44.08, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-4', 9000004, 1004, 'r4c11', 124.16, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-4', 17000004, 1804, 'r4c19', 204.24, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-4', 25000004, 2604, 'r4c27', 284.32, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C032-4', 33000004, 3404, 'r4c35', 364.40, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C040-4'),
    (205, 'r5c3', 45.09, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-5', 9000005, 1005, 'r5c11', 125.17, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-5', 17000005, 1805, 'r5c19', 205.25, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-5', 25000005, 2605, 'r5c27', 285.33, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C032-5', 33000005, 3405, 'r5c35', 365.41, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C040-5'),
    (206, 'r6c3', 46.10, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-6', 9000006, 1006, 'r6c11', 126.18, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-6', 17000006, 1806, 'r6c19', 206.26, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-6', 25000006, 2606, 'r6c27', 286.34, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C032-6', 33000006, 3406, 'r6c35', 366.42, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C040-6'),
    (207, 'r7c3', 47.11, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-7', 9000007, 1007, 'r7c11', 127.19, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-7', 17000007, 1807, 'r7c19', 207.27, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-7', 25000007, 2607, 'r7c27', 287.35, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C032-7', 33000007, 3407, 'r7c35', 367.43, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C040-7'),
    (208, 'r8c3', 48.12, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-8', 9000008, 1008, 'r8c11', 128.20, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-8', 17000008, 1808, 'r8c19', 208.28, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-8', 25000008, 2608, 'r8c27', 288.36, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C032-8', 33000008, 3408, 'r8c35', 368.44, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C040-8'),
    (209, 'r9c3', 49.13, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-9', 9000009, 1009, 'r9c11', 129.21, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-9', 17000009, 1809, 'r9c19', 209.29, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-9', 25000009, 2609, 'r9c27', 289.37, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C032-9', 33000009, 3409, 'r9c35', 369.45, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C040-9'),
    (210, 'r10c3', 410.14, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-10', 9000010, 1010, 'r10c11', 1210.22, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-10', 17000010, 1810, 'r10c19', 2010.30, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-10', 25000010, 2610, 'r10c27', 2810.38, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C032-10', 33000010, 3410, 'r10c35', 3610.46, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C040-10'),
    (211, 'r11c3', 411.15, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-11', 9000011, 1011, 'r11c11', 1211.23, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-11', 17000011, 1811, 'r11c19', 2011.31, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-11', 25000011, 2611, 'r11c27', 2811.39, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C032-11', 33000011, 3411, 'r11c35', 3611.47, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C040-11'),
    (212, 'r12c3', 412.16, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-12', 9000012, 1012, 'r12c11', 1212.24, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-12', 17000012, 1812, 'r12c19', 2012.32, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-12', 25000012, 2612, 'r12c27', 2812.40, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C032-12', 33000012, 3412, 'r12c35', 3612.48, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C040-12'),
    (213, 'r13c3', 413.17, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-13', 9000013, 1013, 'r13c11', 1213.25, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-13', 17000013, 1813, 'r13c19', 2013.33, true, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-13', 25000013, 2613, 'r13c27', 2813.41, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C032-13', 33000013, 3413, 'r13c35', 3613.49, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C040-13'),
    (214, 'r14c3', 414.18, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-14', 9000014, 1014, 'r14c11', 1214.26, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-14', 17000014, 1814, 'r14c19', 2014.34, false, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-14', 25000014, 2614, 'r14c27', 2814.42, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C032-14', 33000014, 3414, 'r14c35', 3614.50, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C040-14'),
    (215, 'r15c3', 415.19, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-15', 9000015, 1015, 'r15c11', 1215.27, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-15', 17000015, 1815, 'r15c19', 2015.35, true, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-15', 25000015, 2615, 'r15c27', 2815.43, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C032-15', 33000015, 3415, 'r15c35', 3615.51, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C040-15'),
    (216, 'r16c3', 416.20, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-16', 9000016, 1016, 'r16c11', 1216.28, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-16', 17000016, 1816, 'r16c19', 2016.36, false, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-16', 25000016, 2616, 'r16c27', 2816.44, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C032-16', 33000016, 3416, 'r16c35', 3616.52, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C040-16'),
    (217, 'r17c3', 417.21, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-17', 9000017, 1017, 'r17c11', 1217.29, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-17', 17000017, 1817, 'r17c19', 2017.37, true, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-17', 25000017, 2617, 'r17c27', 2817.45, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C032-17', 33000017, 3417, 'r17c35', 3617.53, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C040-17'),
    (218, 'r18c3', 418.22, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-18', 9000018, 1018, 'r18c11', 1218.30, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-18', 17000018, 1818, 'r18c19', 2018.38, false, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-18', 25000018, 2618, 'r18c27', 2818.46, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C032-18', 33000018, 3418, 'r18c35', 3618.54, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C040-18'),
    (219, 'r19c3', 419.23, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-19', 9000019, 1019, 'r19c11', 1219.31, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-19', 17000019, 1819, 'r19c19', 2019.39, true, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-19', 25000019, 2619, 'r19c27', 2819.47, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C032-19', 33000019, 3419, 'r19c35', 3619.55, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C040-19'),
    (220, 'r20c3', 420.24, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-20', 9000020, 1020, 'r20c11', 1220.32, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-20', 17000020, 1820, 'r20c19', 2020.40, false, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-20', 25000020, 2620, 'r20c27', 2820.48, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C032-20', 33000020, 3420, 'r20c35', 3620.56, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C040-20'),
    (221, 'r21c3', 421.25, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-21', 9000021, 1021, 'r21c11', 1221.33, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-21', 17000021, 1821, 'r21c19', 2021.41, true, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-21', 25000021, 2621, 'r21c27', 2821.49, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C032-21', 33000021, 3421, 'r21c35', 3621.57, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C040-21'),
    (222, 'r22c3', 422.26, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-22', 9000022, 1022, 'r22c11', 1222.34, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-22', 17000022, 1822, 'r22c19', 2022.42, false, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-22', 25000022, 2622, 'r22c27', 2822.50, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C032-22', 33000022, 3422, 'r22c35', 3622.58, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C040-22'),
    (223, 'r23c3', 423.27, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-23', 9000023, 1023, 'r23c11', 1223.35, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-23', 17000023, 1823, 'r23c19', 2023.43, true, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-23', 25000023, 2623, 'r23c27', 2823.51, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C032-23', 33000023, 3423, 'r23c35', 3623.59, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C040-23'),
    (224, 'r24c3', 424.28, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-24', 9000024, 1024, 'r24c11', 1224.36, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-24', 17000024, 1824, 'r24c19', 2024.44, false, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-24', 25000024, 2624, 'r24c27', 2824.52, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C032-24', 33000024, 3424, 'r24c35', 3624.60, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C040-24'),
    (225, 'r25c3', 425.29, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-25', 9000025, 1025, 'r25c11', 1225.37, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-25', 17000025, 1825, 'r25c19', 2025.45, true, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-25', 25000025, 2625, 'r25c27', 2825.53, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C032-25', 33000025, 3425, 'r25c35', 3625.61, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C040-25'),
    (226, 'r26c3', 426.30, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-26', 9000026, 1026, 'r26c11', 1226.38, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-26', 17000026, 1826, 'r26c19', 2026.46, false, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-26', 25000026, 2626, 'r26c27', 2826.54, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C032-26', 33000026, 3426, 'r26c35', 3626.62, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C040-26'),
    (227, 'r27c3', 427.31, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-27', 9000027, 1027, 'r27c11', 1227.39, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-27', 17000027, 1827, 'r27c19', 2027.47, true, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-27', 25000027, 2627, 'r27c27', 2827.55, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C032-27', 33000027, 3427, 'r27c35', 3627.63, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C040-27'),
    (228, 'r28c3', 428.32, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-28', 9000028, 1028, 'r28c11', 1228.40, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-28', 17000028, 1828, 'r28c19', 2028.48, false, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-28', 25000028, 2628, 'r28c27', 2828.56, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C032-28', 33000028, 3428, 'r28c35', 3628.64, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C040-28'),
    (229, 'r29c3', 429.33, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-29', 9000029, 1029, 'r29c11', 1229.41, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-29', 17000029, 1829, 'r29c19', 2029.49, true, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-29', 25000029, 2629, 'r29c27', 2829.57, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C032-29', 33000029, 3429, 'r29c35', 3629.65, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C040-29'),
    (230, 'r30c3', 430.34, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-30', 9000030, 1030, 'r30c11', 1230.42, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-30', 17000030, 1830, 'r30c19', 2030.50, false, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-30', 25000030, 2630, 'r30c27', 2830.58, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C032-30', 33000030, 3430, 'r30c35', 3630.66, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C040-30'),
    (231, 'r31c3', 431.35, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-31', 9000031, 1031, 'r31c11', 1231.43, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-31', 17000031, 1831, 'r31c19', 2031.51, true, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-31', 25000031, 2631, 'r31c27', 2831.59, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C032-31', 33000031, 3431, 'r31c35', 3631.67, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C040-31'),
    (232, 'r32c3', 432.36, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-32', 9000032, 1032, 'r32c11', 1232.44, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-32', 17000032, 1832, 'r32c19', 2032.52, false, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-32', 25000032, 2632, 'r32c27', 2832.60, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C032-32', 33000032, 3432, 'r32c35', 3632.68, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C040-32'),
    (233, 'r33c3', 433.37, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-33', 9000033, 1033, 'r33c11', 1233.45, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-33', 17000033, 1833, 'r33c19', 2033.53, true, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-33', 25000033, 2633, 'r33c27', 2833.61, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C032-33', 33000033, 3433, 'r33c35', 3633.69, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C040-33'),
    (234, 'r34c3', 434.38, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-34', 9000034, 1034, 'r34c11', 1234.46, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-34', 17000034, 1834, 'r34c19', 2034.54, false, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-34', 25000034, 2634, 'r34c27', 2834.62, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C032-34', 33000034, 3434, 'r34c35', 3634.70, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C040-34'),
    (235, 'r35c3', 435.39, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-35', 9000035, 1035, 'r35c11', 1235.47, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-35', 17000035, 1835, 'r35c19', 2035.55, true, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-35', 25000035, 2635, 'r35c27', 2835.63, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C032-35', 33000035, 3435, 'r35c35', 3635.71, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C040-35'),
    (236, 'r36c3', 436.40, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-36', 9000036, 1036, 'r36c11', 1236.48, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-36', 17000036, 1836, 'r36c19', 2036.56, false, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-36', 25000036, 2636, 'r36c27', 2836.64, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C032-36', 33000036, 3436, 'r36c35', 3636.72, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C040-36'),
    (237, 'r37c3', 437.41, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-37', 9000037, 1037, 'r37c11', 1237.49, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-37', 17000037, 1837, 'r37c19', 2037.57, true, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-37', 25000037, 2637, 'r37c27', 2837.65, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C032-37', 33000037, 3437, 'r37c35', 3637.73, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C040-37'),
    (238, 'r38c3', 438.42, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-38', 9000038, 1038, 'r38c11', 1238.50, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-38', 17000038, 1838, 'r38c19', 2038.58, false, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-38', 25000038, 2638, 'r38c27', 2838.66, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C032-38', 33000038, 3438, 'r38c35', 3638.74, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C040-38'),
    (239, 'r39c3', 439.43, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-39', 9000039, 1039, 'r39c11', 1239.51, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-39', 17000039, 1839, 'r39c19', 2039.59, true, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-39', 25000039, 2639, 'r39c27', 2839.67, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C032-39', 33000039, 3439, 'r39c35', 3639.75, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C040-39'),
    (240, 'r40c3', 440.44, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-40', 9000040, 1040, 'r40c11', 1240.52, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-40', 17000040, 1840, 'r40c19', 2040.60, false, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-40', 25000040, 2640, 'r40c27', 2840.68, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C032-40', 33000040, 3440, 'r40c35', 3640.76, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C040-40'),
    (241, 'r41c3', 441.45, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-41', 9000041, 1041, 'r41c11', 1241.53, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-41', 17000041, 1841, 'r41c19', 2041.61, true, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-41', 25000041, 2641, 'r41c27', 2841.69, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C032-41', 33000041, 3441, 'r41c35', 3641.77, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C040-41'),
    (242, 'r42c3', 442.46, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-42', 9000042, 1042, 'r42c11', 1242.54, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-42', 17000042, 1842, 'r42c19', 2042.62, false, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-42', 25000042, 2642, 'r42c27', 2842.70, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C032-42', 33000042, 3442, 'r42c35', 3642.78, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C040-42'),
    (243, 'r43c3', 443.47, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-43', 9000043, 1043, 'r43c11', 1243.55, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-43', 17000043, 1843, 'r43c19', 2043.63, true, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-43', 25000043, 2643, 'r43c27', 2843.71, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C032-43', 33000043, 3443, 'r43c35', 3643.79, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C040-43'),
    (244, 'r44c3', 444.48, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-44', 9000044, 1044, 'r44c11', 1244.56, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-44', 17000044, 1844, 'r44c19', 2044.64, false, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-44', 25000044, 2644, 'r44c27', 2844.72, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C032-44', 33000044, 3444, 'r44c35', 3644.80, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C040-44'),
    (245, 'r45c3', 445.49, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-45', 9000045, 1045, 'r45c11', 1245.57, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-45', 17000045, 1845, 'r45c19', 2045.65, true, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-45', 25000045, 2645, 'r45c27', 2845.73, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C032-45', 33000045, 3445, 'r45c35', 3645.81, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C040-45'),
    (246, 'r46c3', 446.50, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-46', 9000046, 1046, 'r46c11', 1246.58, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-46', 17000046, 1846, 'r46c19', 2046.66, false, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-46', 25000046, 2646, 'r46c27', 2846.74, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C032-46', 33000046, 3446, 'r46c35', 3646.82, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C040-46'),
    (247, 'r47c3', 447.51, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-47', 9000047, 1047, 'r47c11', 1247.59, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-47', 17000047, 1847, 'r47c19', 2047.67, true, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-47', 25000047, 2647, 'r47c27', 2847.75, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C032-47', 33000047, 3447, 'r47c35', 3647.83, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C040-47'),
    (248, 'r48c3', 448.52, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-48', 9000048, 1048, 'r48c11', 1248.60, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-48', 17000048, 1848, 'r48c19', 2048.68, false, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-48', 25000048, 2648, 'r48c27', 2848.76, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C032-48', 33000048, 3448, 'r48c35', 3648.84, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C040-48'),
    (249, 'r49c3', 449.53, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-49', 9000049, 1049, 'r49c11', 1249.61, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-49', 17000049, 1849, 'r49c19', 2049.69, true, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-49', 25000049, 2649, 'r49c27', 2849.77, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C032-49', 33000049, 3449, 'r49c35', 3649.85, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C040-49'),
    (250, 'r50c3', 450.54, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-50', 9000050, 1050, 'r50c11', 1250.62, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-50', 17000050, 1850, 'r50c19', 2050.70, false, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-50', 25000050, 2650, 'r50c27', 2850.78, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C032-50', 33000050, 3450, 'r50c35', 3650.86, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C040-50'),
    (251, 'r51c3', 451.55, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-51', 9000051, 1051, 'r51c11', 1251.63, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-51', 17000051, 1851, 'r51c19', 2051.71, true, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-51', 25000051, 2651, 'r51c27', 2851.79, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C032-51', 33000051, 3451, 'r51c35', 3651.87, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C040-51'),
    (252, 'r52c3', 452.56, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-52', 9000052, 1052, 'r52c11', 1252.64, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-52', 17000052, 1852, 'r52c19', 2052.72, false, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-52', 25000052, 2652, 'r52c27', 2852.80, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C032-52', 33000052, 3452, 'r52c35', 3652.88, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C040-52'),
    (253, 'r53c3', 453.57, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-53', 9000053, 1053, 'r53c11', 1253.65, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-53', 17000053, 1853, 'r53c19', 2053.73, true, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-53', 25000053, 2653, 'r53c27', 2853.81, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C032-53', 33000053, 3453, 'r53c35', 3653.89, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C040-53'),
    (254, 'r54c3', 454.58, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-54', 9000054, 1054, 'r54c11', 1254.66, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-54', 17000054, 1854, 'r54c19', 2054.74, false, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-54', 25000054, 2654, 'r54c27', 2854.82, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C032-54', 33000054, 3454, 'r54c35', 3654.90, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C040-54'),
    (255, 'r55c3', 455.59, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-55', 9000055, 1055, 'r55c11', 1255.67, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-55', 17000055, 1855, 'r55c19', 2055.75, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-55', 25000055, 2655, 'r55c27', 2855.83, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C032-55', 33000055, 3455, 'r55c35', 3655.91, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C040-55'),
    (256, 'r56c3', 456.60, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-56', 9000056, 1056, 'r56c11', 1256.68, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-56', 17000056, 1856, 'r56c19', 2056.76, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-56', 25000056, 2656, 'r56c27', 2856.84, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C032-56', 33000056, 3456, 'r56c35', 3656.92, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C040-56'),
    (257, 'r57c3', 457.61, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-57', 9000057, 1057, 'r57c11', 1257.69, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-57', 17000057, 1857, 'r57c19', 2057.77, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-57', 25000057, 2657, 'r57c27', 2857.85, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C032-57', 33000057, 3457, 'r57c35', 3657.93, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C040-57'),
    (258, 'r58c3', 458.62, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-58', 9000058, 1058, 'r58c11', 1258.70, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-58', 17000058, 1858, 'r58c19', 2058.78, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-58', 25000058, 2658, 'r58c27', 2858.86, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C032-58', 33000058, 3458, 'r58c35', 3658.94, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C040-58'),
    (259, 'r59c3', 459.63, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-59', 9000059, 1059, 'r59c11', 1259.71, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-59', 17000059, 1859, 'r59c19', 2059.79, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-59', 25000059, 2659, 'r59c27', 2859.87, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C032-59', 33000059, 3459, 'r59c35', 3659.95, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C040-59'),
    (260, 'r60c3', 460.64, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-60', 9000060, 1060, 'r60c11', 1260.72, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-60', 17000060, 1860, 'r60c19', 2060.80, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-60', 25000060, 2660, 'r60c27', 2860.88, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C032-60', 33000060, 3460, 'r60c35', 3660.96, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C040-60'),
    (261, 'r61c3', 461.65, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-61', 9000061, 1061, 'r61c11', 1261.73, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-61', 17000061, 1861, 'r61c19', 2061.81, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-61', 25000061, 2661, 'r61c27', 2861.89, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C032-61', 33000061, 3461, 'r61c35', 3661.97, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C040-61'),
    (262, 'r62c3', 462.66, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-62', 9000062, 1062, 'r62c11', 1262.74, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-62', 17000062, 1862, 'r62c19', 2062.82, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-62', 25000062, 2662, 'r62c27', 2862.90, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C032-62', 33000062, 3462, 'r62c35', 3662.98, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C040-62'),
    (263, 'r63c3', 463.67, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-63', 9000063, 1063, 'r63c11', 1263.75, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-63', 17000063, 1863, 'r63c19', 2063.83, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-63', 25000063, 2663, 'r63c27', 2863.91, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C032-63', 33000063, 3463, 'r63c35', 3663.99, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C040-63'),
    (264, 'r64c3', 464.68, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-64', 9000064, 1064, 'r64c11', 1264.76, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-64', 17000064, 1864, 'r64c19', 2064.84, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-64', 25000064, 2664, 'r64c27', 2864.92, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C032-64', 33000064, 3464, 'r64c35', 3664.00, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C040-64'),
    (265, 'r65c3', 465.69, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-65', 9000065, 1065, 'r65c11', 1265.77, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-65', 17000065, 1865, 'r65c19', 2065.85, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-65', 25000065, 2665, 'r65c27', 2865.93, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C032-65', 33000065, 3465, 'r65c35', 3665.01, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C040-65'),
    (266, 'r66c3', 466.70, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-66', 9000066, 1066, 'r66c11', 1266.78, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-66', 17000066, 1866, 'r66c19', 2066.86, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-66', 25000066, 2666, 'r66c27', 2866.94, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C032-66', 33000066, 3466, 'r66c35', 3666.02, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C040-66'),
    (267, 'r67c3', 467.71, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-67', 9000067, 1067, 'r67c11', 1267.79, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-67', 17000067, 1867, 'r67c19', 2067.87, true, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-67', 25000067, 2667, 'r67c27', 2867.95, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C032-67', 33000067, 3467, 'r67c35', 3667.03, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C040-67'),
    (268, 'r68c3', 468.72, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-68', 9000068, 1068, 'r68c11', 1268.80, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-68', 17000068, 1868, 'r68c19', 2068.88, false, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-68', 25000068, 2668, 'r68c27', 2868.96, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C032-68', 33000068, 3468, 'r68c35', 3668.04, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C040-68'),
    (269, 'r69c3', 469.73, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-69', 9000069, 1069, 'r69c11', 1269.81, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-69', 17000069, 1869, 'r69c19', 2069.89, true, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-69', 25000069, 2669, 'r69c27', 2869.97, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C032-69', 33000069, 3469, 'r69c35', 3669.05, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C040-69'),
    (270, 'r70c3', 470.74, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-70', 9000070, 1070, 'r70c11', 1270.82, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-70', 17000070, 1870, 'r70c19', 2070.90, false, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-70', 25000070, 2670, 'r70c27', 2870.98, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C032-70', 33000070, 3470, 'r70c35', 3670.06, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C040-70'),
    (271, 'r71c3', 471.75, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-71', 9000071, 1071, 'r71c11', 1271.83, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-71', 17000071, 1871, 'r71c19', 2071.91, true, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-71', 25000071, 2671, 'r71c27', 2871.99, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C032-71', 33000071, 3471, 'r71c35', 3671.07, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C040-71'),
    (272, 'r72c3', 472.76, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-72', 9000072, 1072, 'r72c11', 1272.84, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-72', 17000072, 1872, 'r72c19', 2072.92, false, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-72', 25000072, 2672, 'r72c27', 2872.00, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C032-72', 33000072, 3472, 'r72c35', 3672.08, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C040-72'),
    (273, 'r73c3', 473.77, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-73', 9000073, 1073, 'r73c11', 1273.85, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-73', 17000073, 1873, 'r73c19', 2073.93, true, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-73', 25000073, 2673, 'r73c27', 2873.01, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C032-73', 33000073, 3473, 'r73c35', 3673.09, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C040-73'),
    (274, 'r74c3', 474.78, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-74', 9000074, 1074, 'r74c11', 1274.86, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-74', 17000074, 1874, 'r74c19', 2074.94, false, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-74', 25000074, 2674, 'r74c27', 2874.02, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C032-74', 33000074, 3474, 'r74c35', 3674.10, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C040-74'),
    (275, 'r75c3', 475.79, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-75', 9000075, 1075, 'r75c11', 1275.87, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-75', 17000075, 1875, 'r75c19', 2075.95, true, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-75', 25000075, 2675, 'r75c27', 2875.03, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C032-75', 33000075, 3475, 'r75c35', 3675.11, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C040-75'),
    (276, 'r76c3', 476.80, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-76', 9000076, 1076, 'r76c11', 1276.88, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-76', 17000076, 1876, 'r76c19', 2076.96, false, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-76', 25000076, 2676, 'r76c27', 2876.04, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C032-76', 33000076, 3476, 'r76c35', 3676.12, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C040-76'),
    (277, 'r77c3', 477.81, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-77', 9000077, 1077, 'r77c11', 1277.89, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-77', 17000077, 1877, 'r77c19', 2077.97, true, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-77', 25000077, 2677, 'r77c27', 2877.05, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C032-77', 33000077, 3477, 'r77c35', 3677.13, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C040-77'),
    (278, 'r78c3', 478.82, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-78', 9000078, 1078, 'r78c11', 1278.90, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-78', 17000078, 1878, 'r78c19', 2078.98, false, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-78', 25000078, 2678, 'r78c27', 2878.06, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C032-78', 33000078, 3478, 'r78c35', 3678.14, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C040-78'),
    (279, 'r79c3', 479.83, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-79', 9000079, 1079, 'r79c11', 1279.91, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-79', 17000079, 1879, 'r79c19', 2079.99, true, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-79', 25000079, 2679, 'r79c27', 2879.07, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C032-79', 33000079, 3479, 'r79c35', 3679.15, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C040-79'),
    (280, 'r80c3', 480.84, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-80', 9000080, 1080, 'r80c11', 1280.92, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-80', 17000080, 1880, 'r80c19', 2080.00, false, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-80', 25000080, 2680, 'r80c27', 2880.08, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C032-80', 33000080, 3480, 'r80c35', 3680.16, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C040-80'),
    (281, 'r81c3', 481.85, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-81', 9000081, 1081, 'r81c11', 1281.93, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-81', 17000081, 1881, 'r81c19', 2081.01, true, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-81', 25000081, 2681, 'r81c27', 2881.09, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C032-81', 33000081, 3481, 'r81c35', 3681.17, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C040-81'),
    (282, 'r82c3', 482.86, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-82', 9000082, 1082, 'r82c11', 1282.94, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-82', 17000082, 1882, 'r82c19', 2082.02, false, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-82', 25000082, 2682, 'r82c27', 2882.10, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C032-82', 33000082, 3482, 'r82c35', 3682.18, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C040-82'),
    (283, 'r83c3', 483.87, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-83', 9000083, 1083, 'r83c11', 1283.95, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-83', 17000083, 1883, 'r83c19', 2083.03, true, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-83', 25000083, 2683, 'r83c27', 2883.11, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C032-83', 33000083, 3483, 'r83c35', 3683.19, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C040-83'),
    (284, 'r84c3', 484.88, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-84', 9000084, 1084, 'r84c11', 1284.96, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-84', 17000084, 1884, 'r84c19', 2084.04, false, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-84', 25000084, 2684, 'r84c27', 2884.12, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C032-84', 33000084, 3484, 'r84c35', 3684.20, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C040-84'),
    (285, 'r85c3', 485.89, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-85', 9000085, 1085, 'r85c11', 1285.97, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-85', 17000085, 1885, 'r85c19', 2085.05, true, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-85', 25000085, 2685, 'r85c27', 2885.13, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C032-85', 33000085, 3485, 'r85c35', 3685.21, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C040-85'),
    (286, 'r86c3', 486.90, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-86', 9000086, 1086, 'r86c11', 1286.98, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-86', 17000086, 1886, 'r86c19', 2086.06, false, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-86', 25000086, 2686, 'r86c27', 2886.14, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C032-86', 33000086, 3486, 'r86c35', 3686.22, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C040-86'),
    (287, 'r87c3', 487.91, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-87', 9000087, 1087, 'r87c11', 1287.99, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-87', 17000087, 1887, 'r87c19', 2087.07, true, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-87', 25000087, 2687, 'r87c27', 2887.15, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C032-87', 33000087, 3487, 'r87c35', 3687.23, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C040-87'),
    (288, 'r88c3', 488.92, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-88', 9000088, 1088, 'r88c11', 1288.00, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-88', 17000088, 1888, 'r88c19', 2088.08, false, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-88', 25000088, 2688, 'r88c27', 2888.16, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C032-88', 33000088, 3488, 'r88c35', 3688.24, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C040-88'),
    (289, 'r89c3', 489.93, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-89', 9000089, 1089, 'r89c11', 1289.01, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-89', 17000089, 1889, 'r89c19', 2089.09, true, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-89', 25000089, 2689, 'r89c27', 2889.17, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C032-89', 33000089, 3489, 'r89c35', 3689.25, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C040-89'),
    (290, 'r90c3', 490.94, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-90', 9000090, 1090, 'r90c11', 1290.02, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-90', 17000090, 1890, 'r90c19', 2090.10, false, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-90', 25000090, 2690, 'r90c27', 2890.18, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C032-90', 33000090, 3490, 'r90c35', 3690.26, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C040-90'),
    (291, 'r91c3', 491.95, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-91', 9000091, 1091, 'r91c11', 1291.03, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-91', 17000091, 1891, 'r91c19', 2091.11, true, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-91', 25000091, 2691, 'r91c27', 2891.19, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C032-91', 33000091, 3491, 'r91c35', 3691.27, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C040-91'),
    (292, 'r92c3', 492.96, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-92', 9000092, 1092, 'r92c11', 1292.04, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-92', 17000092, 1892, 'r92c19', 2092.12, false, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-92', 25000092, 2692, 'r92c27', 2892.20, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C032-92', 33000092, 3492, 'r92c35', 3692.28, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C040-92'),
    (293, 'r93c3', 493.97, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-93', 9000093, 1093, 'r93c11', 1293.05, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-93', 17000093, 1893, 'r93c19', 2093.13, true, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-93', 25000093, 2693, 'r93c27', 2893.21, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C032-93', 33000093, 3493, 'r93c35', 3693.29, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C040-93'),
    (294, 'r94c3', 494.98, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-94', 9000094, 1094, 'r94c11', 1294.06, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-94', 17000094, 1894, 'r94c19', 2094.14, false, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-94', 25000094, 2694, 'r94c27', 2894.22, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C032-94', 33000094, 3494, 'r94c35', 3694.30, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C040-94'),
    (295, 'r95c3', 495.99, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-95', 9000095, 1095, 'r95c11', 1295.07, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-95', 17000095, 1895, 'r95c19', 2095.15, true, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-95', 25000095, 2695, 'r95c27', 2895.23, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C032-95', 33000095, 3495, 'r95c35', 3695.31, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C040-95'),
    (296, 'r96c3', 496.00, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-96', 9000096, 1096, 'r96c11', 1296.08, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-96', 17000096, 1896, 'r96c19', 2096.16, false, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-96', 25000096, 2696, 'r96c27', 2896.24, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C032-96', 33000096, 3496, 'r96c35', 3696.32, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C040-96'),
    (297, 'r97c3', 497.01, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-97', 9000097, 1097, 'r97c11', 1297.09, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-97', 17000097, 1897, 'r97c19', 2097.17, true, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-97', 25000097, 2697, 'r97c27', 2897.25, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C032-97', 33000097, 3497, 'r97c35', 3697.33, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C040-97'),
    (298, 'r98c3', 498.02, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-98', 9000098, 1098, 'r98c11', 1298.10, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-98', 17000098, 1898, 'r98c19', 2098.18, false, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-98', 25000098, 2698, 'r98c27', 2898.26, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C032-98', 33000098, 3498, 'r98c35', 3698.34, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C040-98'),
    (299, 'r99c3', 499.03, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-99', 9000099, 1099, 'r99c11', 1299.11, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-99', 17000099, 1899, 'r99c19', 2099.19, true, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-99', 25000099, 2699, 'r99c27', 2899.27, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C032-99', 33000099, 3499, 'r99c35', 3699.35, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C040-99'),
    (300, 'r100c3', 4100.04, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-100', 9000100, 1100, 'r100c11', 12100.12, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-100', 17000100, 1900, 'r100c19', 20100.20, false, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-100', 25000100, 2700, 'r100c27', 28100.28, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C032-100', 33000100, 3500, 'r100c35', 36100.36, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C040-100'),
    (301, 'r101c3', 4101.05, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-101', 9000101, 1101, 'r101c11', 12101.13, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-101', 17000101, 1901, 'r101c19', 20101.21, true, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-101', 25000101, 2701, 'r101c27', 28101.29, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C032-101', 33000101, 3501, 'r101c35', 36101.37, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C040-101'),
    (302, 'r102c3', 4102.06, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-102', 9000102, 1102, 'r102c11', 12102.14, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-102', 17000102, 1902, 'r102c19', 20102.22, false, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-102', 25000102, 2702, 'r102c27', 28102.30, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C032-102', 33000102, 3502, 'r102c35', 36102.38, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C040-102'),
    (303, 'r103c3', 4103.07, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-103', 9000103, 1103, 'r103c11', 12103.15, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-103', 17000103, 1903, 'r103c19', 20103.23, true, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-103', 25000103, 2703, 'r103c27', 28103.31, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C032-103', 33000103, 3503, 'r103c35', 36103.39, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C040-103'),
    (304, 'r104c3', 4104.08, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-104', 9000104, 1104, 'r104c11', 12104.16, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-104', 17000104, 1904, 'r104c19', 20104.24, false, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-104', 25000104, 2704, 'r104c27', 28104.32, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C032-104', 33000104, 3504, 'r104c35', 36104.40, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C040-104'),
    (305, 'r105c3', 4105.09, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-105', 9000105, 1105, 'r105c11', 12105.17, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-105', 17000105, 1905, 'r105c19', 20105.25, true, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-105', 25000105, 2705, 'r105c27', 28105.33, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C032-105', 33000105, 3505, 'r105c35', 36105.41, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C040-105'),
    (306, 'r106c3', 4106.10, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-106', 9000106, 1106, 'r106c11', 12106.18, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-106', 17000106, 1906, 'r106c19', 20106.26, false, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-106', 25000106, 2706, 'r106c27', 28106.34, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C032-106', 33000106, 3506, 'r106c35', 36106.42, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C040-106'),
    (307, 'r107c3', 4107.11, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-107', 9000107, 1107, 'r107c11', 12107.19, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-107', 17000107, 1907, 'r107c19', 20107.27, true, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-107', 25000107, 2707, 'r107c27', 28107.35, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C032-107', 33000107, 3507, 'r107c35', 36107.43, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C040-107'),
    (308, 'r108c3', 4108.12, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-108', 9000108, 1108, 'r108c11', 12108.20, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-108', 17000108, 1908, 'r108c19', 20108.28, false, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-108', 25000108, 2708, 'r108c27', 28108.36, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C032-108', 33000108, 3508, 'r108c35', 36108.44, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C040-108'),
    (309, 'r109c3', 4109.13, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-109', 9000109, 1109, 'r109c11', 12109.21, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-109', 17000109, 1909, 'r109c19', 20109.29, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-109', 25000109, 2709, 'r109c27', 28109.37, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C032-109', 33000109, 3509, 'r109c35', 36109.45, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C040-109'),
    (310, 'r110c3', 4110.14, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-110', 9000110, 1110, 'r110c11', 12110.22, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-110', 17000110, 1910, 'r110c19', 20110.30, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-110', 25000110, 2710, 'r110c27', 28110.38, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C032-110', 33000110, 3510, 'r110c35', 36110.46, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C040-110'),
    (311, 'r111c3', 4111.15, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-111', 9000111, 1111, 'r111c11', 12111.23, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-111', 17000111, 1911, 'r111c19', 20111.31, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-111', 25000111, 2711, 'r111c27', 28111.39, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C032-111', 33000111, 3511, 'r111c35', 36111.47, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C040-111'),
    (312, 'r112c3', 4112.16, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-112', 9000112, 1112, 'r112c11', 12112.24, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-112', 17000112, 1912, 'r112c19', 20112.32, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-112', 25000112, 2712, 'r112c27', 28112.40, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C032-112', 33000112, 3512, 'r112c35', 36112.48, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C040-112'),
    (313, 'r113c3', 4113.17, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-113', 9000113, 1113, 'r113c11', 12113.25, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-113', 17000113, 1913, 'r113c19', 20113.33, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-113', 25000113, 2713, 'r113c27', 28113.41, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C032-113', 33000113, 3513, 'r113c35', 36113.49, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C040-113'),
    (314, 'r114c3', 4114.18, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-114', 9000114, 1114, 'r114c11', 12114.26, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-114', 17000114, 1914, 'r114c19', 20114.34, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-114', 25000114, 2714, 'r114c27', 28114.42, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C032-114', 33000114, 3514, 'r114c35', 36114.50, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C040-114'),
    (315, 'r115c3', 4115.19, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-115', 9000115, 1115, 'r115c11', 12115.27, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-115', 17000115, 1915, 'r115c19', 20115.35, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-115', 25000115, 2715, 'r115c27', 28115.43, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C032-115', 33000115, 3515, 'r115c35', 36115.51, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C040-115'),
    (316, 'r116c3', 4116.20, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-116', 9000116, 1116, 'r116c11', 12116.28, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-116', 17000116, 1916, 'r116c19', 20116.36, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-116', 25000116, 2716, 'r116c27', 28116.44, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C032-116', 33000116, 3516, 'r116c35', 36116.52, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C040-116'),
    (317, 'r117c3', 4117.21, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-117', 9000117, 1117, 'r117c11', 12117.29, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-117', 17000117, 1917, 'r117c19', 20117.37, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-117', 25000117, 2717, 'r117c27', 28117.45, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C032-117', 33000117, 3517, 'r117c35', 36117.53, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C040-117'),
    (318, 'r118c3', 4118.22, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-118', 9000118, 1118, 'r118c11', 12118.30, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-118', 17000118, 1918, 'r118c19', 20118.38, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-118', 25000118, 2718, 'r118c27', 28118.46, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C032-118', 33000118, 3518, 'r118c35', 36118.54, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C040-118'),
    (319, 'r119c3', 4119.23, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-119', 9000119, 1119, 'r119c11', 12119.31, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-119', 17000119, 1919, 'r119c19', 20119.39, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-119', 25000119, 2719, 'r119c27', 28119.47, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C032-119', 33000119, 3519, 'r119c35', 36119.55, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C040-119'),
    (320, 'r120c3', 4120.24, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-120', 9000120, 1120, 'r120c11', 12120.32, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-120', 17000120, 1920, 'r120c19', 20120.40, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-120', 25000120, 2720, 'r120c27', 28120.48, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C032-120', 33000120, 3520, 'r120c35', 36120.56, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C040-120');

CREATE TABLE wide.cols_60 (
    id  serial  PRIMARY KEY,
    col_002_int      integer,
    col_003_txt      text,
    col_004_num      numeric(12, 2),
    col_005_flag     boolean,
    col_006_day      date,
    col_007_ts       timestamptz,
    col_008_code     varchar(16),
    col_009_big      bigint,
    col_010_int      integer,
    col_011_txt      text,
    col_012_num      numeric(12, 2),
    col_013_flag     boolean,
    col_014_day      date,
    col_015_ts       timestamptz,
    col_016_code     varchar(16),
    col_017_big      bigint,
    col_018_int      integer,
    col_019_txt      text,
    col_020_num      numeric(12, 2),
    col_021_flag     boolean,
    col_022_day      date,
    col_023_ts       timestamptz,
    col_024_code     varchar(16),
    col_025_big      bigint,
    col_026_int      integer,
    col_027_txt      text,
    col_028_num      numeric(12, 2),
    col_029_flag     boolean,
    col_030_day      date,
    col_031_ts       timestamptz,
    col_032_code     varchar(16),
    col_033_big      bigint,
    col_034_int      integer,
    col_035_txt      text,
    col_036_num      numeric(12, 2),
    col_037_flag     boolean,
    col_038_day      date,
    col_039_ts       timestamptz,
    col_040_code     varchar(16),
    col_041_big      bigint,
    col_042_int      integer,
    col_043_txt      text,
    col_044_num      numeric(12, 2),
    col_045_flag     boolean,
    col_046_day      date,
    col_047_ts       timestamptz,
    col_048_code     varchar(16),
    col_049_big      bigint,
    col_050_int      integer,
    col_051_txt      text,
    col_052_num      numeric(12, 2),
    col_053_flag     boolean,
    col_054_day      date,
    col_055_ts       timestamptz,
    col_056_code     varchar(16),
    col_057_big      bigint,
    col_058_int      integer,
    col_059_txt      text,
    col_060_num      numeric(12, 2)
);

INSERT INTO wide.cols_60 (col_002_int, col_003_txt, col_004_num, col_005_flag, col_006_day, col_007_ts, col_008_code, col_009_big, col_010_int, col_011_txt, col_012_num, col_013_flag, col_014_day, col_015_ts, col_016_code, col_017_big, col_018_int, col_019_txt, col_020_num, col_021_flag, col_022_day, col_023_ts, col_024_code, col_025_big, col_026_int, col_027_txt, col_028_num, col_029_flag, col_030_day, col_031_ts, col_032_code, col_033_big, col_034_int, col_035_txt, col_036_num, col_037_flag, col_038_day, col_039_ts, col_040_code, col_041_big, col_042_int, col_043_txt, col_044_num, col_045_flag, col_046_day, col_047_ts, col_048_code, col_049_big, col_050_int, col_051_txt, col_052_num, col_053_flag, col_054_day, col_055_ts, col_056_code, col_057_big, col_058_int, col_059_txt, col_060_num) VALUES
    (201, 'r1c3', 41.05, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-1', 9000001, 1001, 'r1c11', 121.13, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-1', 17000001, 1801, 'r1c19', 201.21, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-1', 25000001, 2601, 'r1c27', 281.29, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C032-1', 33000001, 3401, 'r1c35', 361.37, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C040-1', 41000001, 4201, 'r1c43', 441.45, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C048-1', 49000001, 5001, 'r1c51', 521.53, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C056-1', 57000001, 5801, 'r1c59', 601.61),
    (202, 'r2c3', 42.06, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-2', 9000002, 1002, 'r2c11', 122.14, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-2', 17000002, 1802, 'r2c19', 202.22, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-2', 25000002, 2602, 'r2c27', 282.30, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C032-2', 33000002, 3402, 'r2c35', 362.38, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C040-2', 41000002, 4202, 'r2c43', 442.46, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C048-2', 49000002, 5002, 'r2c51', 522.54, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C056-2', 57000002, 5802, 'r2c59', 602.62),
    (203, 'r3c3', 43.07, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-3', 9000003, 1003, 'r3c11', 123.15, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-3', 17000003, 1803, 'r3c19', 203.23, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-3', 25000003, 2603, 'r3c27', 283.31, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C032-3', 33000003, 3403, 'r3c35', 363.39, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C040-3', 41000003, 4203, 'r3c43', 443.47, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C048-3', 49000003, 5003, 'r3c51', 523.55, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C056-3', 57000003, 5803, 'r3c59', 603.63),
    (204, 'r4c3', 44.08, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-4', 9000004, 1004, 'r4c11', 124.16, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-4', 17000004, 1804, 'r4c19', 204.24, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-4', 25000004, 2604, 'r4c27', 284.32, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C032-4', 33000004, 3404, 'r4c35', 364.40, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C040-4', 41000004, 4204, 'r4c43', 444.48, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C048-4', 49000004, 5004, 'r4c51', 524.56, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C056-4', 57000004, 5804, 'r4c59', 604.64),
    (205, 'r5c3', 45.09, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-5', 9000005, 1005, 'r5c11', 125.17, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-5', 17000005, 1805, 'r5c19', 205.25, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-5', 25000005, 2605, 'r5c27', 285.33, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C032-5', 33000005, 3405, 'r5c35', 365.41, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C040-5', 41000005, 4205, 'r5c43', 445.49, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C048-5', 49000005, 5005, 'r5c51', 525.57, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C056-5', 57000005, 5805, 'r5c59', 605.65),
    (206, 'r6c3', 46.10, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-6', 9000006, 1006, 'r6c11', 126.18, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-6', 17000006, 1806, 'r6c19', 206.26, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-6', 25000006, 2606, 'r6c27', 286.34, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C032-6', 33000006, 3406, 'r6c35', 366.42, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C040-6', 41000006, 4206, 'r6c43', 446.50, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C048-6', 49000006, 5006, 'r6c51', 526.58, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C056-6', 57000006, 5806, 'r6c59', 606.66),
    (207, 'r7c3', 47.11, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-7', 9000007, 1007, 'r7c11', 127.19, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-7', 17000007, 1807, 'r7c19', 207.27, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-7', 25000007, 2607, 'r7c27', 287.35, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C032-7', 33000007, 3407, 'r7c35', 367.43, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C040-7', 41000007, 4207, 'r7c43', 447.51, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C048-7', 49000007, 5007, 'r7c51', 527.59, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C056-7', 57000007, 5807, 'r7c59', 607.67),
    (208, 'r8c3', 48.12, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-8', 9000008, 1008, 'r8c11', 128.20, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-8', 17000008, 1808, 'r8c19', 208.28, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-8', 25000008, 2608, 'r8c27', 288.36, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C032-8', 33000008, 3408, 'r8c35', 368.44, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C040-8', 41000008, 4208, 'r8c43', 448.52, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C048-8', 49000008, 5008, 'r8c51', 528.60, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C056-8', 57000008, 5808, 'r8c59', 608.68),
    (209, 'r9c3', 49.13, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-9', 9000009, 1009, 'r9c11', 129.21, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-9', 17000009, 1809, 'r9c19', 209.29, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-9', 25000009, 2609, 'r9c27', 289.37, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C032-9', 33000009, 3409, 'r9c35', 369.45, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C040-9', 41000009, 4209, 'r9c43', 449.53, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C048-9', 49000009, 5009, 'r9c51', 529.61, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C056-9', 57000009, 5809, 'r9c59', 609.69),
    (210, 'r10c3', 410.14, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-10', 9000010, 1010, 'r10c11', 1210.22, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-10', 17000010, 1810, 'r10c19', 2010.30, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-10', 25000010, 2610, 'r10c27', 2810.38, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C032-10', 33000010, 3410, 'r10c35', 3610.46, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C040-10', 41000010, 4210, 'r10c43', 4410.54, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C048-10', 49000010, 5010, 'r10c51', 5210.62, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C056-10', 57000010, 5810, 'r10c59', 6010.70),
    (211, 'r11c3', 411.15, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-11', 9000011, 1011, 'r11c11', 1211.23, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-11', 17000011, 1811, 'r11c19', 2011.31, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-11', 25000011, 2611, 'r11c27', 2811.39, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C032-11', 33000011, 3411, 'r11c35', 3611.47, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C040-11', 41000011, 4211, 'r11c43', 4411.55, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C048-11', 49000011, 5011, 'r11c51', 5211.63, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C056-11', 57000011, 5811, 'r11c59', 6011.71),
    (212, 'r12c3', 412.16, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-12', 9000012, 1012, 'r12c11', 1212.24, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-12', 17000012, 1812, 'r12c19', 2012.32, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-12', 25000012, 2612, 'r12c27', 2812.40, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C032-12', 33000012, 3412, 'r12c35', 3612.48, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C040-12', 41000012, 4212, 'r12c43', 4412.56, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C048-12', 49000012, 5012, 'r12c51', 5212.64, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C056-12', 57000012, 5812, 'r12c59', 6012.72),
    (213, 'r13c3', 413.17, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-13', 9000013, 1013, 'r13c11', 1213.25, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-13', 17000013, 1813, 'r13c19', 2013.33, true, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-13', 25000013, 2613, 'r13c27', 2813.41, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C032-13', 33000013, 3413, 'r13c35', 3613.49, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C040-13', 41000013, 4213, 'r13c43', 4413.57, true, '2026-11-14', '2026-12-14 12:00:00+00', 'C048-13', 49000013, 5013, 'r13c51', 5213.65, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C056-13', 57000013, 5813, 'r13c59', 6013.73),
    (214, 'r14c3', 414.18, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-14', 9000014, 1014, 'r14c11', 1214.26, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-14', 17000014, 1814, 'r14c19', 2014.34, false, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-14', 25000014, 2614, 'r14c27', 2814.42, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C032-14', 33000014, 3414, 'r14c35', 3614.50, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C040-14', 41000014, 4214, 'r14c43', 4414.58, false, '2026-11-15', '2026-12-15 12:00:00+00', 'C048-14', 49000014, 5014, 'r14c51', 5214.66, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C056-14', 57000014, 5814, 'r14c59', 6014.74),
    (215, 'r15c3', 415.19, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-15', 9000015, 1015, 'r15c11', 1215.27, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-15', 17000015, 1815, 'r15c19', 2015.35, true, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-15', 25000015, 2615, 'r15c27', 2815.43, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C032-15', 33000015, 3415, 'r15c35', 3615.51, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C040-15', 41000015, 4215, 'r15c43', 4415.59, true, '2026-11-16', '2026-12-16 12:00:00+00', 'C048-15', 49000015, 5015, 'r15c51', 5215.67, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C056-15', 57000015, 5815, 'r15c59', 6015.75),
    (216, 'r16c3', 416.20, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-16', 9000016, 1016, 'r16c11', 1216.28, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-16', 17000016, 1816, 'r16c19', 2016.36, false, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-16', 25000016, 2616, 'r16c27', 2816.44, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C032-16', 33000016, 3416, 'r16c35', 3616.52, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C040-16', 41000016, 4216, 'r16c43', 4416.60, false, '2026-11-17', '2026-12-17 12:00:00+00', 'C048-16', 49000016, 5016, 'r16c51', 5216.68, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C056-16', 57000016, 5816, 'r16c59', 6016.76),
    (217, 'r17c3', 417.21, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-17', 9000017, 1017, 'r17c11', 1217.29, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-17', 17000017, 1817, 'r17c19', 2017.37, true, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-17', 25000017, 2617, 'r17c27', 2817.45, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C032-17', 33000017, 3417, 'r17c35', 3617.53, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C040-17', 41000017, 4217, 'r17c43', 4417.61, true, '2026-11-18', '2026-12-18 12:00:00+00', 'C048-17', 49000017, 5017, 'r17c51', 5217.69, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C056-17', 57000017, 5817, 'r17c59', 6017.77),
    (218, 'r18c3', 418.22, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-18', 9000018, 1018, 'r18c11', 1218.30, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-18', 17000018, 1818, 'r18c19', 2018.38, false, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-18', 25000018, 2618, 'r18c27', 2818.46, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C032-18', 33000018, 3418, 'r18c35', 3618.54, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C040-18', 41000018, 4218, 'r18c43', 4418.62, false, '2026-11-19', '2026-12-19 12:00:00+00', 'C048-18', 49000018, 5018, 'r18c51', 5218.70, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C056-18', 57000018, 5818, 'r18c59', 6018.78),
    (219, 'r19c3', 419.23, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-19', 9000019, 1019, 'r19c11', 1219.31, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-19', 17000019, 1819, 'r19c19', 2019.39, true, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-19', 25000019, 2619, 'r19c27', 2819.47, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C032-19', 33000019, 3419, 'r19c35', 3619.55, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C040-19', 41000019, 4219, 'r19c43', 4419.63, true, '2026-11-20', '2026-12-20 12:00:00+00', 'C048-19', 49000019, 5019, 'r19c51', 5219.71, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C056-19', 57000019, 5819, 'r19c59', 6019.79),
    (220, 'r20c3', 420.24, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-20', 9000020, 1020, 'r20c11', 1220.32, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-20', 17000020, 1820, 'r20c19', 2020.40, false, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-20', 25000020, 2620, 'r20c27', 2820.48, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C032-20', 33000020, 3420, 'r20c35', 3620.56, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C040-20', 41000020, 4220, 'r20c43', 4420.64, false, '2026-11-21', '2026-12-21 12:00:00+00', 'C048-20', 49000020, 5020, 'r20c51', 5220.72, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C056-20', 57000020, 5820, 'r20c59', 6020.80),
    (221, 'r21c3', 421.25, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-21', 9000021, 1021, 'r21c11', 1221.33, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-21', 17000021, 1821, 'r21c19', 2021.41, true, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-21', 25000021, 2621, 'r21c27', 2821.49, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C032-21', 33000021, 3421, 'r21c35', 3621.57, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C040-21', 41000021, 4221, 'r21c43', 4421.65, true, '2026-11-22', '2026-12-22 12:00:00+00', 'C048-21', 49000021, 5021, 'r21c51', 5221.73, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C056-21', 57000021, 5821, 'r21c59', 6021.81),
    (222, 'r22c3', 422.26, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-22', 9000022, 1022, 'r22c11', 1222.34, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-22', 17000022, 1822, 'r22c19', 2022.42, false, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-22', 25000022, 2622, 'r22c27', 2822.50, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C032-22', 33000022, 3422, 'r22c35', 3622.58, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C040-22', 41000022, 4222, 'r22c43', 4422.66, false, '2026-11-23', '2026-12-23 12:00:00+00', 'C048-22', 49000022, 5022, 'r22c51', 5222.74, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C056-22', 57000022, 5822, 'r22c59', 6022.82),
    (223, 'r23c3', 423.27, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-23', 9000023, 1023, 'r23c11', 1223.35, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-23', 17000023, 1823, 'r23c19', 2023.43, true, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-23', 25000023, 2623, 'r23c27', 2823.51, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C032-23', 33000023, 3423, 'r23c35', 3623.59, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C040-23', 41000023, 4223, 'r23c43', 4423.67, true, '2026-11-24', '2026-12-24 12:00:00+00', 'C048-23', 49000023, 5023, 'r23c51', 5223.75, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C056-23', 57000023, 5823, 'r23c59', 6023.83),
    (224, 'r24c3', 424.28, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-24', 9000024, 1024, 'r24c11', 1224.36, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-24', 17000024, 1824, 'r24c19', 2024.44, false, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-24', 25000024, 2624, 'r24c27', 2824.52, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C032-24', 33000024, 3424, 'r24c35', 3624.60, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C040-24', 41000024, 4224, 'r24c43', 4424.68, false, '2026-11-25', '2026-12-25 12:00:00+00', 'C048-24', 49000024, 5024, 'r24c51', 5224.76, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C056-24', 57000024, 5824, 'r24c59', 6024.84),
    (225, 'r25c3', 425.29, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-25', 9000025, 1025, 'r25c11', 1225.37, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-25', 17000025, 1825, 'r25c19', 2025.45, true, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-25', 25000025, 2625, 'r25c27', 2825.53, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C032-25', 33000025, 3425, 'r25c35', 3625.61, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C040-25', 41000025, 4225, 'r25c43', 4425.69, true, '2026-11-26', '2026-12-26 12:00:00+00', 'C048-25', 49000025, 5025, 'r25c51', 5225.77, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C056-25', 57000025, 5825, 'r25c59', 6025.85),
    (226, 'r26c3', 426.30, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-26', 9000026, 1026, 'r26c11', 1226.38, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-26', 17000026, 1826, 'r26c19', 2026.46, false, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-26', 25000026, 2626, 'r26c27', 2826.54, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C032-26', 33000026, 3426, 'r26c35', 3626.62, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C040-26', 41000026, 4226, 'r26c43', 4426.70, false, '2026-11-27', '2026-12-27 12:00:00+00', 'C048-26', 49000026, 5026, 'r26c51', 5226.78, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C056-26', 57000026, 5826, 'r26c59', 6026.86),
    (227, 'r27c3', 427.31, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-27', 9000027, 1027, 'r27c11', 1227.39, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-27', 17000027, 1827, 'r27c19', 2027.47, true, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-27', 25000027, 2627, 'r27c27', 2827.55, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C032-27', 33000027, 3427, 'r27c35', 3627.63, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C040-27', 41000027, 4227, 'r27c43', 4427.71, true, '2026-11-01', '2026-12-01 12:00:00+00', 'C048-27', 49000027, 5027, 'r27c51', 5227.79, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C056-27', 57000027, 5827, 'r27c59', 6027.87),
    (228, 'r28c3', 428.32, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-28', 9000028, 1028, 'r28c11', 1228.40, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-28', 17000028, 1828, 'r28c19', 2028.48, false, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-28', 25000028, 2628, 'r28c27', 2828.56, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C032-28', 33000028, 3428, 'r28c35', 3628.64, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C040-28', 41000028, 4228, 'r28c43', 4428.72, false, '2026-11-02', '2026-12-02 12:00:00+00', 'C048-28', 49000028, 5028, 'r28c51', 5228.80, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C056-28', 57000028, 5828, 'r28c59', 6028.88),
    (229, 'r29c3', 429.33, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-29', 9000029, 1029, 'r29c11', 1229.41, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-29', 17000029, 1829, 'r29c19', 2029.49, true, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-29', 25000029, 2629, 'r29c27', 2829.57, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C032-29', 33000029, 3429, 'r29c35', 3629.65, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C040-29', 41000029, 4229, 'r29c43', 4429.73, true, '2026-11-03', '2026-12-03 12:00:00+00', 'C048-29', 49000029, 5029, 'r29c51', 5229.81, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C056-29', 57000029, 5829, 'r29c59', 6029.89),
    (230, 'r30c3', 430.34, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-30', 9000030, 1030, 'r30c11', 1230.42, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-30', 17000030, 1830, 'r30c19', 2030.50, false, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-30', 25000030, 2630, 'r30c27', 2830.58, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C032-30', 33000030, 3430, 'r30c35', 3630.66, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C040-30', 41000030, 4230, 'r30c43', 4430.74, false, '2026-11-04', '2026-12-04 12:00:00+00', 'C048-30', 49000030, 5030, 'r30c51', 5230.82, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C056-30', 57000030, 5830, 'r30c59', 6030.90),
    (231, 'r31c3', 431.35, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-31', 9000031, 1031, 'r31c11', 1231.43, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-31', 17000031, 1831, 'r31c19', 2031.51, true, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-31', 25000031, 2631, 'r31c27', 2831.59, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C032-31', 33000031, 3431, 'r31c35', 3631.67, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C040-31', 41000031, 4231, 'r31c43', 4431.75, true, '2026-11-05', '2026-12-05 12:00:00+00', 'C048-31', 49000031, 5031, 'r31c51', 5231.83, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C056-31', 57000031, 5831, 'r31c59', 6031.91),
    (232, 'r32c3', 432.36, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-32', 9000032, 1032, 'r32c11', 1232.44, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-32', 17000032, 1832, 'r32c19', 2032.52, false, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-32', 25000032, 2632, 'r32c27', 2832.60, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C032-32', 33000032, 3432, 'r32c35', 3632.68, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C040-32', 41000032, 4232, 'r32c43', 4432.76, false, '2026-11-06', '2026-12-06 12:00:00+00', 'C048-32', 49000032, 5032, 'r32c51', 5232.84, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C056-32', 57000032, 5832, 'r32c59', 6032.92),
    (233, 'r33c3', 433.37, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-33', 9000033, 1033, 'r33c11', 1233.45, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-33', 17000033, 1833, 'r33c19', 2033.53, true, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-33', 25000033, 2633, 'r33c27', 2833.61, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C032-33', 33000033, 3433, 'r33c35', 3633.69, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C040-33', 41000033, 4233, 'r33c43', 4433.77, true, '2026-11-07', '2026-12-07 12:00:00+00', 'C048-33', 49000033, 5033, 'r33c51', 5233.85, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C056-33', 57000033, 5833, 'r33c59', 6033.93),
    (234, 'r34c3', 434.38, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-34', 9000034, 1034, 'r34c11', 1234.46, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-34', 17000034, 1834, 'r34c19', 2034.54, false, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-34', 25000034, 2634, 'r34c27', 2834.62, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C032-34', 33000034, 3434, 'r34c35', 3634.70, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C040-34', 41000034, 4234, 'r34c43', 4434.78, false, '2026-11-08', '2026-12-08 12:00:00+00', 'C048-34', 49000034, 5034, 'r34c51', 5234.86, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C056-34', 57000034, 5834, 'r34c59', 6034.94),
    (235, 'r35c3', 435.39, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-35', 9000035, 1035, 'r35c11', 1235.47, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-35', 17000035, 1835, 'r35c19', 2035.55, true, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-35', 25000035, 2635, 'r35c27', 2835.63, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C032-35', 33000035, 3435, 'r35c35', 3635.71, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C040-35', 41000035, 4235, 'r35c43', 4435.79, true, '2026-11-09', '2026-12-09 12:00:00+00', 'C048-35', 49000035, 5035, 'r35c51', 5235.87, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C056-35', 57000035, 5835, 'r35c59', 6035.95),
    (236, 'r36c3', 436.40, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-36', 9000036, 1036, 'r36c11', 1236.48, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-36', 17000036, 1836, 'r36c19', 2036.56, false, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-36', 25000036, 2636, 'r36c27', 2836.64, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C032-36', 33000036, 3436, 'r36c35', 3636.72, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C040-36', 41000036, 4236, 'r36c43', 4436.80, false, '2026-11-10', '2026-12-10 12:00:00+00', 'C048-36', 49000036, 5036, 'r36c51', 5236.88, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C056-36', 57000036, 5836, 'r36c59', 6036.96),
    (237, 'r37c3', 437.41, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-37', 9000037, 1037, 'r37c11', 1237.49, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-37', 17000037, 1837, 'r37c19', 2037.57, true, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-37', 25000037, 2637, 'r37c27', 2837.65, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C032-37', 33000037, 3437, 'r37c35', 3637.73, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C040-37', 41000037, 4237, 'r37c43', 4437.81, true, '2026-11-11', '2026-12-11 12:00:00+00', 'C048-37', 49000037, 5037, 'r37c51', 5237.89, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C056-37', 57000037, 5837, 'r37c59', 6037.97),
    (238, 'r38c3', 438.42, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-38', 9000038, 1038, 'r38c11', 1238.50, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-38', 17000038, 1838, 'r38c19', 2038.58, false, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-38', 25000038, 2638, 'r38c27', 2838.66, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C032-38', 33000038, 3438, 'r38c35', 3638.74, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C040-38', 41000038, 4238, 'r38c43', 4438.82, false, '2026-11-12', '2026-12-12 12:00:00+00', 'C048-38', 49000038, 5038, 'r38c51', 5238.90, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C056-38', 57000038, 5838, 'r38c59', 6038.98),
    (239, 'r39c3', 439.43, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-39', 9000039, 1039, 'r39c11', 1239.51, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-39', 17000039, 1839, 'r39c19', 2039.59, true, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-39', 25000039, 2639, 'r39c27', 2839.67, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C032-39', 33000039, 3439, 'r39c35', 3639.75, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C040-39', 41000039, 4239, 'r39c43', 4439.83, true, '2026-11-13', '2026-12-13 12:00:00+00', 'C048-39', 49000039, 5039, 'r39c51', 5239.91, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C056-39', 57000039, 5839, 'r39c59', 6039.99),
    (240, 'r40c3', 440.44, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-40', 9000040, 1040, 'r40c11', 1240.52, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-40', 17000040, 1840, 'r40c19', 2040.60, false, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-40', 25000040, 2640, 'r40c27', 2840.68, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C032-40', 33000040, 3440, 'r40c35', 3640.76, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C040-40', 41000040, 4240, 'r40c43', 4440.84, false, '2026-11-14', '2026-12-14 12:00:00+00', 'C048-40', 49000040, 5040, 'r40c51', 5240.92, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C056-40', 57000040, 5840, 'r40c59', 6040.00),
    (241, 'r41c3', 441.45, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-41', 9000041, 1041, 'r41c11', 1241.53, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-41', 17000041, 1841, 'r41c19', 2041.61, true, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-41', 25000041, 2641, 'r41c27', 2841.69, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C032-41', 33000041, 3441, 'r41c35', 3641.77, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C040-41', 41000041, 4241, 'r41c43', 4441.85, true, '2026-11-15', '2026-12-15 12:00:00+00', 'C048-41', 49000041, 5041, 'r41c51', 5241.93, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C056-41', 57000041, 5841, 'r41c59', 6041.01),
    (242, 'r42c3', 442.46, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-42', 9000042, 1042, 'r42c11', 1242.54, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-42', 17000042, 1842, 'r42c19', 2042.62, false, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-42', 25000042, 2642, 'r42c27', 2842.70, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C032-42', 33000042, 3442, 'r42c35', 3642.78, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C040-42', 41000042, 4242, 'r42c43', 4442.86, false, '2026-11-16', '2026-12-16 12:00:00+00', 'C048-42', 49000042, 5042, 'r42c51', 5242.94, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C056-42', 57000042, 5842, 'r42c59', 6042.02),
    (243, 'r43c3', 443.47, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-43', 9000043, 1043, 'r43c11', 1243.55, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-43', 17000043, 1843, 'r43c19', 2043.63, true, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-43', 25000043, 2643, 'r43c27', 2843.71, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C032-43', 33000043, 3443, 'r43c35', 3643.79, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C040-43', 41000043, 4243, 'r43c43', 4443.87, true, '2026-11-17', '2026-12-17 12:00:00+00', 'C048-43', 49000043, 5043, 'r43c51', 5243.95, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C056-43', 57000043, 5843, 'r43c59', 6043.03),
    (244, 'r44c3', 444.48, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-44', 9000044, 1044, 'r44c11', 1244.56, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-44', 17000044, 1844, 'r44c19', 2044.64, false, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-44', 25000044, 2644, 'r44c27', 2844.72, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C032-44', 33000044, 3444, 'r44c35', 3644.80, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C040-44', 41000044, 4244, 'r44c43', 4444.88, false, '2026-11-18', '2026-12-18 12:00:00+00', 'C048-44', 49000044, 5044, 'r44c51', 5244.96, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C056-44', 57000044, 5844, 'r44c59', 6044.04),
    (245, 'r45c3', 445.49, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-45', 9000045, 1045, 'r45c11', 1245.57, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-45', 17000045, 1845, 'r45c19', 2045.65, true, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-45', 25000045, 2645, 'r45c27', 2845.73, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C032-45', 33000045, 3445, 'r45c35', 3645.81, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C040-45', 41000045, 4245, 'r45c43', 4445.89, true, '2026-11-19', '2026-12-19 12:00:00+00', 'C048-45', 49000045, 5045, 'r45c51', 5245.97, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C056-45', 57000045, 5845, 'r45c59', 6045.05),
    (246, 'r46c3', 446.50, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-46', 9000046, 1046, 'r46c11', 1246.58, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-46', 17000046, 1846, 'r46c19', 2046.66, false, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-46', 25000046, 2646, 'r46c27', 2846.74, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C032-46', 33000046, 3446, 'r46c35', 3646.82, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C040-46', 41000046, 4246, 'r46c43', 4446.90, false, '2026-11-20', '2026-12-20 12:00:00+00', 'C048-46', 49000046, 5046, 'r46c51', 5246.98, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C056-46', 57000046, 5846, 'r46c59', 6046.06),
    (247, 'r47c3', 447.51, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-47', 9000047, 1047, 'r47c11', 1247.59, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-47', 17000047, 1847, 'r47c19', 2047.67, true, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-47', 25000047, 2647, 'r47c27', 2847.75, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C032-47', 33000047, 3447, 'r47c35', 3647.83, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C040-47', 41000047, 4247, 'r47c43', 4447.91, true, '2026-11-21', '2026-12-21 12:00:00+00', 'C048-47', 49000047, 5047, 'r47c51', 5247.99, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C056-47', 57000047, 5847, 'r47c59', 6047.07),
    (248, 'r48c3', 448.52, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-48', 9000048, 1048, 'r48c11', 1248.60, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-48', 17000048, 1848, 'r48c19', 2048.68, false, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-48', 25000048, 2648, 'r48c27', 2848.76, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C032-48', 33000048, 3448, 'r48c35', 3648.84, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C040-48', 41000048, 4248, 'r48c43', 4448.92, false, '2026-11-22', '2026-12-22 12:00:00+00', 'C048-48', 49000048, 5048, 'r48c51', 5248.00, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C056-48', 57000048, 5848, 'r48c59', 6048.08),
    (249, 'r49c3', 449.53, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-49', 9000049, 1049, 'r49c11', 1249.61, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-49', 17000049, 1849, 'r49c19', 2049.69, true, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-49', 25000049, 2649, 'r49c27', 2849.77, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C032-49', 33000049, 3449, 'r49c35', 3649.85, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C040-49', 41000049, 4249, 'r49c43', 4449.93, true, '2026-11-23', '2026-12-23 12:00:00+00', 'C048-49', 49000049, 5049, 'r49c51', 5249.01, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C056-49', 57000049, 5849, 'r49c59', 6049.09),
    (250, 'r50c3', 450.54, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-50', 9000050, 1050, 'r50c11', 1250.62, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-50', 17000050, 1850, 'r50c19', 2050.70, false, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-50', 25000050, 2650, 'r50c27', 2850.78, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C032-50', 33000050, 3450, 'r50c35', 3650.86, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C040-50', 41000050, 4250, 'r50c43', 4450.94, false, '2026-11-24', '2026-12-24 12:00:00+00', 'C048-50', 49000050, 5050, 'r50c51', 5250.02, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C056-50', 57000050, 5850, 'r50c59', 6050.10),
    (251, 'r51c3', 451.55, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-51', 9000051, 1051, 'r51c11', 1251.63, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-51', 17000051, 1851, 'r51c19', 2051.71, true, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-51', 25000051, 2651, 'r51c27', 2851.79, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C032-51', 33000051, 3451, 'r51c35', 3651.87, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C040-51', 41000051, 4251, 'r51c43', 4451.95, true, '2026-11-25', '2026-12-25 12:00:00+00', 'C048-51', 49000051, 5051, 'r51c51', 5251.03, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C056-51', 57000051, 5851, 'r51c59', 6051.11),
    (252, 'r52c3', 452.56, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-52', 9000052, 1052, 'r52c11', 1252.64, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-52', 17000052, 1852, 'r52c19', 2052.72, false, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-52', 25000052, 2652, 'r52c27', 2852.80, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C032-52', 33000052, 3452, 'r52c35', 3652.88, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C040-52', 41000052, 4252, 'r52c43', 4452.96, false, '2026-11-26', '2026-12-26 12:00:00+00', 'C048-52', 49000052, 5052, 'r52c51', 5252.04, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C056-52', 57000052, 5852, 'r52c59', 6052.12),
    (253, 'r53c3', 453.57, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-53', 9000053, 1053, 'r53c11', 1253.65, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-53', 17000053, 1853, 'r53c19', 2053.73, true, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-53', 25000053, 2653, 'r53c27', 2853.81, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C032-53', 33000053, 3453, 'r53c35', 3653.89, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C040-53', 41000053, 4253, 'r53c43', 4453.97, true, '2026-11-27', '2026-12-27 12:00:00+00', 'C048-53', 49000053, 5053, 'r53c51', 5253.05, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C056-53', 57000053, 5853, 'r53c59', 6053.13),
    (254, 'r54c3', 454.58, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-54', 9000054, 1054, 'r54c11', 1254.66, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-54', 17000054, 1854, 'r54c19', 2054.74, false, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-54', 25000054, 2654, 'r54c27', 2854.82, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C032-54', 33000054, 3454, 'r54c35', 3654.90, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C040-54', 41000054, 4254, 'r54c43', 4454.98, false, '2026-11-01', '2026-12-01 12:00:00+00', 'C048-54', 49000054, 5054, 'r54c51', 5254.06, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C056-54', 57000054, 5854, 'r54c59', 6054.14),
    (255, 'r55c3', 455.59, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-55', 9000055, 1055, 'r55c11', 1255.67, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-55', 17000055, 1855, 'r55c19', 2055.75, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-55', 25000055, 2655, 'r55c27', 2855.83, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C032-55', 33000055, 3455, 'r55c35', 3655.91, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C040-55', 41000055, 4255, 'r55c43', 4455.99, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C048-55', 49000055, 5055, 'r55c51', 5255.07, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C056-55', 57000055, 5855, 'r55c59', 6055.15),
    (256, 'r56c3', 456.60, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-56', 9000056, 1056, 'r56c11', 1256.68, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-56', 17000056, 1856, 'r56c19', 2056.76, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-56', 25000056, 2656, 'r56c27', 2856.84, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C032-56', 33000056, 3456, 'r56c35', 3656.92, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C040-56', 41000056, 4256, 'r56c43', 4456.00, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C048-56', 49000056, 5056, 'r56c51', 5256.08, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C056-56', 57000056, 5856, 'r56c59', 6056.16),
    (257, 'r57c3', 457.61, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-57', 9000057, 1057, 'r57c11', 1257.69, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-57', 17000057, 1857, 'r57c19', 2057.77, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-57', 25000057, 2657, 'r57c27', 2857.85, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C032-57', 33000057, 3457, 'r57c35', 3657.93, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C040-57', 41000057, 4257, 'r57c43', 4457.01, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C048-57', 49000057, 5057, 'r57c51', 5257.09, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C056-57', 57000057, 5857, 'r57c59', 6057.17),
    (258, 'r58c3', 458.62, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-58', 9000058, 1058, 'r58c11', 1258.70, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-58', 17000058, 1858, 'r58c19', 2058.78, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-58', 25000058, 2658, 'r58c27', 2858.86, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C032-58', 33000058, 3458, 'r58c35', 3658.94, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C040-58', 41000058, 4258, 'r58c43', 4458.02, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C048-58', 49000058, 5058, 'r58c51', 5258.10, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C056-58', 57000058, 5858, 'r58c59', 6058.18),
    (259, 'r59c3', 459.63, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-59', 9000059, 1059, 'r59c11', 1259.71, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-59', 17000059, 1859, 'r59c19', 2059.79, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-59', 25000059, 2659, 'r59c27', 2859.87, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C032-59', 33000059, 3459, 'r59c35', 3659.95, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C040-59', 41000059, 4259, 'r59c43', 4459.03, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C048-59', 49000059, 5059, 'r59c51', 5259.11, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C056-59', 57000059, 5859, 'r59c59', 6059.19),
    (260, 'r60c3', 460.64, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-60', 9000060, 1060, 'r60c11', 1260.72, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-60', 17000060, 1860, 'r60c19', 2060.80, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-60', 25000060, 2660, 'r60c27', 2860.88, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C032-60', 33000060, 3460, 'r60c35', 3660.96, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C040-60', 41000060, 4260, 'r60c43', 4460.04, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C048-60', 49000060, 5060, 'r60c51', 5260.12, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C056-60', 57000060, 5860, 'r60c59', 6060.20),
    (261, 'r61c3', 461.65, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-61', 9000061, 1061, 'r61c11', 1261.73, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-61', 17000061, 1861, 'r61c19', 2061.81, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-61', 25000061, 2661, 'r61c27', 2861.89, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C032-61', 33000061, 3461, 'r61c35', 3661.97, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C040-61', 41000061, 4261, 'r61c43', 4461.05, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C048-61', 49000061, 5061, 'r61c51', 5261.13, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C056-61', 57000061, 5861, 'r61c59', 6061.21),
    (262, 'r62c3', 462.66, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-62', 9000062, 1062, 'r62c11', 1262.74, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-62', 17000062, 1862, 'r62c19', 2062.82, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-62', 25000062, 2662, 'r62c27', 2862.90, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C032-62', 33000062, 3462, 'r62c35', 3662.98, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C040-62', 41000062, 4262, 'r62c43', 4462.06, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C048-62', 49000062, 5062, 'r62c51', 5262.14, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C056-62', 57000062, 5862, 'r62c59', 6062.22),
    (263, 'r63c3', 463.67, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-63', 9000063, 1063, 'r63c11', 1263.75, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-63', 17000063, 1863, 'r63c19', 2063.83, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-63', 25000063, 2663, 'r63c27', 2863.91, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C032-63', 33000063, 3463, 'r63c35', 3663.99, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C040-63', 41000063, 4263, 'r63c43', 4463.07, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C048-63', 49000063, 5063, 'r63c51', 5263.15, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C056-63', 57000063, 5863, 'r63c59', 6063.23),
    (264, 'r64c3', 464.68, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-64', 9000064, 1064, 'r64c11', 1264.76, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-64', 17000064, 1864, 'r64c19', 2064.84, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-64', 25000064, 2664, 'r64c27', 2864.92, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C032-64', 33000064, 3464, 'r64c35', 3664.00, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C040-64', 41000064, 4264, 'r64c43', 4464.08, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C048-64', 49000064, 5064, 'r64c51', 5264.16, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C056-64', 57000064, 5864, 'r64c59', 6064.24),
    (265, 'r65c3', 465.69, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-65', 9000065, 1065, 'r65c11', 1265.77, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-65', 17000065, 1865, 'r65c19', 2065.85, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-65', 25000065, 2665, 'r65c27', 2865.93, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C032-65', 33000065, 3465, 'r65c35', 3665.01, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C040-65', 41000065, 4265, 'r65c43', 4465.09, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C048-65', 49000065, 5065, 'r65c51', 5265.17, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C056-65', 57000065, 5865, 'r65c59', 6065.25),
    (266, 'r66c3', 466.70, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-66', 9000066, 1066, 'r66c11', 1266.78, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-66', 17000066, 1866, 'r66c19', 2066.86, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-66', 25000066, 2666, 'r66c27', 2866.94, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C032-66', 33000066, 3466, 'r66c35', 3666.02, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C040-66', 41000066, 4266, 'r66c43', 4466.10, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C048-66', 49000066, 5066, 'r66c51', 5266.18, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C056-66', 57000066, 5866, 'r66c59', 6066.26),
    (267, 'r67c3', 467.71, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-67', 9000067, 1067, 'r67c11', 1267.79, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-67', 17000067, 1867, 'r67c19', 2067.87, true, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-67', 25000067, 2667, 'r67c27', 2867.95, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C032-67', 33000067, 3467, 'r67c35', 3667.03, true, '2026-03-14', '2026-04-14 12:00:00+00', 'C040-67', 41000067, 4267, 'r67c43', 4467.11, true, '2026-11-14', '2026-12-14 12:00:00+00', 'C048-67', 49000067, 5067, 'r67c51', 5267.19, true, '2026-07-14', '2026-08-14 12:00:00+00', 'C056-67', 57000067, 5867, 'r67c59', 6067.27),
    (268, 'r68c3', 468.72, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-68', 9000068, 1068, 'r68c11', 1268.80, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-68', 17000068, 1868, 'r68c19', 2068.88, false, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-68', 25000068, 2668, 'r68c27', 2868.96, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C032-68', 33000068, 3468, 'r68c35', 3668.04, false, '2026-03-15', '2026-04-15 12:00:00+00', 'C040-68', 41000068, 4268, 'r68c43', 4468.12, false, '2026-11-15', '2026-12-15 12:00:00+00', 'C048-68', 49000068, 5068, 'r68c51', 5268.20, false, '2026-07-15', '2026-08-15 12:00:00+00', 'C056-68', 57000068, 5868, 'r68c59', 6068.28),
    (269, 'r69c3', 469.73, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-69', 9000069, 1069, 'r69c11', 1269.81, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-69', 17000069, 1869, 'r69c19', 2069.89, true, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-69', 25000069, 2669, 'r69c27', 2869.97, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C032-69', 33000069, 3469, 'r69c35', 3669.05, true, '2026-03-16', '2026-04-16 12:00:00+00', 'C040-69', 41000069, 4269, 'r69c43', 4469.13, true, '2026-11-16', '2026-12-16 12:00:00+00', 'C048-69', 49000069, 5069, 'r69c51', 5269.21, true, '2026-07-16', '2026-08-16 12:00:00+00', 'C056-69', 57000069, 5869, 'r69c59', 6069.29),
    (270, 'r70c3', 470.74, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-70', 9000070, 1070, 'r70c11', 1270.82, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-70', 17000070, 1870, 'r70c19', 2070.90, false, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-70', 25000070, 2670, 'r70c27', 2870.98, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C032-70', 33000070, 3470, 'r70c35', 3670.06, false, '2026-03-17', '2026-04-17 12:00:00+00', 'C040-70', 41000070, 4270, 'r70c43', 4470.14, false, '2026-11-17', '2026-12-17 12:00:00+00', 'C048-70', 49000070, 5070, 'r70c51', 5270.22, false, '2026-07-17', '2026-08-17 12:00:00+00', 'C056-70', 57000070, 5870, 'r70c59', 6070.30),
    (271, 'r71c3', 471.75, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-71', 9000071, 1071, 'r71c11', 1271.83, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-71', 17000071, 1871, 'r71c19', 2071.91, true, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-71', 25000071, 2671, 'r71c27', 2871.99, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C032-71', 33000071, 3471, 'r71c35', 3671.07, true, '2026-03-18', '2026-04-18 12:00:00+00', 'C040-71', 41000071, 4271, 'r71c43', 4471.15, true, '2026-11-18', '2026-12-18 12:00:00+00', 'C048-71', 49000071, 5071, 'r71c51', 5271.23, true, '2026-07-18', '2026-08-18 12:00:00+00', 'C056-71', 57000071, 5871, 'r71c59', 6071.31),
    (272, 'r72c3', 472.76, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-72', 9000072, 1072, 'r72c11', 1272.84, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-72', 17000072, 1872, 'r72c19', 2072.92, false, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-72', 25000072, 2672, 'r72c27', 2872.00, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C032-72', 33000072, 3472, 'r72c35', 3672.08, false, '2026-03-19', '2026-04-19 12:00:00+00', 'C040-72', 41000072, 4272, 'r72c43', 4472.16, false, '2026-11-19', '2026-12-19 12:00:00+00', 'C048-72', 49000072, 5072, 'r72c51', 5272.24, false, '2026-07-19', '2026-08-19 12:00:00+00', 'C056-72', 57000072, 5872, 'r72c59', 6072.32),
    (273, 'r73c3', 473.77, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-73', 9000073, 1073, 'r73c11', 1273.85, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-73', 17000073, 1873, 'r73c19', 2073.93, true, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-73', 25000073, 2673, 'r73c27', 2873.01, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C032-73', 33000073, 3473, 'r73c35', 3673.09, true, '2026-03-20', '2026-04-20 12:00:00+00', 'C040-73', 41000073, 4273, 'r73c43', 4473.17, true, '2026-11-20', '2026-12-20 12:00:00+00', 'C048-73', 49000073, 5073, 'r73c51', 5273.25, true, '2026-07-20', '2026-08-20 12:00:00+00', 'C056-73', 57000073, 5873, 'r73c59', 6073.33),
    (274, 'r74c3', 474.78, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-74', 9000074, 1074, 'r74c11', 1274.86, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-74', 17000074, 1874, 'r74c19', 2074.94, false, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-74', 25000074, 2674, 'r74c27', 2874.02, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C032-74', 33000074, 3474, 'r74c35', 3674.10, false, '2026-03-21', '2026-04-21 12:00:00+00', 'C040-74', 41000074, 4274, 'r74c43', 4474.18, false, '2026-11-21', '2026-12-21 12:00:00+00', 'C048-74', 49000074, 5074, 'r74c51', 5274.26, false, '2026-07-21', '2026-08-21 12:00:00+00', 'C056-74', 57000074, 5874, 'r74c59', 6074.34),
    (275, 'r75c3', 475.79, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-75', 9000075, 1075, 'r75c11', 1275.87, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-75', 17000075, 1875, 'r75c19', 2075.95, true, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-75', 25000075, 2675, 'r75c27', 2875.03, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C032-75', 33000075, 3475, 'r75c35', 3675.11, true, '2026-03-22', '2026-04-22 12:00:00+00', 'C040-75', 41000075, 4275, 'r75c43', 4475.19, true, '2026-11-22', '2026-12-22 12:00:00+00', 'C048-75', 49000075, 5075, 'r75c51', 5275.27, true, '2026-07-22', '2026-08-22 12:00:00+00', 'C056-75', 57000075, 5875, 'r75c59', 6075.35),
    (276, 'r76c3', 476.80, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-76', 9000076, 1076, 'r76c11', 1276.88, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-76', 17000076, 1876, 'r76c19', 2076.96, false, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-76', 25000076, 2676, 'r76c27', 2876.04, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C032-76', 33000076, 3476, 'r76c35', 3676.12, false, '2026-03-23', '2026-04-23 12:00:00+00', 'C040-76', 41000076, 4276, 'r76c43', 4476.20, false, '2026-11-23', '2026-12-23 12:00:00+00', 'C048-76', 49000076, 5076, 'r76c51', 5276.28, false, '2026-07-23', '2026-08-23 12:00:00+00', 'C056-76', 57000076, 5876, 'r76c59', 6076.36),
    (277, 'r77c3', 477.81, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-77', 9000077, 1077, 'r77c11', 1277.89, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-77', 17000077, 1877, 'r77c19', 2077.97, true, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-77', 25000077, 2677, 'r77c27', 2877.05, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C032-77', 33000077, 3477, 'r77c35', 3677.13, true, '2026-03-24', '2026-04-24 12:00:00+00', 'C040-77', 41000077, 4277, 'r77c43', 4477.21, true, '2026-11-24', '2026-12-24 12:00:00+00', 'C048-77', 49000077, 5077, 'r77c51', 5277.29, true, '2026-07-24', '2026-08-24 12:00:00+00', 'C056-77', 57000077, 5877, 'r77c59', 6077.37),
    (278, 'r78c3', 478.82, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-78', 9000078, 1078, 'r78c11', 1278.90, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-78', 17000078, 1878, 'r78c19', 2078.98, false, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-78', 25000078, 2678, 'r78c27', 2878.06, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C032-78', 33000078, 3478, 'r78c35', 3678.14, false, '2026-03-25', '2026-04-25 12:00:00+00', 'C040-78', 41000078, 4278, 'r78c43', 4478.22, false, '2026-11-25', '2026-12-25 12:00:00+00', 'C048-78', 49000078, 5078, 'r78c51', 5278.30, false, '2026-07-25', '2026-08-25 12:00:00+00', 'C056-78', 57000078, 5878, 'r78c59', 6078.38),
    (279, 'r79c3', 479.83, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-79', 9000079, 1079, 'r79c11', 1279.91, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-79', 17000079, 1879, 'r79c19', 2079.99, true, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-79', 25000079, 2679, 'r79c27', 2879.07, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C032-79', 33000079, 3479, 'r79c35', 3679.15, true, '2026-03-26', '2026-04-26 12:00:00+00', 'C040-79', 41000079, 4279, 'r79c43', 4479.23, true, '2026-11-26', '2026-12-26 12:00:00+00', 'C048-79', 49000079, 5079, 'r79c51', 5279.31, true, '2026-07-26', '2026-08-26 12:00:00+00', 'C056-79', 57000079, 5879, 'r79c59', 6079.39),
    (280, 'r80c3', 480.84, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-80', 9000080, 1080, 'r80c11', 1280.92, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-80', 17000080, 1880, 'r80c19', 2080.00, false, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-80', 25000080, 2680, 'r80c27', 2880.08, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C032-80', 33000080, 3480, 'r80c35', 3680.16, false, '2026-03-27', '2026-04-27 12:00:00+00', 'C040-80', 41000080, 4280, 'r80c43', 4480.24, false, '2026-11-27', '2026-12-27 12:00:00+00', 'C048-80', 49000080, 5080, 'r80c51', 5280.32, false, '2026-07-27', '2026-08-27 12:00:00+00', 'C056-80', 57000080, 5880, 'r80c59', 6080.40),
    (281, 'r81c3', 481.85, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-81', 9000081, 1081, 'r81c11', 1281.93, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-81', 17000081, 1881, 'r81c19', 2081.01, true, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-81', 25000081, 2681, 'r81c27', 2881.09, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C032-81', 33000081, 3481, 'r81c35', 3681.17, true, '2026-03-01', '2026-04-01 12:00:00+00', 'C040-81', 41000081, 4281, 'r81c43', 4481.25, true, '2026-11-01', '2026-12-01 12:00:00+00', 'C048-81', 49000081, 5081, 'r81c51', 5281.33, true, '2026-07-01', '2026-08-01 12:00:00+00', 'C056-81', 57000081, 5881, 'r81c59', 6081.41),
    (282, 'r82c3', 482.86, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-82', 9000082, 1082, 'r82c11', 1282.94, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-82', 17000082, 1882, 'r82c19', 2082.02, false, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-82', 25000082, 2682, 'r82c27', 2882.10, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C032-82', 33000082, 3482, 'r82c35', 3682.18, false, '2026-03-02', '2026-04-02 12:00:00+00', 'C040-82', 41000082, 4282, 'r82c43', 4482.26, false, '2026-11-02', '2026-12-02 12:00:00+00', 'C048-82', 49000082, 5082, 'r82c51', 5282.34, false, '2026-07-02', '2026-08-02 12:00:00+00', 'C056-82', 57000082, 5882, 'r82c59', 6082.42),
    (283, 'r83c3', 483.87, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-83', 9000083, 1083, 'r83c11', 1283.95, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-83', 17000083, 1883, 'r83c19', 2083.03, true, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-83', 25000083, 2683, 'r83c27', 2883.11, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C032-83', 33000083, 3483, 'r83c35', 3683.19, true, '2026-03-03', '2026-04-03 12:00:00+00', 'C040-83', 41000083, 4283, 'r83c43', 4483.27, true, '2026-11-03', '2026-12-03 12:00:00+00', 'C048-83', 49000083, 5083, 'r83c51', 5283.35, true, '2026-07-03', '2026-08-03 12:00:00+00', 'C056-83', 57000083, 5883, 'r83c59', 6083.43),
    (284, 'r84c3', 484.88, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-84', 9000084, 1084, 'r84c11', 1284.96, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-84', 17000084, 1884, 'r84c19', 2084.04, false, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-84', 25000084, 2684, 'r84c27', 2884.12, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C032-84', 33000084, 3484, 'r84c35', 3684.20, false, '2026-03-04', '2026-04-04 12:00:00+00', 'C040-84', 41000084, 4284, 'r84c43', 4484.28, false, '2026-11-04', '2026-12-04 12:00:00+00', 'C048-84', 49000084, 5084, 'r84c51', 5284.36, false, '2026-07-04', '2026-08-04 12:00:00+00', 'C056-84', 57000084, 5884, 'r84c59', 6084.44),
    (285, 'r85c3', 485.89, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-85', 9000085, 1085, 'r85c11', 1285.97, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-85', 17000085, 1885, 'r85c19', 2085.05, true, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-85', 25000085, 2685, 'r85c27', 2885.13, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C032-85', 33000085, 3485, 'r85c35', 3685.21, true, '2026-03-05', '2026-04-05 12:00:00+00', 'C040-85', 41000085, 4285, 'r85c43', 4485.29, true, '2026-11-05', '2026-12-05 12:00:00+00', 'C048-85', 49000085, 5085, 'r85c51', 5285.37, true, '2026-07-05', '2026-08-05 12:00:00+00', 'C056-85', 57000085, 5885, 'r85c59', 6085.45),
    (286, 'r86c3', 486.90, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-86', 9000086, 1086, 'r86c11', 1286.98, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-86', 17000086, 1886, 'r86c19', 2086.06, false, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-86', 25000086, 2686, 'r86c27', 2886.14, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C032-86', 33000086, 3486, 'r86c35', 3686.22, false, '2026-03-06', '2026-04-06 12:00:00+00', 'C040-86', 41000086, 4286, 'r86c43', 4486.30, false, '2026-11-06', '2026-12-06 12:00:00+00', 'C048-86', 49000086, 5086, 'r86c51', 5286.38, false, '2026-07-06', '2026-08-06 12:00:00+00', 'C056-86', 57000086, 5886, 'r86c59', 6086.46),
    (287, 'r87c3', 487.91, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-87', 9000087, 1087, 'r87c11', 1287.99, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-87', 17000087, 1887, 'r87c19', 2087.07, true, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-87', 25000087, 2687, 'r87c27', 2887.15, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C032-87', 33000087, 3487, 'r87c35', 3687.23, true, '2026-03-07', '2026-04-07 12:00:00+00', 'C040-87', 41000087, 4287, 'r87c43', 4487.31, true, '2026-11-07', '2026-12-07 12:00:00+00', 'C048-87', 49000087, 5087, 'r87c51', 5287.39, true, '2026-07-07', '2026-08-07 12:00:00+00', 'C056-87', 57000087, 5887, 'r87c59', 6087.47),
    (288, 'r88c3', 488.92, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-88', 9000088, 1088, 'r88c11', 1288.00, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-88', 17000088, 1888, 'r88c19', 2088.08, false, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-88', 25000088, 2688, 'r88c27', 2888.16, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C032-88', 33000088, 3488, 'r88c35', 3688.24, false, '2026-03-08', '2026-04-08 12:00:00+00', 'C040-88', 41000088, 4288, 'r88c43', 4488.32, false, '2026-11-08', '2026-12-08 12:00:00+00', 'C048-88', 49000088, 5088, 'r88c51', 5288.40, false, '2026-07-08', '2026-08-08 12:00:00+00', 'C056-88', 57000088, 5888, 'r88c59', 6088.48),
    (289, 'r89c3', 489.93, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-89', 9000089, 1089, 'r89c11', 1289.01, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-89', 17000089, 1889, 'r89c19', 2089.09, true, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-89', 25000089, 2689, 'r89c27', 2889.17, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C032-89', 33000089, 3489, 'r89c35', 3689.25, true, '2026-03-09', '2026-04-09 12:00:00+00', 'C040-89', 41000089, 4289, 'r89c43', 4489.33, true, '2026-11-09', '2026-12-09 12:00:00+00', 'C048-89', 49000089, 5089, 'r89c51', 5289.41, true, '2026-07-09', '2026-08-09 12:00:00+00', 'C056-89', 57000089, 5889, 'r89c59', 6089.49),
    (290, 'r90c3', 490.94, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-90', 9000090, 1090, 'r90c11', 1290.02, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-90', 17000090, 1890, 'r90c19', 2090.10, false, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-90', 25000090, 2690, 'r90c27', 2890.18, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C032-90', 33000090, 3490, 'r90c35', 3690.26, false, '2026-03-10', '2026-04-10 12:00:00+00', 'C040-90', 41000090, 4290, 'r90c43', 4490.34, false, '2026-11-10', '2026-12-10 12:00:00+00', 'C048-90', 49000090, 5090, 'r90c51', 5290.42, false, '2026-07-10', '2026-08-10 12:00:00+00', 'C056-90', 57000090, 5890, 'r90c59', 6090.50),
    (291, 'r91c3', 491.95, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-91', 9000091, 1091, 'r91c11', 1291.03, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-91', 17000091, 1891, 'r91c19', 2091.11, true, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-91', 25000091, 2691, 'r91c27', 2891.19, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C032-91', 33000091, 3491, 'r91c35', 3691.27, true, '2026-03-11', '2026-04-11 12:00:00+00', 'C040-91', 41000091, 4291, 'r91c43', 4491.35, true, '2026-11-11', '2026-12-11 12:00:00+00', 'C048-91', 49000091, 5091, 'r91c51', 5291.43, true, '2026-07-11', '2026-08-11 12:00:00+00', 'C056-91', 57000091, 5891, 'r91c59', 6091.51),
    (292, 'r92c3', 492.96, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-92', 9000092, 1092, 'r92c11', 1292.04, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-92', 17000092, 1892, 'r92c19', 2092.12, false, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-92', 25000092, 2692, 'r92c27', 2892.20, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C032-92', 33000092, 3492, 'r92c35', 3692.28, false, '2026-03-12', '2026-04-12 12:00:00+00', 'C040-92', 41000092, 4292, 'r92c43', 4492.36, false, '2026-11-12', '2026-12-12 12:00:00+00', 'C048-92', 49000092, 5092, 'r92c51', 5292.44, false, '2026-07-12', '2026-08-12 12:00:00+00', 'C056-92', 57000092, 5892, 'r92c59', 6092.52),
    (293, 'r93c3', 493.97, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-93', 9000093, 1093, 'r93c11', 1293.05, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-93', 17000093, 1893, 'r93c19', 2093.13, true, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-93', 25000093, 2693, 'r93c27', 2893.21, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C032-93', 33000093, 3493, 'r93c35', 3693.29, true, '2026-03-13', '2026-04-13 12:00:00+00', 'C040-93', 41000093, 4293, 'r93c43', 4493.37, true, '2026-11-13', '2026-12-13 12:00:00+00', 'C048-93', 49000093, 5093, 'r93c51', 5293.45, true, '2026-07-13', '2026-08-13 12:00:00+00', 'C056-93', 57000093, 5893, 'r93c59', 6093.53),
    (294, 'r94c3', 494.98, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C008-94', 9000094, 1094, 'r94c11', 1294.06, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C016-94', 17000094, 1894, 'r94c19', 2094.14, false, '2026-11-14', '2026-12-14 12:00:00+00', 'C024-94', 25000094, 2694, 'r94c27', 2894.22, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C032-94', 33000094, 3494, 'r94c35', 3694.30, false, '2026-03-14', '2026-04-14 12:00:00+00', 'C040-94', 41000094, 4294, 'r94c43', 4494.38, false, '2026-11-14', '2026-12-14 12:00:00+00', 'C048-94', 49000094, 5094, 'r94c51', 5294.46, false, '2026-07-14', '2026-08-14 12:00:00+00', 'C056-94', 57000094, 5894, 'r94c59', 6094.54),
    (295, 'r95c3', 495.99, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C008-95', 9000095, 1095, 'r95c11', 1295.07, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C016-95', 17000095, 1895, 'r95c19', 2095.15, true, '2026-11-15', '2026-12-15 12:00:00+00', 'C024-95', 25000095, 2695, 'r95c27', 2895.23, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C032-95', 33000095, 3495, 'r95c35', 3695.31, true, '2026-03-15', '2026-04-15 12:00:00+00', 'C040-95', 41000095, 4295, 'r95c43', 4495.39, true, '2026-11-15', '2026-12-15 12:00:00+00', 'C048-95', 49000095, 5095, 'r95c51', 5295.47, true, '2026-07-15', '2026-08-15 12:00:00+00', 'C056-95', 57000095, 5895, 'r95c59', 6095.55),
    (296, 'r96c3', 496.00, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C008-96', 9000096, 1096, 'r96c11', 1296.08, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C016-96', 17000096, 1896, 'r96c19', 2096.16, false, '2026-11-16', '2026-12-16 12:00:00+00', 'C024-96', 25000096, 2696, 'r96c27', 2896.24, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C032-96', 33000096, 3496, 'r96c35', 3696.32, false, '2026-03-16', '2026-04-16 12:00:00+00', 'C040-96', 41000096, 4296, 'r96c43', 4496.40, false, '2026-11-16', '2026-12-16 12:00:00+00', 'C048-96', 49000096, 5096, 'r96c51', 5296.48, false, '2026-07-16', '2026-08-16 12:00:00+00', 'C056-96', 57000096, 5896, 'r96c59', 6096.56),
    (297, 'r97c3', 497.01, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C008-97', 9000097, 1097, 'r97c11', 1297.09, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C016-97', 17000097, 1897, 'r97c19', 2097.17, true, '2026-11-17', '2026-12-17 12:00:00+00', 'C024-97', 25000097, 2697, 'r97c27', 2897.25, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C032-97', 33000097, 3497, 'r97c35', 3697.33, true, '2026-03-17', '2026-04-17 12:00:00+00', 'C040-97', 41000097, 4297, 'r97c43', 4497.41, true, '2026-11-17', '2026-12-17 12:00:00+00', 'C048-97', 49000097, 5097, 'r97c51', 5297.49, true, '2026-07-17', '2026-08-17 12:00:00+00', 'C056-97', 57000097, 5897, 'r97c59', 6097.57),
    (298, 'r98c3', 498.02, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C008-98', 9000098, 1098, 'r98c11', 1298.10, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C016-98', 17000098, 1898, 'r98c19', 2098.18, false, '2026-11-18', '2026-12-18 12:00:00+00', 'C024-98', 25000098, 2698, 'r98c27', 2898.26, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C032-98', 33000098, 3498, 'r98c35', 3698.34, false, '2026-03-18', '2026-04-18 12:00:00+00', 'C040-98', 41000098, 4298, 'r98c43', 4498.42, false, '2026-11-18', '2026-12-18 12:00:00+00', 'C048-98', 49000098, 5098, 'r98c51', 5298.50, false, '2026-07-18', '2026-08-18 12:00:00+00', 'C056-98', 57000098, 5898, 'r98c59', 6098.58),
    (299, 'r99c3', 499.03, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C008-99', 9000099, 1099, 'r99c11', 1299.11, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C016-99', 17000099, 1899, 'r99c19', 2099.19, true, '2026-11-19', '2026-12-19 12:00:00+00', 'C024-99', 25000099, 2699, 'r99c27', 2899.27, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C032-99', 33000099, 3499, 'r99c35', 3699.35, true, '2026-03-19', '2026-04-19 12:00:00+00', 'C040-99', 41000099, 4299, 'r99c43', 4499.43, true, '2026-11-19', '2026-12-19 12:00:00+00', 'C048-99', 49000099, 5099, 'r99c51', 5299.51, true, '2026-07-19', '2026-08-19 12:00:00+00', 'C056-99', 57000099, 5899, 'r99c59', 6099.59),
    (300, 'r100c3', 4100.04, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C008-100', 9000100, 1100, 'r100c11', 12100.12, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C016-100', 17000100, 1900, 'r100c19', 20100.20, false, '2026-11-20', '2026-12-20 12:00:00+00', 'C024-100', 25000100, 2700, 'r100c27', 28100.28, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C032-100', 33000100, 3500, 'r100c35', 36100.36, false, '2026-03-20', '2026-04-20 12:00:00+00', 'C040-100', 41000100, 4300, 'r100c43', 44100.44, false, '2026-11-20', '2026-12-20 12:00:00+00', 'C048-100', 49000100, 5100, 'r100c51', 52100.52, false, '2026-07-20', '2026-08-20 12:00:00+00', 'C056-100', 57000100, 5900, 'r100c59', 60100.60),
    (301, 'r101c3', 4101.05, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C008-101', 9000101, 1101, 'r101c11', 12101.13, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C016-101', 17000101, 1901, 'r101c19', 20101.21, true, '2026-11-21', '2026-12-21 12:00:00+00', 'C024-101', 25000101, 2701, 'r101c27', 28101.29, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C032-101', 33000101, 3501, 'r101c35', 36101.37, true, '2026-03-21', '2026-04-21 12:00:00+00', 'C040-101', 41000101, 4301, 'r101c43', 44101.45, true, '2026-11-21', '2026-12-21 12:00:00+00', 'C048-101', 49000101, 5101, 'r101c51', 52101.53, true, '2026-07-21', '2026-08-21 12:00:00+00', 'C056-101', 57000101, 5901, 'r101c59', 60101.61),
    (302, 'r102c3', 4102.06, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C008-102', 9000102, 1102, 'r102c11', 12102.14, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C016-102', 17000102, 1902, 'r102c19', 20102.22, false, '2026-11-22', '2026-12-22 12:00:00+00', 'C024-102', 25000102, 2702, 'r102c27', 28102.30, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C032-102', 33000102, 3502, 'r102c35', 36102.38, false, '2026-03-22', '2026-04-22 12:00:00+00', 'C040-102', 41000102, 4302, 'r102c43', 44102.46, false, '2026-11-22', '2026-12-22 12:00:00+00', 'C048-102', 49000102, 5102, 'r102c51', 52102.54, false, '2026-07-22', '2026-08-22 12:00:00+00', 'C056-102', 57000102, 5902, 'r102c59', 60102.62),
    (303, 'r103c3', 4103.07, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C008-103', 9000103, 1103, 'r103c11', 12103.15, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C016-103', 17000103, 1903, 'r103c19', 20103.23, true, '2026-11-23', '2026-12-23 12:00:00+00', 'C024-103', 25000103, 2703, 'r103c27', 28103.31, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C032-103', 33000103, 3503, 'r103c35', 36103.39, true, '2026-03-23', '2026-04-23 12:00:00+00', 'C040-103', 41000103, 4303, 'r103c43', 44103.47, true, '2026-11-23', '2026-12-23 12:00:00+00', 'C048-103', 49000103, 5103, 'r103c51', 52103.55, true, '2026-07-23', '2026-08-23 12:00:00+00', 'C056-103', 57000103, 5903, 'r103c59', 60103.63),
    (304, 'r104c3', 4104.08, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C008-104', 9000104, 1104, 'r104c11', 12104.16, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C016-104', 17000104, 1904, 'r104c19', 20104.24, false, '2026-11-24', '2026-12-24 12:00:00+00', 'C024-104', 25000104, 2704, 'r104c27', 28104.32, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C032-104', 33000104, 3504, 'r104c35', 36104.40, false, '2026-03-24', '2026-04-24 12:00:00+00', 'C040-104', 41000104, 4304, 'r104c43', 44104.48, false, '2026-11-24', '2026-12-24 12:00:00+00', 'C048-104', 49000104, 5104, 'r104c51', 52104.56, false, '2026-07-24', '2026-08-24 12:00:00+00', 'C056-104', 57000104, 5904, 'r104c59', 60104.64),
    (305, 'r105c3', 4105.09, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C008-105', 9000105, 1105, 'r105c11', 12105.17, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C016-105', 17000105, 1905, 'r105c19', 20105.25, true, '2026-11-25', '2026-12-25 12:00:00+00', 'C024-105', 25000105, 2705, 'r105c27', 28105.33, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C032-105', 33000105, 3505, 'r105c35', 36105.41, true, '2026-03-25', '2026-04-25 12:00:00+00', 'C040-105', 41000105, 4305, 'r105c43', 44105.49, true, '2026-11-25', '2026-12-25 12:00:00+00', 'C048-105', 49000105, 5105, 'r105c51', 52105.57, true, '2026-07-25', '2026-08-25 12:00:00+00', 'C056-105', 57000105, 5905, 'r105c59', 60105.65),
    (306, 'r106c3', 4106.10, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C008-106', 9000106, 1106, 'r106c11', 12106.18, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C016-106', 17000106, 1906, 'r106c19', 20106.26, false, '2026-11-26', '2026-12-26 12:00:00+00', 'C024-106', 25000106, 2706, 'r106c27', 28106.34, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C032-106', 33000106, 3506, 'r106c35', 36106.42, false, '2026-03-26', '2026-04-26 12:00:00+00', 'C040-106', 41000106, 4306, 'r106c43', 44106.50, false, '2026-11-26', '2026-12-26 12:00:00+00', 'C048-106', 49000106, 5106, 'r106c51', 52106.58, false, '2026-07-26', '2026-08-26 12:00:00+00', 'C056-106', 57000106, 5906, 'r106c59', 60106.66),
    (307, 'r107c3', 4107.11, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C008-107', 9000107, 1107, 'r107c11', 12107.19, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C016-107', 17000107, 1907, 'r107c19', 20107.27, true, '2026-11-27', '2026-12-27 12:00:00+00', 'C024-107', 25000107, 2707, 'r107c27', 28107.35, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C032-107', 33000107, 3507, 'r107c35', 36107.43, true, '2026-03-27', '2026-04-27 12:00:00+00', 'C040-107', 41000107, 4307, 'r107c43', 44107.51, true, '2026-11-27', '2026-12-27 12:00:00+00', 'C048-107', 49000107, 5107, 'r107c51', 52107.59, true, '2026-07-27', '2026-08-27 12:00:00+00', 'C056-107', 57000107, 5907, 'r107c59', 60107.67),
    (308, 'r108c3', 4108.12, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C008-108', 9000108, 1108, 'r108c11', 12108.20, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C016-108', 17000108, 1908, 'r108c19', 20108.28, false, '2026-11-01', '2026-12-01 12:00:00+00', 'C024-108', 25000108, 2708, 'r108c27', 28108.36, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C032-108', 33000108, 3508, 'r108c35', 36108.44, false, '2026-03-01', '2026-04-01 12:00:00+00', 'C040-108', 41000108, 4308, 'r108c43', 44108.52, false, '2026-11-01', '2026-12-01 12:00:00+00', 'C048-108', 49000108, 5108, 'r108c51', 52108.60, false, '2026-07-01', '2026-08-01 12:00:00+00', 'C056-108', 57000108, 5908, 'r108c59', 60108.68),
    (309, 'r109c3', 4109.13, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C008-109', 9000109, 1109, 'r109c11', 12109.21, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C016-109', 17000109, 1909, 'r109c19', 20109.29, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C024-109', 25000109, 2709, 'r109c27', 28109.37, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C032-109', 33000109, 3509, 'r109c35', 36109.45, true, '2026-03-02', '2026-04-02 12:00:00+00', 'C040-109', 41000109, 4309, 'r109c43', 44109.53, true, '2026-11-02', '2026-12-02 12:00:00+00', 'C048-109', 49000109, 5109, 'r109c51', 52109.61, true, '2026-07-02', '2026-08-02 12:00:00+00', 'C056-109', 57000109, 5909, 'r109c59', 60109.69),
    (310, 'r110c3', 4110.14, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C008-110', 9000110, 1110, 'r110c11', 12110.22, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C016-110', 17000110, 1910, 'r110c19', 20110.30, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C024-110', 25000110, 2710, 'r110c27', 28110.38, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C032-110', 33000110, 3510, 'r110c35', 36110.46, false, '2026-03-03', '2026-04-03 12:00:00+00', 'C040-110', 41000110, 4310, 'r110c43', 44110.54, false, '2026-11-03', '2026-12-03 12:00:00+00', 'C048-110', 49000110, 5110, 'r110c51', 52110.62, false, '2026-07-03', '2026-08-03 12:00:00+00', 'C056-110', 57000110, 5910, 'r110c59', 60110.70),
    (311, 'r111c3', 4111.15, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C008-111', 9000111, 1111, 'r111c11', 12111.23, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C016-111', 17000111, 1911, 'r111c19', 20111.31, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C024-111', 25000111, 2711, 'r111c27', 28111.39, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C032-111', 33000111, 3511, 'r111c35', 36111.47, true, '2026-03-04', '2026-04-04 12:00:00+00', 'C040-111', 41000111, 4311, 'r111c43', 44111.55, true, '2026-11-04', '2026-12-04 12:00:00+00', 'C048-111', 49000111, 5111, 'r111c51', 52111.63, true, '2026-07-04', '2026-08-04 12:00:00+00', 'C056-111', 57000111, 5911, 'r111c59', 60111.71),
    (312, 'r112c3', 4112.16, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C008-112', 9000112, 1112, 'r112c11', 12112.24, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C016-112', 17000112, 1912, 'r112c19', 20112.32, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C024-112', 25000112, 2712, 'r112c27', 28112.40, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C032-112', 33000112, 3512, 'r112c35', 36112.48, false, '2026-03-05', '2026-04-05 12:00:00+00', 'C040-112', 41000112, 4312, 'r112c43', 44112.56, false, '2026-11-05', '2026-12-05 12:00:00+00', 'C048-112', 49000112, 5112, 'r112c51', 52112.64, false, '2026-07-05', '2026-08-05 12:00:00+00', 'C056-112', 57000112, 5912, 'r112c59', 60112.72),
    (313, 'r113c3', 4113.17, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C008-113', 9000113, 1113, 'r113c11', 12113.25, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C016-113', 17000113, 1913, 'r113c19', 20113.33, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C024-113', 25000113, 2713, 'r113c27', 28113.41, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C032-113', 33000113, 3513, 'r113c35', 36113.49, true, '2026-03-06', '2026-04-06 12:00:00+00', 'C040-113', 41000113, 4313, 'r113c43', 44113.57, true, '2026-11-06', '2026-12-06 12:00:00+00', 'C048-113', 49000113, 5113, 'r113c51', 52113.65, true, '2026-07-06', '2026-08-06 12:00:00+00', 'C056-113', 57000113, 5913, 'r113c59', 60113.73),
    (314, 'r114c3', 4114.18, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C008-114', 9000114, 1114, 'r114c11', 12114.26, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C016-114', 17000114, 1914, 'r114c19', 20114.34, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C024-114', 25000114, 2714, 'r114c27', 28114.42, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C032-114', 33000114, 3514, 'r114c35', 36114.50, false, '2026-03-07', '2026-04-07 12:00:00+00', 'C040-114', 41000114, 4314, 'r114c43', 44114.58, false, '2026-11-07', '2026-12-07 12:00:00+00', 'C048-114', 49000114, 5114, 'r114c51', 52114.66, false, '2026-07-07', '2026-08-07 12:00:00+00', 'C056-114', 57000114, 5914, 'r114c59', 60114.74),
    (315, 'r115c3', 4115.19, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C008-115', 9000115, 1115, 'r115c11', 12115.27, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C016-115', 17000115, 1915, 'r115c19', 20115.35, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C024-115', 25000115, 2715, 'r115c27', 28115.43, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C032-115', 33000115, 3515, 'r115c35', 36115.51, true, '2026-03-08', '2026-04-08 12:00:00+00', 'C040-115', 41000115, 4315, 'r115c43', 44115.59, true, '2026-11-08', '2026-12-08 12:00:00+00', 'C048-115', 49000115, 5115, 'r115c51', 52115.67, true, '2026-07-08', '2026-08-08 12:00:00+00', 'C056-115', 57000115, 5915, 'r115c59', 60115.75),
    (316, 'r116c3', 4116.20, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C008-116', 9000116, 1116, 'r116c11', 12116.28, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C016-116', 17000116, 1916, 'r116c19', 20116.36, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C024-116', 25000116, 2716, 'r116c27', 28116.44, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C032-116', 33000116, 3516, 'r116c35', 36116.52, false, '2026-03-09', '2026-04-09 12:00:00+00', 'C040-116', 41000116, 4316, 'r116c43', 44116.60, false, '2026-11-09', '2026-12-09 12:00:00+00', 'C048-116', 49000116, 5116, 'r116c51', 52116.68, false, '2026-07-09', '2026-08-09 12:00:00+00', 'C056-116', 57000116, 5916, 'r116c59', 60116.76),
    (317, 'r117c3', 4117.21, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C008-117', 9000117, 1117, 'r117c11', 12117.29, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C016-117', 17000117, 1917, 'r117c19', 20117.37, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C024-117', 25000117, 2717, 'r117c27', 28117.45, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C032-117', 33000117, 3517, 'r117c35', 36117.53, true, '2026-03-10', '2026-04-10 12:00:00+00', 'C040-117', 41000117, 4317, 'r117c43', 44117.61, true, '2026-11-10', '2026-12-10 12:00:00+00', 'C048-117', 49000117, 5117, 'r117c51', 52117.69, true, '2026-07-10', '2026-08-10 12:00:00+00', 'C056-117', 57000117, 5917, 'r117c59', 60117.77),
    (318, 'r118c3', 4118.22, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C008-118', 9000118, 1118, 'r118c11', 12118.30, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C016-118', 17000118, 1918, 'r118c19', 20118.38, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C024-118', 25000118, 2718, 'r118c27', 28118.46, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C032-118', 33000118, 3518, 'r118c35', 36118.54, false, '2026-03-11', '2026-04-11 12:00:00+00', 'C040-118', 41000118, 4318, 'r118c43', 44118.62, false, '2026-11-11', '2026-12-11 12:00:00+00', 'C048-118', 49000118, 5118, 'r118c51', 52118.70, false, '2026-07-11', '2026-08-11 12:00:00+00', 'C056-118', 57000118, 5918, 'r118c59', 60118.78),
    (319, 'r119c3', 4119.23, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C008-119', 9000119, 1119, 'r119c11', 12119.31, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C016-119', 17000119, 1919, 'r119c19', 20119.39, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C024-119', 25000119, 2719, 'r119c27', 28119.47, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C032-119', 33000119, 3519, 'r119c35', 36119.55, true, '2026-03-12', '2026-04-12 12:00:00+00', 'C040-119', 41000119, 4319, 'r119c43', 44119.63, true, '2026-11-12', '2026-12-12 12:00:00+00', 'C048-119', 49000119, 5119, 'r119c51', 52119.71, true, '2026-07-12', '2026-08-12 12:00:00+00', 'C056-119', 57000119, 5919, 'r119c59', 60119.79),
    (320, 'r120c3', 4120.24, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C008-120', 9000120, 1120, 'r120c11', 12120.32, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C016-120', 17000120, 1920, 'r120c19', 20120.40, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C024-120', 25000120, 2720, 'r120c27', 28120.48, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C032-120', 33000120, 3520, 'r120c35', 36120.56, false, '2026-03-13', '2026-04-13 12:00:00+00', 'C040-120', 41000120, 4320, 'r120c43', 44120.64, false, '2026-11-13', '2026-12-13 12:00:00+00', 'C048-120', 49000120, 5120, 'r120c51', 52120.72, false, '2026-07-13', '2026-08-13 12:00:00+00', 'C056-120', 57000120, 5920, 'r120c59', 60120.80);

-- ---------------------------------------------------------------------------
-- hub: a legacy-ERP emulation. Four central, very-high-degree tables
-- (users, projects, workorders, workorder_rows) plus a fleet of ~150 satellite
-- tables. Every satellite carries the audit quartet
-- (created_at / created_by / changed_at / changed_by, the *_by columns
-- pointing at users), foreign keys into the project/workorder/workorder_row
-- hierarchy, and one or more foreign keys to OTHER satellites -- so the graph
-- is a dense web with a few enormous hubs, not a clean star. A view per
-- satellite plus cross-satellite summary views push the view count on par with
-- the table count, the way views accrete in a 15-year-old database.
--
-- Generated by scratchpad/gen_hub.py (deterministic). To rescale, edit the
-- knobs there and regenerate.
-- ---------------------------------------------------------------------------
CREATE SCHEMA hub;

-- users: the audit anchor. Every other table's created_by/changed_by lands
-- here, giving it by far the highest fan-in in the database.
CREATE TABLE hub.users (
    id           serial       PRIMARY KEY,
    username     text         UNIQUE NOT NULL,
    full_name    text         NOT NULL,
    email        text         UNIQUE NOT NULL,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    created_by   integer      REFERENCES hub.users (id),
    changed_at   timestamptz  NOT NULL DEFAULT now(),
    changed_by   integer      REFERENCES hub.users (id)
);

INSERT INTO hub.users (username, full_name, email, created_by, changed_by) VALUES
    ('user01', 'User 01', 'user01@example.com', NULL, NULL),
    ('user02', 'User 02', 'user02@example.com', 1, 1),
    ('user03', 'User 03', 'user03@example.com', 1, 1),
    ('user04', 'User 04', 'user04@example.com', 1, 1),
    ('user05', 'User 05', 'user05@example.com', 1, 1),
    ('user06', 'User 06', 'user06@example.com', 1, 1),
    ('user07', 'User 07', 'user07@example.com', 1, 1),
    ('user08', 'User 08', 'user08@example.com', 1, 1),
    ('user09', 'User 09', 'user09@example.com', 1, 1),
    ('user10', 'User 10', 'user10@example.com', 1, 1),
    ('user11', 'User 11', 'user11@example.com', 1, 1),
    ('user12', 'User 12', 'user12@example.com', 1, 1);

-- projects / workorders / workorder_rows: the operational hierarchy almost
-- every satellite hangs off of.
CREATE TABLE hub.projects (
    id           serial       PRIMARY KEY,
    code         text         UNIQUE NOT NULL,
    name         text         NOT NULL,
    status       text         NOT NULL DEFAULT 'active',
    created_at   timestamptz  NOT NULL DEFAULT now(),
    created_by   integer      REFERENCES hub.users (id),
    changed_at   timestamptz  NOT NULL DEFAULT now(),
    changed_by   integer      REFERENCES hub.users (id)
);

INSERT INTO hub.projects (code, name, status, created_by, changed_by) VALUES
    ('PRJ-001', 'Project 001', 'on_hold', 2, 2),
    ('PRJ-002', 'Project 002', 'closed', 3, 3),
    ('PRJ-003', 'Project 003', 'active', 4, 4),
    ('PRJ-004', 'Project 004', 'on_hold', 5, 5),
    ('PRJ-005', 'Project 005', 'closed', 6, 6),
    ('PRJ-006', 'Project 006', 'active', 7, 7),
    ('PRJ-007', 'Project 007', 'on_hold', 8, 8),
    ('PRJ-008', 'Project 008', 'closed', 9, 9);

CREATE TABLE hub.workorders (
    id           serial       PRIMARY KEY,
    project_id   integer      NOT NULL REFERENCES hub.projects (id),
    number       text         UNIQUE NOT NULL,
    description  text,
    status       text         NOT NULL DEFAULT 'open',
    created_at   timestamptz  NOT NULL DEFAULT now(),
    created_by   integer      REFERENCES hub.users (id),
    changed_at   timestamptz  NOT NULL DEFAULT now(),
    changed_by   integer      REFERENCES hub.users (id)
);

INSERT INTO hub.workorders (project_id, number, description, status, created_by, changed_by) VALUES
    (2, 'WO-0001', 'Workorder 0001', 'in_progress', 2, 2),
    (3, 'WO-0002', 'Workorder 0002', 'done', 3, 3),
    (4, 'WO-0003', 'Workorder 0003', 'open', 4, 4),
    (5, 'WO-0004', 'Workorder 0004', 'in_progress', 5, 5),
    (6, 'WO-0005', 'Workorder 0005', 'done', 6, 6),
    (7, 'WO-0006', 'Workorder 0006', 'open', 7, 7),
    (8, 'WO-0007', 'Workorder 0007', 'in_progress', 8, 8),
    (1, 'WO-0008', 'Workorder 0008', 'done', 9, 9),
    (2, 'WO-0009', 'Workorder 0009', 'open', 10, 10),
    (3, 'WO-0010', 'Workorder 0010', 'in_progress', 11, 11),
    (4, 'WO-0011', 'Workorder 0011', 'done', 12, 12),
    (5, 'WO-0012', 'Workorder 0012', 'open', 1, 1),
    (6, 'WO-0013', 'Workorder 0013', 'in_progress', 2, 2),
    (7, 'WO-0014', 'Workorder 0014', 'done', 3, 3),
    (8, 'WO-0015', 'Workorder 0015', 'open', 4, 4),
    (1, 'WO-0016', 'Workorder 0016', 'in_progress', 5, 5),
    (2, 'WO-0017', 'Workorder 0017', 'done', 6, 6),
    (3, 'WO-0018', 'Workorder 0018', 'open', 7, 7),
    (4, 'WO-0019', 'Workorder 0019', 'in_progress', 8, 8),
    (5, 'WO-0020', 'Workorder 0020', 'done', 9, 9),
    (6, 'WO-0021', 'Workorder 0021', 'open', 10, 10),
    (7, 'WO-0022', 'Workorder 0022', 'in_progress', 11, 11),
    (8, 'WO-0023', 'Workorder 0023', 'done', 12, 12),
    (1, 'WO-0024', 'Workorder 0024', 'open', 1, 1);

CREATE TABLE hub.workorder_rows (
    id            serial        PRIMARY KEY,
    workorder_id  integer       NOT NULL REFERENCES hub.workorders (id),
    project_id    integer       REFERENCES hub.projects (id),
    line_no       integer       NOT NULL,
    description   text,
    quantity      numeric(12, 2) NOT NULL DEFAULT 0,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    created_by    integer       REFERENCES hub.users (id),
    changed_at    timestamptz   NOT NULL DEFAULT now(),
    changed_by    integer       REFERENCES hub.users (id)
);

INSERT INTO hub.workorder_rows (workorder_id, project_id, line_no, description, quantity, created_by, changed_by) VALUES
    (2, 2, 1, 'Row 001', 3.01, 2, 2),
    (3, 3, 2, 'Row 002', 6.02, 3, 3),
    (4, 4, 3, 'Row 003', 9.03, 4, 4),
    (5, 5, 4, 'Row 004', 12.04, 5, 5),
    (6, 6, 5, 'Row 005', 15.05, 6, 6),
    (7, 7, 6, 'Row 006', 18.06, 7, 7),
    (8, 8, 7, 'Row 007', 21.07, 8, 8),
    (9, 1, 8, 'Row 008', 24.08, 9, 9),
    (10, 2, 9, 'Row 009', 27.09, 10, 10),
    (11, 3, 10, 'Row 010', 30.10, 11, 11),
    (12, 4, 11, 'Row 011', 33.11, 12, 12),
    (13, 5, 12, 'Row 012', 36.12, 1, 1),
    (14, 6, 13, 'Row 013', 39.13, 2, 2),
    (15, 7, 14, 'Row 014', 42.14, 3, 3),
    (16, 8, 15, 'Row 015', 45.15, 4, 4),
    (17, 1, 16, 'Row 016', 48.16, 5, 5),
    (18, 2, 17, 'Row 017', 51.17, 6, 6),
    (19, 3, 18, 'Row 018', 54.18, 7, 7),
    (20, 4, 19, 'Row 019', 57.19, 8, 8),
    (21, 5, 20, 'Row 020', 60.20, 9, 9),
    (22, 6, 1, 'Row 021', 63.21, 10, 10),
    (23, 7, 2, 'Row 022', 66.22, 11, 11),
    (24, 8, 3, 'Row 023', 69.23, 12, 12),
    (1, 1, 4, 'Row 024', 72.24, 1, 1),
    (2, 2, 5, 'Row 025', 75.25, 2, 2),
    (3, 3, 6, 'Row 026', 78.26, 3, 3),
    (4, 4, 7, 'Row 027', 81.27, 4, 4),
    (5, 5, 8, 'Row 028', 84.28, 5, 5),
    (6, 6, 9, 'Row 029', 87.29, 6, 6),
    (7, 7, 10, 'Row 030', 90.30, 7, 7),
    (8, 8, 11, 'Row 031', 93.31, 8, 8),
    (9, 1, 12, 'Row 032', 96.32, 9, 9),
    (10, 2, 13, 'Row 033', 99.33, 10, 10),
    (11, 3, 14, 'Row 034', 102.34, 11, 11),
    (12, 4, 15, 'Row 035', 105.35, 12, 12),
    (13, 5, 16, 'Row 036', 108.36, 1, 1),
    (14, 6, 17, 'Row 037', 111.37, 2, 2),
    (15, 7, 18, 'Row 038', 114.38, 3, 3),
    (16, 8, 19, 'Row 039', 117.39, 4, 4),
    (17, 1, 20, 'Row 040', 120.40, 5, 5),
    (18, 2, 1, 'Row 041', 123.41, 6, 6),
    (19, 3, 2, 'Row 042', 126.42, 7, 7),
    (20, 4, 3, 'Row 043', 129.43, 8, 8),
    (21, 5, 4, 'Row 044', 132.44, 9, 9),
    (22, 6, 5, 'Row 045', 135.45, 10, 10),
    (23, 7, 6, 'Row 046', 138.46, 11, 11),
    (24, 8, 7, 'Row 047', 141.47, 12, 12),
    (1, 1, 8, 'Row 048', 144.48, 1, 1);

-- Satellite tables. Each is created immediately before it is seeded, so its
-- foreign keys to earlier satellites always resolve against rows that exist.

CREATE TABLE hub.core_contact (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_contact (code, title, project_id, workorder_id, workorder_row_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 2, 3, 4, 2, 3),
    ('code-02', 'title-02', 3, 5, 7, 3, 5),
    ('code-03', 'title-03', 4, 7, 10, 4, 7),
    ('code-04', 'title-04', 5, 9, 13, 5, 9),
    ('code-05', 'title-05', 6, 11, NULL, 6, 11),
    ('code-06', 'title-06', 7, 13, 19, 7, 1),
    ('code-07', 'title-07', 8, 15, 22, 8, 3),
    ('code-08', 'title-08', 1, 17, 25, 9, 5);

CREATE TABLE hub.fin_contact (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_contact_id   integer      REFERENCES hub.core_contact (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_contact (title, amount, quantity, project_id, workorder_id, workorder_row_id, core_contact_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 12, 3, 4, 5, 3, 3, 4),
    ('title-02', 14.06, 22, 4, 6, 8, 4, 4, 6),
    ('title-03', 21.09, 32, 5, 8, 11, 5, 5, 8),
    ('title-04', 28.12, 42, 6, 10, 14, NULL, 6, 10),
    ('title-05', 35.15, 52, 7, 12, NULL, 7, 7, 12),
    ('title-06', 42.18, 62, 8, 14, 20, 8, 8, 2),
    ('title-07', 49.21, 72, 1, 16, 23, 1, 9, 4),
    ('title-08', 56.24, 82, 2, 18, 26, NULL, 10, 6);

CREATE TABLE hub.ops_contact (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_contact_id    integer      REFERENCES hub.fin_contact (id),
    core_contact_id   integer      REFERENCES hub.core_contact (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_contact (amount, quantity, is_active, due_date, project_id, workorder_id, workorder_row_id, fin_contact_id, core_contact_id, created_by, changed_by) VALUES
    (7.03, 11, false, '2026-02-02', 4, 5, 6, 4, 4, 4, 5),
    (14.06, 21, true, '2026-03-03', 5, 7, 9, 5, 5, 5, 7),
    (21.09, 31, false, '2026-04-04', 6, 9, 12, 6, NULL, 6, 9),
    (28.12, 41, true, '2026-05-05', 7, 11, 15, NULL, 7, 7, 11),
    (35.15, 51, false, '2026-06-06', 8, 13, NULL, 8, 8, 8, 1),
    (42.18, 61, true, '2026-07-07', 1, 15, 21, 1, 1, 9, 3),
    (49.21, 71, false, '2026-08-08', 2, 17, 24, 2, NULL, 10, 5),
    (56.24, 81, true, '2026-09-09', 3, 19, 27, NULL, 3, 11, 7);

CREATE TABLE hub.qa_contact (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_contact_id    integer      REFERENCES hub.ops_contact (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_contact (quantity, is_active, project_id, workorder_id, workorder_row_id, ops_contact_id, created_by, changed_by) VALUES
    (10, true, 5, 6, 7, 5, 5, 6),
    (20, false, 6, 8, 10, 6, 6, 8),
    (30, true, 7, 10, 13, 7, 7, 10),
    (40, false, 8, 12, 16, NULL, 8, 12),
    (50, true, 1, 14, NULL, 1, 9, 2),
    (60, false, 2, 16, 22, 2, 10, 4),
    (70, true, 3, 18, 25, 3, 11, 6),
    (80, false, 4, 20, 28, NULL, 12, 8);

CREATE TABLE hub.proc_contact (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_contact_id     integer      REFERENCES hub.qa_contact (id),
    ops_contact_id    integer      REFERENCES hub.ops_contact (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_contact (is_active, due_date, ref_no, project_id, workorder_id, workorder_row_id, qa_contact_id, ops_contact_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 'ref_no-01', 6, 7, 8, 6, 6, 6, 7),
    (true, '2026-03-03', 'ref_no-02', 7, 9, 11, 7, 7, 7, 9),
    (false, '2026-04-04', 'ref_no-03', 8, 11, 14, 8, NULL, 8, 11),
    (true, '2026-05-05', 'ref_no-04', 1, 13, 17, NULL, 1, 9, 1),
    (false, '2026-06-06', 'ref_no-05', 2, 15, NULL, 2, 2, 10, 3),
    (true, '2026-07-07', 'ref_no-06', 3, 17, 23, 3, 3, 11, 5),
    (false, '2026-08-08', 'ref_no-07', 4, 19, 26, 4, NULL, 12, 7),
    (true, '2026-09-09', 'ref_no-08', 5, 21, 29, NULL, 5, 1, 9);

CREATE TABLE hub.plan_contact (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_contact_id   integer      REFERENCES hub.proc_contact (id),
    qa_contact_id     integer      REFERENCES hub.qa_contact (id),
    fin_contact_id    integer      REFERENCES hub.fin_contact (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_contact (due_date, ref_no, priority, rate, project_id, workorder_id, workorder_row_id, proc_contact_id, qa_contact_id, fin_contact_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 12, 1.0013, 7, 8, 9, 7, 7, 7, 7, 8),
    ('2026-03-03', 'ref_no-02', 22, 2.0026, 8, 10, 12, 8, 8, NULL, 8, 10),
    ('2026-04-04', 'ref_no-03', 32, 3.0039, 1, 12, 15, 1, NULL, 1, 9, 12),
    ('2026-05-05', 'ref_no-04', 42, 4.0052, 2, 14, 18, NULL, 2, 2, 10, 2),
    ('2026-06-06', 'ref_no-05', 52, 5.0065, 3, 16, NULL, 3, 3, 3, 11, 4),
    ('2026-07-07', 'ref_no-06', 62, 6.0078, 4, 18, 24, 4, 4, NULL, 12, 6),
    ('2026-08-08', 'ref_no-07', 72, 7.0091, 5, 20, 27, 5, NULL, 5, 1, 8),
    ('2026-09-09', 'ref_no-08', 82, 8.0104, 6, 22, 30, NULL, 6, 6, 2, 10);

CREATE TABLE hub.doc_contact (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_contact_id   integer      REFERENCES hub.plan_contact (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_contact (ref_no, priority, project_id, workorder_id, workorder_row_id, plan_contact_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 8, 9, 10, 8, 8, 9),
    ('ref_no-02', 21, 1, 11, 13, 1, 9, 11),
    ('ref_no-03', 31, 2, 13, 16, 2, 10, 1),
    ('ref_no-04', 41, 3, 15, 19, NULL, 11, 3),
    ('ref_no-05', 51, 4, 17, NULL, 4, 12, 5),
    ('ref_no-06', 61, 5, 19, 25, 5, 1, 7),
    ('ref_no-07', 71, 6, 21, 28, 6, 2, 9),
    ('ref_no-08', 81, 7, 23, 31, NULL, 3, 11);

CREATE TABLE hub.crm_contact (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_contact_id    integer      REFERENCES hub.doc_contact (id),
    plan_contact_id   integer      REFERENCES hub.plan_contact (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_contact (priority, rate, note, project_id, workorder_id, workorder_row_id, doc_contact_id, plan_contact_id, created_by, changed_by) VALUES
    (10, 1.0013, 'note-01', 1, 10, 11, 1, 1, 9, 10),
    (20, 2.0026, 'note-02', 2, 12, 14, 2, 2, 10, 12),
    (30, 3.0039, 'note-03', 3, 14, 17, 3, NULL, 11, 2),
    (40, 4.0052, 'note-04', 4, 16, 20, NULL, 4, 12, 4),
    (50, 5.0065, 'note-05', 5, 18, NULL, 5, 5, 1, 6),
    (60, 6.0078, 'note-06', 6, 20, 26, 6, 6, 2, 8),
    (70, 7.0091, 'note-07', 7, 22, 29, 7, NULL, 3, 10),
    (80, 8.0104, 'note-08', 8, 24, 32, NULL, 8, 4, 12);

CREATE TABLE hub.asset_contact (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_contact_id    integer      REFERENCES hub.crm_contact (id),
    doc_contact_id    integer      REFERENCES hub.doc_contact (id),
    proc_contact_id   integer      REFERENCES hub.proc_contact (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_contact (rate, note, code, title, project_id, workorder_id, workorder_row_id, crm_contact_id, doc_contact_id, proc_contact_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 'code-01', 'title-01', 2, 11, 12, 2, 2, 2, 10, 11),
    (2.0026, 'note-02', 'code-02', 'title-02', 3, 13, 15, 3, 3, NULL, 11, 1),
    (3.0039, 'note-03', 'code-03', 'title-03', 4, 15, 18, 4, NULL, 4, 12, 3),
    (4.0052, 'note-04', 'code-04', 'title-04', 5, 17, 21, NULL, 5, 5, 1, 5),
    (5.0065, 'note-05', 'code-05', 'title-05', 6, 19, NULL, 6, 6, 6, 2, 7),
    (6.0078, 'note-06', 'code-06', 'title-06', 7, 21, 27, 7, 7, NULL, 3, 9),
    (7.0091, 'note-07', 'code-07', 'title-07', 8, 23, 30, 8, NULL, 8, 4, 11),
    (8.0104, 'note-08', 'code-08', 'title-08', 1, 1, 33, NULL, 1, 1, 5, 1);

CREATE TABLE hub.sched_contact (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_contact_id  integer      REFERENCES hub.asset_contact (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_contact (note, code, project_id, workorder_id, workorder_row_id, asset_contact_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 3, 12, 13, 3, 11, 12),
    ('note-02', 'code-02', 4, 14, 16, 4, 12, 2),
    ('note-03', 'code-03', 5, 16, 19, 5, 1, 4),
    ('note-04', 'code-04', 6, 18, 22, NULL, 2, 6),
    ('note-05', 'code-05', 7, 20, NULL, 7, 3, 8),
    ('note-06', 'code-06', 8, 22, 28, 8, 4, 10),
    ('note-07', 'code-07', 1, 24, 31, 1, 5, 12),
    ('note-08', 'code-08', 2, 2, 34, NULL, 6, 2);

CREATE TABLE hub.core_address (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_contact_id  integer      REFERENCES hub.sched_contact (id),
    asset_contact_id  integer      REFERENCES hub.asset_contact (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_address (code, title, amount, project_id, workorder_id, workorder_row_id, sched_contact_id, asset_contact_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 7.03, 4, 13, 14, 4, 4, 12, 1),
    ('code-02', 'title-02', 14.06, 5, 15, 17, 5, 5, 1, 3),
    ('code-03', 'title-03', 21.09, 6, 17, 20, 6, NULL, 2, 5),
    ('code-04', 'title-04', 28.12, 7, 19, 23, NULL, 7, 3, 7),
    ('code-05', 'title-05', 35.15, 8, 21, NULL, 8, 8, 4, 9),
    ('code-06', 'title-06', 42.18, 1, 23, 29, 1, 1, 5, 11),
    ('code-07', 'title-07', 49.21, 2, 1, 32, 2, NULL, 6, 1),
    ('code-08', 'title-08', 56.24, 3, 3, 35, NULL, 3, 7, 3);

CREATE TABLE hub.fin_address (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_address_id   integer      REFERENCES hub.core_address (id),
    sched_contact_id  integer      REFERENCES hub.sched_contact (id),
    crm_contact_id    integer      REFERENCES hub.crm_contact (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_address (title, amount, quantity, is_active, project_id, workorder_id, workorder_row_id, core_address_id, sched_contact_id, crm_contact_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 12, true, 5, 14, 15, 5, 5, 5, 1, 2),
    ('title-02', 14.06, 22, false, 6, 16, 18, 6, 6, NULL, 2, 4),
    ('title-03', 21.09, 32, true, 7, 18, 21, 7, NULL, 7, 3, 6),
    ('title-04', 28.12, 42, false, 8, 20, 24, NULL, 8, 8, 4, 8),
    ('title-05', 35.15, 52, true, 1, 22, NULL, 1, 1, 1, 5, 10),
    ('title-06', 42.18, 62, false, 2, 24, 30, 2, 2, NULL, 6, 12),
    ('title-07', 49.21, 72, true, 3, 2, 33, 3, NULL, 3, 7, 2),
    ('title-08', 56.24, 82, false, 4, 4, 36, NULL, 4, 4, 8, 4);

CREATE TABLE hub.ops_address (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_address_id    integer      REFERENCES hub.fin_address (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_address (amount, quantity, project_id, workorder_id, workorder_row_id, fin_address_id, created_by, changed_by) VALUES
    (7.03, 11, 6, 15, 16, 6, 2, 3),
    (14.06, 21, 7, 17, 19, 7, 3, 5),
    (21.09, 31, 8, 19, 22, 8, 4, 7),
    (28.12, 41, 1, 21, 25, NULL, 5, 9),
    (35.15, 51, 2, 23, NULL, 2, 6, 11),
    (42.18, 61, 3, 1, 31, 3, 7, 1),
    (49.21, 71, 4, 3, 34, 4, 8, 3),
    (56.24, 81, 5, 5, 37, NULL, 9, 5);

CREATE TABLE hub.qa_address (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_address_id    integer      REFERENCES hub.ops_address (id),
    fin_address_id    integer      REFERENCES hub.fin_address (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_address (quantity, is_active, due_date, project_id, workorder_id, workorder_row_id, ops_address_id, fin_address_id, created_by, changed_by) VALUES
    (10, true, '2026-02-02', 7, 16, 17, 7, 7, 3, 4),
    (20, false, '2026-03-03', 8, 18, 20, 8, 8, 4, 6),
    (30, true, '2026-04-04', 1, 20, 23, 1, NULL, 5, 8),
    (40, false, '2026-05-05', 2, 22, 26, NULL, 2, 6, 10),
    (50, true, '2026-06-06', 3, 24, NULL, 3, 3, 7, 12),
    (60, false, '2026-07-07', 4, 2, 32, 4, 4, 8, 2),
    (70, true, '2026-08-08', 5, 4, 35, 5, NULL, 9, 4),
    (80, false, '2026-09-09', 6, 6, 38, NULL, 6, 10, 6);

CREATE TABLE hub.proc_address (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_address_id     integer      REFERENCES hub.qa_address (id),
    ops_address_id    integer      REFERENCES hub.ops_address (id),
    core_address_id   integer      REFERENCES hub.core_address (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_address (is_active, due_date, ref_no, priority, project_id, workorder_id, workorder_row_id, qa_address_id, ops_address_id, core_address_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 'ref_no-01', 13, 8, 17, 18, 8, 8, 8, 4, 5),
    (true, '2026-03-03', 'ref_no-02', 23, 1, 19, 21, 1, 1, NULL, 5, 7),
    (false, '2026-04-04', 'ref_no-03', 33, 2, 21, 24, 2, NULL, 2, 6, 9),
    (true, '2026-05-05', 'ref_no-04', 43, 3, 23, 27, NULL, 3, 3, 7, 11),
    (false, '2026-06-06', 'ref_no-05', 53, 4, 1, NULL, 4, 4, 4, 8, 1),
    (true, '2026-07-07', 'ref_no-06', 63, 5, 3, 33, 5, 5, NULL, 9, 3),
    (false, '2026-08-08', 'ref_no-07', 73, 6, 5, 36, 6, NULL, 6, 10, 5),
    (true, '2026-09-09', 'ref_no-08', 83, 7, 7, 39, NULL, 7, 7, 11, 7);

CREATE TABLE hub.plan_address (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_address_id   integer      REFERENCES hub.proc_address (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_address (due_date, ref_no, project_id, workorder_id, workorder_row_id, proc_address_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 1, 18, 19, 1, 5, 6),
    ('2026-03-03', 'ref_no-02', 2, 20, 22, 2, 6, 8),
    ('2026-04-04', 'ref_no-03', 3, 22, 25, 3, 7, 10),
    ('2026-05-05', 'ref_no-04', 4, 24, 28, NULL, 8, 12),
    ('2026-06-06', 'ref_no-05', 5, 2, NULL, 5, 9, 2),
    ('2026-07-07', 'ref_no-06', 6, 4, 34, 6, 10, 4),
    ('2026-08-08', 'ref_no-07', 7, 6, 37, 7, 11, 6),
    ('2026-09-09', 'ref_no-08', 8, 8, 40, NULL, 12, 8);

CREATE TABLE hub.doc_address (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_address_id   integer      REFERENCES hub.plan_address (id),
    proc_address_id   integer      REFERENCES hub.proc_address (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_address (ref_no, priority, rate, project_id, workorder_id, workorder_row_id, plan_address_id, proc_address_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 1.0013, 2, 19, 20, 2, 2, 6, 7),
    ('ref_no-02', 21, 2.0026, 3, 21, 23, 3, 3, 7, 9),
    ('ref_no-03', 31, 3.0039, 4, 23, 26, 4, NULL, 8, 11),
    ('ref_no-04', 41, 4.0052, 5, 1, 29, NULL, 5, 9, 1),
    ('ref_no-05', 51, 5.0065, 6, 3, NULL, 6, 6, 10, 3),
    ('ref_no-06', 61, 6.0078, 7, 5, 35, 7, 7, 11, 5),
    ('ref_no-07', 71, 7.0091, 8, 7, 38, 8, NULL, 12, 7),
    ('ref_no-08', 81, 8.0104, 1, 9, 41, NULL, 1, 1, 9);

CREATE TABLE hub.crm_address (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_address_id    integer      REFERENCES hub.doc_address (id),
    plan_address_id   integer      REFERENCES hub.plan_address (id),
    qa_address_id     integer      REFERENCES hub.qa_address (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_address (priority, rate, note, code, project_id, workorder_id, workorder_row_id, doc_address_id, plan_address_id, qa_address_id, created_by, changed_by) VALUES
    (10, 1.0013, 'note-01', 'code-01', 3, 20, 21, 3, 3, 3, 7, 8),
    (20, 2.0026, 'note-02', 'code-02', 4, 22, 24, 4, 4, NULL, 8, 10),
    (30, 3.0039, 'note-03', 'code-03', 5, 24, 27, 5, NULL, 5, 9, 12),
    (40, 4.0052, 'note-04', 'code-04', 6, 2, 30, NULL, 6, 6, 10, 2),
    (50, 5.0065, 'note-05', 'code-05', 7, 4, NULL, 7, 7, 7, 11, 4),
    (60, 6.0078, 'note-06', 'code-06', 8, 6, 36, 8, 8, NULL, 12, 6),
    (70, 7.0091, 'note-07', 'code-07', 1, 8, 39, 1, NULL, 1, 1, 8),
    (80, 8.0104, 'note-08', 'code-08', 2, 10, 42, NULL, 2, 2, 2, 10);

CREATE TABLE hub.asset_address (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_address_id    integer      REFERENCES hub.crm_address (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_address (rate, note, project_id, workorder_id, workorder_row_id, crm_address_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 4, 21, 22, 4, 8, 9),
    (2.0026, 'note-02', 5, 23, 25, 5, 9, 11),
    (3.0039, 'note-03', 6, 1, 28, 6, 10, 1),
    (4.0052, 'note-04', 7, 3, 31, NULL, 11, 3),
    (5.0065, 'note-05', 8, 5, NULL, 8, 12, 5),
    (6.0078, 'note-06', 1, 7, 37, 1, 1, 7),
    (7.0091, 'note-07', 2, 9, 40, 2, 2, 9),
    (8.0104, 'note-08', 3, 11, 43, NULL, 3, 11);

CREATE TABLE hub.sched_address (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_address_id  integer      REFERENCES hub.asset_address (id),
    crm_address_id    integer      REFERENCES hub.crm_address (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_address (note, code, title, project_id, workorder_id, workorder_row_id, asset_address_id, crm_address_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 'title-01', 5, 22, 23, 5, 5, 9, 10),
    ('note-02', 'code-02', 'title-02', 6, 24, 26, 6, 6, 10, 12),
    ('note-03', 'code-03', 'title-03', 7, 2, 29, 7, NULL, 11, 2),
    ('note-04', 'code-04', 'title-04', 8, 4, 32, NULL, 8, 12, 4),
    ('note-05', 'code-05', 'title-05', 1, 6, NULL, 1, 1, 1, 6),
    ('note-06', 'code-06', 'title-06', 2, 8, 38, 2, 2, 2, 8),
    ('note-07', 'code-07', 'title-07', 3, 10, 41, 3, NULL, 3, 10),
    ('note-08', 'code-08', 'title-08', 4, 12, 44, NULL, 4, 4, 12);

CREATE TABLE hub.core_document (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_address_id  integer      REFERENCES hub.sched_address (id),
    asset_address_id  integer      REFERENCES hub.asset_address (id),
    doc_address_id    integer      REFERENCES hub.doc_address (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_document (code, title, amount, quantity, project_id, workorder_id, workorder_row_id, sched_address_id, asset_address_id, doc_address_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 7.03, 13, 6, 23, 24, 6, 6, 6, 10, 11),
    ('code-02', 'title-02', 14.06, 23, 7, 1, 27, 7, 7, NULL, 11, 1),
    ('code-03', 'title-03', 21.09, 33, 8, 3, 30, 8, NULL, 8, 12, 3),
    ('code-04', 'title-04', 28.12, 43, 1, 5, 33, NULL, 1, 1, 1, 5),
    ('code-05', 'title-05', 35.15, 53, 2, 7, NULL, 2, 2, 2, 2, 7),
    ('code-06', 'title-06', 42.18, 63, 3, 9, 39, 3, 3, NULL, 3, 9),
    ('code-07', 'title-07', 49.21, 73, 4, 11, 42, 4, NULL, 4, 4, 11),
    ('code-08', 'title-08', 56.24, 83, 5, 13, 45, NULL, 5, 5, 5, 1);

CREATE TABLE hub.fin_document (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_document_id  integer      REFERENCES hub.core_document (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_document (title, amount, project_id, workorder_id, workorder_row_id, core_document_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 7, 24, 25, 7, 11, 12),
    ('title-02', 14.06, 8, 2, 28, 8, 12, 2),
    ('title-03', 21.09, 1, 4, 31, 1, 1, 4),
    ('title-04', 28.12, 2, 6, 34, NULL, 2, 6),
    ('title-05', 35.15, 3, 8, NULL, 3, 3, 8),
    ('title-06', 42.18, 4, 10, 40, 4, 4, 10),
    ('title-07', 49.21, 5, 12, 43, 5, 5, 12),
    ('title-08', 56.24, 6, 14, 46, NULL, 6, 2);

CREATE TABLE hub.ops_document (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_document_id   integer      REFERENCES hub.fin_document (id),
    core_document_id  integer      REFERENCES hub.core_document (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_document (amount, quantity, is_active, project_id, workorder_id, workorder_row_id, fin_document_id, core_document_id, created_by, changed_by) VALUES
    (7.03, 11, false, 8, 1, 26, 8, 8, 12, 1),
    (14.06, 21, true, 1, 3, 29, 1, 1, 1, 3),
    (21.09, 31, false, 2, 5, 32, 2, NULL, 2, 5),
    (28.12, 41, true, 3, 7, 35, NULL, 3, 3, 7),
    (35.15, 51, false, 4, 9, NULL, 4, 4, 4, 9),
    (42.18, 61, true, 5, 11, 41, 5, 5, 5, 11),
    (49.21, 71, false, 6, 13, 44, 6, NULL, 6, 1),
    (56.24, 81, true, 7, 15, 47, NULL, 7, 7, 3);

CREATE TABLE hub.qa_document (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_document_id   integer      REFERENCES hub.ops_document (id),
    fin_document_id   integer      REFERENCES hub.fin_document (id),
    sched_address_id  integer      REFERENCES hub.sched_address (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_document (quantity, is_active, due_date, ref_no, project_id, workorder_id, workorder_row_id, ops_document_id, fin_document_id, sched_address_id, created_by, changed_by) VALUES
    (10, true, '2026-02-02', 'ref_no-01', 1, 2, 27, 1, 1, 1, 1, 2),
    (20, false, '2026-03-03', 'ref_no-02', 2, 4, 30, 2, 2, NULL, 2, 4),
    (30, true, '2026-04-04', 'ref_no-03', 3, 6, 33, 3, NULL, 3, 3, 6),
    (40, false, '2026-05-05', 'ref_no-04', 4, 8, 36, NULL, 4, 4, 4, 8),
    (50, true, '2026-06-06', 'ref_no-05', 5, 10, NULL, 5, 5, 5, 5, 10),
    (60, false, '2026-07-07', 'ref_no-06', 6, 12, 42, 6, 6, NULL, 6, 12),
    (70, true, '2026-08-08', 'ref_no-07', 7, 14, 45, 7, NULL, 7, 7, 2),
    (80, false, '2026-09-09', 'ref_no-08', 8, 16, 48, NULL, 8, 8, 8, 4);

CREATE TABLE hub.proc_document (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_document_id    integer      REFERENCES hub.qa_document (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_document (is_active, due_date, project_id, workorder_id, workorder_row_id, qa_document_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 2, 3, 28, 2, 2, 3),
    (true, '2026-03-03', 3, 5, 31, 3, 3, 5),
    (false, '2026-04-04', 4, 7, 34, 4, 4, 7),
    (true, '2026-05-05', 5, 9, 37, NULL, 5, 9),
    (false, '2026-06-06', 6, 11, NULL, 6, 6, 11),
    (true, '2026-07-07', 7, 13, 43, 7, 7, 1),
    (false, '2026-08-08', 8, 15, 46, 8, 8, 3),
    (true, '2026-09-09', 1, 17, 1, NULL, 9, 5);

CREATE TABLE hub.plan_document (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_document_id  integer      REFERENCES hub.proc_document (id),
    qa_document_id    integer      REFERENCES hub.qa_document (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_document (due_date, ref_no, priority, project_id, workorder_id, workorder_row_id, proc_document_id, qa_document_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 12, 3, 4, 29, 3, 3, 3, 4),
    ('2026-03-03', 'ref_no-02', 22, 4, 6, 32, 4, 4, 4, 6),
    ('2026-04-04', 'ref_no-03', 32, 5, 8, 35, 5, NULL, 5, 8),
    ('2026-05-05', 'ref_no-04', 42, 6, 10, 38, NULL, 6, 6, 10),
    ('2026-06-06', 'ref_no-05', 52, 7, 12, NULL, 7, 7, 7, 12),
    ('2026-07-07', 'ref_no-06', 62, 8, 14, 44, 8, 8, 8, 2),
    ('2026-08-08', 'ref_no-07', 72, 1, 16, 47, 1, NULL, 9, 4),
    ('2026-09-09', 'ref_no-08', 82, 2, 18, 2, NULL, 2, 10, 6);

CREATE TABLE hub.doc_document (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_document_id  integer      REFERENCES hub.plan_document (id),
    proc_document_id  integer      REFERENCES hub.proc_document (id),
    ops_document_id   integer      REFERENCES hub.ops_document (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_document (ref_no, priority, rate, note, project_id, workorder_id, workorder_row_id, plan_document_id, proc_document_id, ops_document_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 1.0013, 'note-01', 4, 5, 30, 4, 4, 4, 4, 5),
    ('ref_no-02', 21, 2.0026, 'note-02', 5, 7, 33, 5, 5, NULL, 5, 7),
    ('ref_no-03', 31, 3.0039, 'note-03', 6, 9, 36, 6, NULL, 6, 6, 9),
    ('ref_no-04', 41, 4.0052, 'note-04', 7, 11, 39, NULL, 7, 7, 7, 11),
    ('ref_no-05', 51, 5.0065, 'note-05', 8, 13, NULL, 8, 8, 8, 8, 1),
    ('ref_no-06', 61, 6.0078, 'note-06', 1, 15, 45, 1, 1, NULL, 9, 3),
    ('ref_no-07', 71, 7.0091, 'note-07', 2, 17, 48, 2, NULL, 2, 10, 5),
    ('ref_no-08', 81, 8.0104, 'note-08', 3, 19, 3, NULL, 3, 3, 11, 7);

CREATE TABLE hub.crm_document (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_document_id   integer      REFERENCES hub.doc_document (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_document (priority, rate, project_id, workorder_id, workorder_row_id, doc_document_id, created_by, changed_by) VALUES
    (10, 1.0013, 5, 6, 31, 5, 5, 6),
    (20, 2.0026, 6, 8, 34, 6, 6, 8),
    (30, 3.0039, 7, 10, 37, 7, 7, 10),
    (40, 4.0052, 8, 12, 40, NULL, 8, 12),
    (50, 5.0065, 1, 14, NULL, 1, 9, 2),
    (60, 6.0078, 2, 16, 46, 2, 10, 4),
    (70, 7.0091, 3, 18, 1, 3, 11, 6),
    (80, 8.0104, 4, 20, 4, NULL, 12, 8);

CREATE TABLE hub.asset_document (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_document_id   integer      REFERENCES hub.crm_document (id),
    doc_document_id   integer      REFERENCES hub.doc_document (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_document (rate, note, code, project_id, workorder_id, workorder_row_id, crm_document_id, doc_document_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 'code-01', 6, 7, 32, 6, 6, 6, 7),
    (2.0026, 'note-02', 'code-02', 7, 9, 35, 7, 7, 7, 9),
    (3.0039, 'note-03', 'code-03', 8, 11, 38, 8, NULL, 8, 11),
    (4.0052, 'note-04', 'code-04', 1, 13, 41, NULL, 1, 9, 1),
    (5.0065, 'note-05', 'code-05', 2, 15, NULL, 2, 2, 10, 3),
    (6.0078, 'note-06', 'code-06', 3, 17, 47, 3, 3, 11, 5),
    (7.0091, 'note-07', 'code-07', 4, 19, 2, 4, NULL, 12, 7),
    (8.0104, 'note-08', 'code-08', 5, 21, 5, NULL, 5, 1, 9);

CREATE TABLE hub.sched_document (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_document_id integer      REFERENCES hub.asset_document (id),
    crm_document_id   integer      REFERENCES hub.crm_document (id),
    plan_document_id  integer      REFERENCES hub.plan_document (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_document (note, code, title, amount, project_id, workorder_id, workorder_row_id, asset_document_id, crm_document_id, plan_document_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 'title-01', 7.03, 7, 8, 33, 7, 7, 7, 7, 8),
    ('note-02', 'code-02', 'title-02', 14.06, 8, 10, 36, 8, 8, NULL, 8, 10),
    ('note-03', 'code-03', 'title-03', 21.09, 1, 12, 39, 1, NULL, 1, 9, 12),
    ('note-04', 'code-04', 'title-04', 28.12, 2, 14, 42, NULL, 2, 2, 10, 2),
    ('note-05', 'code-05', 'title-05', 35.15, 3, 16, NULL, 3, 3, 3, 11, 4),
    ('note-06', 'code-06', 'title-06', 42.18, 4, 18, 48, 4, 4, NULL, 12, 6),
    ('note-07', 'code-07', 'title-07', 49.21, 5, 20, 3, 5, NULL, 5, 1, 8),
    ('note-08', 'code-08', 'title-08', 56.24, 6, 22, 6, NULL, 6, 6, 2, 10);

CREATE TABLE hub.core_attachment (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_document_id integer      REFERENCES hub.sched_document (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_attachment (code, title, project_id, workorder_id, workorder_row_id, sched_document_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 8, 9, 34, 8, 8, 9),
    ('code-02', 'title-02', 1, 11, 37, 1, 9, 11),
    ('code-03', 'title-03', 2, 13, 40, 2, 10, 1),
    ('code-04', 'title-04', 3, 15, 43, NULL, 11, 3),
    ('code-05', 'title-05', 4, 17, NULL, 4, 12, 5),
    ('code-06', 'title-06', 5, 19, 1, 5, 1, 7),
    ('code-07', 'title-07', 6, 21, 4, 6, 2, 9),
    ('code-08', 'title-08', 7, 23, 7, NULL, 3, 11);

CREATE TABLE hub.fin_attachment (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_attachment_id integer      REFERENCES hub.core_attachment (id),
    sched_document_id integer      REFERENCES hub.sched_document (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_attachment (title, amount, quantity, project_id, workorder_id, workorder_row_id, core_attachment_id, sched_document_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 12, 1, 10, 35, 1, 1, 9, 10),
    ('title-02', 14.06, 22, 2, 12, 38, 2, 2, 10, 12),
    ('title-03', 21.09, 32, 3, 14, 41, 3, NULL, 11, 2),
    ('title-04', 28.12, 42, 4, 16, 44, NULL, 4, 12, 4),
    ('title-05', 35.15, 52, 5, 18, NULL, 5, 5, 1, 6),
    ('title-06', 42.18, 62, 6, 20, 2, 6, 6, 2, 8),
    ('title-07', 49.21, 72, 7, 22, 5, 7, NULL, 3, 10),
    ('title-08', 56.24, 82, 8, 24, 8, NULL, 8, 4, 12);

CREATE TABLE hub.ops_attachment (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_attachment_id integer      REFERENCES hub.fin_attachment (id),
    core_attachment_id integer      REFERENCES hub.core_attachment (id),
    asset_document_id integer      REFERENCES hub.asset_document (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_attachment (amount, quantity, is_active, due_date, project_id, workorder_id, workorder_row_id, fin_attachment_id, core_attachment_id, asset_document_id, created_by, changed_by) VALUES
    (7.03, 11, false, '2026-02-02', 2, 11, 36, 2, 2, 2, 10, 11),
    (14.06, 21, true, '2026-03-03', 3, 13, 39, 3, 3, NULL, 11, 1),
    (21.09, 31, false, '2026-04-04', 4, 15, 42, 4, NULL, 4, 12, 3),
    (28.12, 41, true, '2026-05-05', 5, 17, 45, NULL, 5, 5, 1, 5),
    (35.15, 51, false, '2026-06-06', 6, 19, NULL, 6, 6, 6, 2, 7),
    (42.18, 61, true, '2026-07-07', 7, 21, 3, 7, 7, NULL, 3, 9),
    (49.21, 71, false, '2026-08-08', 8, 23, 6, 8, NULL, 8, 4, 11),
    (56.24, 81, true, '2026-09-09', 1, 1, 9, NULL, 1, 1, 5, 1);

CREATE TABLE hub.qa_attachment (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_attachment_id integer      REFERENCES hub.ops_attachment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_attachment (quantity, is_active, project_id, workorder_id, workorder_row_id, ops_attachment_id, created_by, changed_by) VALUES
    (10, true, 3, 12, 37, 3, 11, 12),
    (20, false, 4, 14, 40, 4, 12, 2),
    (30, true, 5, 16, 43, 5, 1, 4),
    (40, false, 6, 18, 46, NULL, 2, 6),
    (50, true, 7, 20, NULL, 7, 3, 8),
    (60, false, 8, 22, 4, 8, 4, 10),
    (70, true, 1, 24, 7, 1, 5, 12),
    (80, false, 2, 2, 10, NULL, 6, 2);

CREATE TABLE hub.proc_attachment (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_attachment_id  integer      REFERENCES hub.qa_attachment (id),
    ops_attachment_id integer      REFERENCES hub.ops_attachment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_attachment (is_active, due_date, ref_no, project_id, workorder_id, workorder_row_id, qa_attachment_id, ops_attachment_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 'ref_no-01', 4, 13, 38, 4, 4, 12, 1),
    (true, '2026-03-03', 'ref_no-02', 5, 15, 41, 5, 5, 1, 3),
    (false, '2026-04-04', 'ref_no-03', 6, 17, 44, 6, NULL, 2, 5),
    (true, '2026-05-05', 'ref_no-04', 7, 19, 47, NULL, 7, 3, 7),
    (false, '2026-06-06', 'ref_no-05', 8, 21, NULL, 8, 8, 4, 9),
    (true, '2026-07-07', 'ref_no-06', 1, 23, 5, 1, 1, 5, 11),
    (false, '2026-08-08', 'ref_no-07', 2, 1, 8, 2, NULL, 6, 1),
    (true, '2026-09-09', 'ref_no-08', 3, 3, 11, NULL, 3, 7, 3);

CREATE TABLE hub.plan_attachment (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_attachment_id integer      REFERENCES hub.proc_attachment (id),
    qa_attachment_id  integer      REFERENCES hub.qa_attachment (id),
    fin_attachment_id integer      REFERENCES hub.fin_attachment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_attachment (due_date, ref_no, priority, rate, project_id, workorder_id, workorder_row_id, proc_attachment_id, qa_attachment_id, fin_attachment_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 12, 1.0013, 5, 14, 39, 5, 5, 5, 1, 2),
    ('2026-03-03', 'ref_no-02', 22, 2.0026, 6, 16, 42, 6, 6, NULL, 2, 4),
    ('2026-04-04', 'ref_no-03', 32, 3.0039, 7, 18, 45, 7, NULL, 7, 3, 6),
    ('2026-05-05', 'ref_no-04', 42, 4.0052, 8, 20, 48, NULL, 8, 8, 4, 8),
    ('2026-06-06', 'ref_no-05', 52, 5.0065, 1, 22, NULL, 1, 1, 1, 5, 10),
    ('2026-07-07', 'ref_no-06', 62, 6.0078, 2, 24, 6, 2, 2, NULL, 6, 12),
    ('2026-08-08', 'ref_no-07', 72, 7.0091, 3, 2, 9, 3, NULL, 3, 7, 2),
    ('2026-09-09', 'ref_no-08', 82, 8.0104, 4, 4, 12, NULL, 4, 4, 8, 4);

CREATE TABLE hub.doc_attachment (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_attachment_id integer      REFERENCES hub.plan_attachment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_attachment (ref_no, priority, project_id, workorder_id, workorder_row_id, plan_attachment_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 6, 15, 40, 6, 2, 3),
    ('ref_no-02', 21, 7, 17, 43, 7, 3, 5),
    ('ref_no-03', 31, 8, 19, 46, 8, 4, 7),
    ('ref_no-04', 41, 1, 21, 1, NULL, 5, 9),
    ('ref_no-05', 51, 2, 23, NULL, 2, 6, 11),
    ('ref_no-06', 61, 3, 1, 7, 3, 7, 1),
    ('ref_no-07', 71, 4, 3, 10, 4, 8, 3),
    ('ref_no-08', 81, 5, 5, 13, NULL, 9, 5);

CREATE TABLE hub.crm_attachment (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_attachment_id integer      REFERENCES hub.doc_attachment (id),
    plan_attachment_id integer      REFERENCES hub.plan_attachment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_attachment (priority, rate, note, project_id, workorder_id, workorder_row_id, doc_attachment_id, plan_attachment_id, created_by, changed_by) VALUES
    (10, 1.0013, 'note-01', 7, 16, 41, 7, 7, 3, 4),
    (20, 2.0026, 'note-02', 8, 18, 44, 8, 8, 4, 6),
    (30, 3.0039, 'note-03', 1, 20, 47, 1, NULL, 5, 8),
    (40, 4.0052, 'note-04', 2, 22, 2, NULL, 2, 6, 10),
    (50, 5.0065, 'note-05', 3, 24, NULL, 3, 3, 7, 12),
    (60, 6.0078, 'note-06', 4, 2, 8, 4, 4, 8, 2),
    (70, 7.0091, 'note-07', 5, 4, 11, 5, NULL, 9, 4),
    (80, 8.0104, 'note-08', 6, 6, 14, NULL, 6, 10, 6);

CREATE TABLE hub.asset_attachment (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_attachment_id integer      REFERENCES hub.crm_attachment (id),
    doc_attachment_id integer      REFERENCES hub.doc_attachment (id),
    proc_attachment_id integer      REFERENCES hub.proc_attachment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_attachment (rate, note, code, title, project_id, workorder_id, workorder_row_id, crm_attachment_id, doc_attachment_id, proc_attachment_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 'code-01', 'title-01', 8, 17, 42, 8, 8, 8, 4, 5),
    (2.0026, 'note-02', 'code-02', 'title-02', 1, 19, 45, 1, 1, NULL, 5, 7),
    (3.0039, 'note-03', 'code-03', 'title-03', 2, 21, 48, 2, NULL, 2, 6, 9),
    (4.0052, 'note-04', 'code-04', 'title-04', 3, 23, 3, NULL, 3, 3, 7, 11),
    (5.0065, 'note-05', 'code-05', 'title-05', 4, 1, NULL, 4, 4, 4, 8, 1),
    (6.0078, 'note-06', 'code-06', 'title-06', 5, 3, 9, 5, 5, NULL, 9, 3),
    (7.0091, 'note-07', 'code-07', 'title-07', 6, 5, 12, 6, NULL, 6, 10, 5),
    (8.0104, 'note-08', 'code-08', 'title-08', 7, 7, 15, NULL, 7, 7, 11, 7);

CREATE TABLE hub.sched_attachment (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_attachment_id integer      REFERENCES hub.asset_attachment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_attachment (note, code, project_id, workorder_id, workorder_row_id, asset_attachment_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 1, 18, 43, 1, 5, 6),
    ('note-02', 'code-02', 2, 20, 46, 2, 6, 8),
    ('note-03', 'code-03', 3, 22, 1, 3, 7, 10),
    ('note-04', 'code-04', 4, 24, 4, NULL, 8, 12),
    ('note-05', 'code-05', 5, 2, NULL, 5, 9, 2),
    ('note-06', 'code-06', 6, 4, 10, 6, 10, 4),
    ('note-07', 'code-07', 7, 6, 13, 7, 11, 6),
    ('note-08', 'code-08', 8, 8, 16, NULL, 12, 8);

CREATE TABLE hub.core_comment (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_attachment_id integer      REFERENCES hub.sched_attachment (id),
    asset_attachment_id integer      REFERENCES hub.asset_attachment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_comment (code, title, amount, project_id, workorder_id, workorder_row_id, sched_attachment_id, asset_attachment_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 7.03, 2, 19, 44, 2, 2, 6, 7),
    ('code-02', 'title-02', 14.06, 3, 21, 47, 3, 3, 7, 9),
    ('code-03', 'title-03', 21.09, 4, 23, 2, 4, NULL, 8, 11),
    ('code-04', 'title-04', 28.12, 5, 1, 5, NULL, 5, 9, 1),
    ('code-05', 'title-05', 35.15, 6, 3, NULL, 6, 6, 10, 3),
    ('code-06', 'title-06', 42.18, 7, 5, 11, 7, 7, 11, 5),
    ('code-07', 'title-07', 49.21, 8, 7, 14, 8, NULL, 12, 7),
    ('code-08', 'title-08', 56.24, 1, 9, 17, NULL, 1, 1, 9);

CREATE TABLE hub.fin_comment (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_comment_id   integer      REFERENCES hub.core_comment (id),
    sched_attachment_id integer      REFERENCES hub.sched_attachment (id),
    crm_attachment_id integer      REFERENCES hub.crm_attachment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_comment (title, amount, quantity, is_active, project_id, workorder_id, workorder_row_id, core_comment_id, sched_attachment_id, crm_attachment_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 12, true, 3, 20, 45, 3, 3, 3, 7, 8),
    ('title-02', 14.06, 22, false, 4, 22, 48, 4, 4, NULL, 8, 10),
    ('title-03', 21.09, 32, true, 5, 24, 3, 5, NULL, 5, 9, 12),
    ('title-04', 28.12, 42, false, 6, 2, 6, NULL, 6, 6, 10, 2),
    ('title-05', 35.15, 52, true, 7, 4, NULL, 7, 7, 7, 11, 4),
    ('title-06', 42.18, 62, false, 8, 6, 12, 8, 8, NULL, 12, 6),
    ('title-07', 49.21, 72, true, 1, 8, 15, 1, NULL, 1, 1, 8),
    ('title-08', 56.24, 82, false, 2, 10, 18, NULL, 2, 2, 2, 10);

CREATE TABLE hub.ops_comment (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_comment_id    integer      REFERENCES hub.fin_comment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_comment (amount, quantity, project_id, workorder_id, workorder_row_id, fin_comment_id, created_by, changed_by) VALUES
    (7.03, 11, 4, 21, 46, 4, 8, 9),
    (14.06, 21, 5, 23, 1, 5, 9, 11),
    (21.09, 31, 6, 1, 4, 6, 10, 1),
    (28.12, 41, 7, 3, 7, NULL, 11, 3),
    (35.15, 51, 8, 5, NULL, 8, 12, 5),
    (42.18, 61, 1, 7, 13, 1, 1, 7),
    (49.21, 71, 2, 9, 16, 2, 2, 9),
    (56.24, 81, 3, 11, 19, NULL, 3, 11);

CREATE TABLE hub.qa_comment (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_comment_id    integer      REFERENCES hub.ops_comment (id),
    fin_comment_id    integer      REFERENCES hub.fin_comment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_comment (quantity, is_active, due_date, project_id, workorder_id, workorder_row_id, ops_comment_id, fin_comment_id, created_by, changed_by) VALUES
    (10, true, '2026-02-02', 5, 22, 47, 5, 5, 9, 10),
    (20, false, '2026-03-03', 6, 24, 2, 6, 6, 10, 12),
    (30, true, '2026-04-04', 7, 2, 5, 7, NULL, 11, 2),
    (40, false, '2026-05-05', 8, 4, 8, NULL, 8, 12, 4),
    (50, true, '2026-06-06', 1, 6, NULL, 1, 1, 1, 6),
    (60, false, '2026-07-07', 2, 8, 14, 2, 2, 2, 8),
    (70, true, '2026-08-08', 3, 10, 17, 3, NULL, 3, 10),
    (80, false, '2026-09-09', 4, 12, 20, NULL, 4, 4, 12);

CREATE TABLE hub.proc_comment (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_comment_id     integer      REFERENCES hub.qa_comment (id),
    ops_comment_id    integer      REFERENCES hub.ops_comment (id),
    core_comment_id   integer      REFERENCES hub.core_comment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_comment (is_active, due_date, ref_no, priority, project_id, workorder_id, workorder_row_id, qa_comment_id, ops_comment_id, core_comment_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 'ref_no-01', 13, 6, 23, 48, 6, 6, 6, 10, 11),
    (true, '2026-03-03', 'ref_no-02', 23, 7, 1, 3, 7, 7, NULL, 11, 1),
    (false, '2026-04-04', 'ref_no-03', 33, 8, 3, 6, 8, NULL, 8, 12, 3),
    (true, '2026-05-05', 'ref_no-04', 43, 1, 5, 9, NULL, 1, 1, 1, 5),
    (false, '2026-06-06', 'ref_no-05', 53, 2, 7, NULL, 2, 2, 2, 2, 7),
    (true, '2026-07-07', 'ref_no-06', 63, 3, 9, 15, 3, 3, NULL, 3, 9),
    (false, '2026-08-08', 'ref_no-07', 73, 4, 11, 18, 4, NULL, 4, 4, 11),
    (true, '2026-09-09', 'ref_no-08', 83, 5, 13, 21, NULL, 5, 5, 5, 1);

CREATE TABLE hub.plan_comment (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_comment_id   integer      REFERENCES hub.proc_comment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_comment (due_date, ref_no, project_id, workorder_id, workorder_row_id, proc_comment_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 7, 24, 1, 7, 11, 12),
    ('2026-03-03', 'ref_no-02', 8, 2, 4, 8, 12, 2),
    ('2026-04-04', 'ref_no-03', 1, 4, 7, 1, 1, 4),
    ('2026-05-05', 'ref_no-04', 2, 6, 10, NULL, 2, 6),
    ('2026-06-06', 'ref_no-05', 3, 8, NULL, 3, 3, 8),
    ('2026-07-07', 'ref_no-06', 4, 10, 16, 4, 4, 10),
    ('2026-08-08', 'ref_no-07', 5, 12, 19, 5, 5, 12),
    ('2026-09-09', 'ref_no-08', 6, 14, 22, NULL, 6, 2);

CREATE TABLE hub.doc_comment (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_comment_id   integer      REFERENCES hub.plan_comment (id),
    proc_comment_id   integer      REFERENCES hub.proc_comment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_comment (ref_no, priority, rate, project_id, workorder_id, workorder_row_id, plan_comment_id, proc_comment_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 1.0013, 8, 1, 2, 8, 8, 12, 1),
    ('ref_no-02', 21, 2.0026, 1, 3, 5, 1, 1, 1, 3),
    ('ref_no-03', 31, 3.0039, 2, 5, 8, 2, NULL, 2, 5),
    ('ref_no-04', 41, 4.0052, 3, 7, 11, NULL, 3, 3, 7),
    ('ref_no-05', 51, 5.0065, 4, 9, NULL, 4, 4, 4, 9),
    ('ref_no-06', 61, 6.0078, 5, 11, 17, 5, 5, 5, 11),
    ('ref_no-07', 71, 7.0091, 6, 13, 20, 6, NULL, 6, 1),
    ('ref_no-08', 81, 8.0104, 7, 15, 23, NULL, 7, 7, 3);

CREATE TABLE hub.crm_comment (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_comment_id    integer      REFERENCES hub.doc_comment (id),
    plan_comment_id   integer      REFERENCES hub.plan_comment (id),
    qa_comment_id     integer      REFERENCES hub.qa_comment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_comment (priority, rate, note, code, project_id, workorder_id, workorder_row_id, doc_comment_id, plan_comment_id, qa_comment_id, created_by, changed_by) VALUES
    (10, 1.0013, 'note-01', 'code-01', 1, 2, 3, 1, 1, 1, 1, 2),
    (20, 2.0026, 'note-02', 'code-02', 2, 4, 6, 2, 2, NULL, 2, 4),
    (30, 3.0039, 'note-03', 'code-03', 3, 6, 9, 3, NULL, 3, 3, 6),
    (40, 4.0052, 'note-04', 'code-04', 4, 8, 12, NULL, 4, 4, 4, 8),
    (50, 5.0065, 'note-05', 'code-05', 5, 10, NULL, 5, 5, 5, 5, 10),
    (60, 6.0078, 'note-06', 'code-06', 6, 12, 18, 6, 6, NULL, 6, 12),
    (70, 7.0091, 'note-07', 'code-07', 7, 14, 21, 7, NULL, 7, 7, 2),
    (80, 8.0104, 'note-08', 'code-08', 8, 16, 24, NULL, 8, 8, 8, 4);

CREATE TABLE hub.asset_comment (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_comment_id    integer      REFERENCES hub.crm_comment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_comment (rate, note, project_id, workorder_id, workorder_row_id, crm_comment_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 2, 3, 4, 2, 2, 3),
    (2.0026, 'note-02', 3, 5, 7, 3, 3, 5),
    (3.0039, 'note-03', 4, 7, 10, 4, 4, 7),
    (4.0052, 'note-04', 5, 9, 13, NULL, 5, 9),
    (5.0065, 'note-05', 6, 11, NULL, 6, 6, 11),
    (6.0078, 'note-06', 7, 13, 19, 7, 7, 1),
    (7.0091, 'note-07', 8, 15, 22, 8, 8, 3),
    (8.0104, 'note-08', 1, 17, 25, NULL, 9, 5);

CREATE TABLE hub.sched_comment (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_comment_id  integer      REFERENCES hub.asset_comment (id),
    crm_comment_id    integer      REFERENCES hub.crm_comment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_comment (note, code, title, project_id, workorder_id, workorder_row_id, asset_comment_id, crm_comment_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 'title-01', 3, 4, 5, 3, 3, 3, 4),
    ('note-02', 'code-02', 'title-02', 4, 6, 8, 4, 4, 4, 6),
    ('note-03', 'code-03', 'title-03', 5, 8, 11, 5, NULL, 5, 8),
    ('note-04', 'code-04', 'title-04', 6, 10, 14, NULL, 6, 6, 10),
    ('note-05', 'code-05', 'title-05', 7, 12, NULL, 7, 7, 7, 12),
    ('note-06', 'code-06', 'title-06', 8, 14, 20, 8, 8, 8, 2),
    ('note-07', 'code-07', 'title-07', 1, 16, 23, 1, NULL, 9, 4),
    ('note-08', 'code-08', 'title-08', 2, 18, 26, NULL, 2, 10, 6);

CREATE TABLE hub.core_tag (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_comment_id  integer      REFERENCES hub.sched_comment (id),
    asset_comment_id  integer      REFERENCES hub.asset_comment (id),
    doc_comment_id    integer      REFERENCES hub.doc_comment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_tag (code, title, amount, quantity, project_id, workorder_id, workorder_row_id, sched_comment_id, asset_comment_id, doc_comment_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 7.03, 13, 4, 5, 6, 4, 4, 4, 4, 5),
    ('code-02', 'title-02', 14.06, 23, 5, 7, 9, 5, 5, NULL, 5, 7),
    ('code-03', 'title-03', 21.09, 33, 6, 9, 12, 6, NULL, 6, 6, 9),
    ('code-04', 'title-04', 28.12, 43, 7, 11, 15, NULL, 7, 7, 7, 11),
    ('code-05', 'title-05', 35.15, 53, 8, 13, NULL, 8, 8, 8, 8, 1),
    ('code-06', 'title-06', 42.18, 63, 1, 15, 21, 1, 1, NULL, 9, 3),
    ('code-07', 'title-07', 49.21, 73, 2, 17, 24, 2, NULL, 2, 10, 5),
    ('code-08', 'title-08', 56.24, 83, 3, 19, 27, NULL, 3, 3, 11, 7);

CREATE TABLE hub.fin_tag (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_tag_id       integer      REFERENCES hub.core_tag (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_tag (title, amount, project_id, workorder_id, workorder_row_id, core_tag_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 5, 6, 7, 5, 5, 6),
    ('title-02', 14.06, 6, 8, 10, 6, 6, 8),
    ('title-03', 21.09, 7, 10, 13, 7, 7, 10),
    ('title-04', 28.12, 8, 12, 16, NULL, 8, 12),
    ('title-05', 35.15, 1, 14, NULL, 1, 9, 2),
    ('title-06', 42.18, 2, 16, 22, 2, 10, 4),
    ('title-07', 49.21, 3, 18, 25, 3, 11, 6),
    ('title-08', 56.24, 4, 20, 28, NULL, 12, 8);

CREATE TABLE hub.ops_tag (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_tag_id        integer      REFERENCES hub.fin_tag (id),
    core_tag_id       integer      REFERENCES hub.core_tag (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_tag (amount, quantity, is_active, project_id, workorder_id, workorder_row_id, fin_tag_id, core_tag_id, created_by, changed_by) VALUES
    (7.03, 11, false, 6, 7, 8, 6, 6, 6, 7),
    (14.06, 21, true, 7, 9, 11, 7, 7, 7, 9),
    (21.09, 31, false, 8, 11, 14, 8, NULL, 8, 11),
    (28.12, 41, true, 1, 13, 17, NULL, 1, 9, 1),
    (35.15, 51, false, 2, 15, NULL, 2, 2, 10, 3),
    (42.18, 61, true, 3, 17, 23, 3, 3, 11, 5),
    (49.21, 71, false, 4, 19, 26, 4, NULL, 12, 7),
    (56.24, 81, true, 5, 21, 29, NULL, 5, 1, 9);

CREATE TABLE hub.qa_tag (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_tag_id        integer      REFERENCES hub.ops_tag (id),
    fin_tag_id        integer      REFERENCES hub.fin_tag (id),
    sched_comment_id  integer      REFERENCES hub.sched_comment (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_tag (quantity, is_active, due_date, ref_no, project_id, workorder_id, workorder_row_id, ops_tag_id, fin_tag_id, sched_comment_id, created_by, changed_by) VALUES
    (10, true, '2026-02-02', 'ref_no-01', 7, 8, 9, 7, 7, 7, 7, 8),
    (20, false, '2026-03-03', 'ref_no-02', 8, 10, 12, 8, 8, NULL, 8, 10),
    (30, true, '2026-04-04', 'ref_no-03', 1, 12, 15, 1, NULL, 1, 9, 12),
    (40, false, '2026-05-05', 'ref_no-04', 2, 14, 18, NULL, 2, 2, 10, 2),
    (50, true, '2026-06-06', 'ref_no-05', 3, 16, NULL, 3, 3, 3, 11, 4),
    (60, false, '2026-07-07', 'ref_no-06', 4, 18, 24, 4, 4, NULL, 12, 6),
    (70, true, '2026-08-08', 'ref_no-07', 5, 20, 27, 5, NULL, 5, 1, 8),
    (80, false, '2026-09-09', 'ref_no-08', 6, 22, 30, NULL, 6, 6, 2, 10);

CREATE TABLE hub.proc_tag (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_tag_id         integer      REFERENCES hub.qa_tag (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_tag (is_active, due_date, project_id, workorder_id, workorder_row_id, qa_tag_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 8, 9, 10, 8, 8, 9),
    (true, '2026-03-03', 1, 11, 13, 1, 9, 11),
    (false, '2026-04-04', 2, 13, 16, 2, 10, 1),
    (true, '2026-05-05', 3, 15, 19, NULL, 11, 3),
    (false, '2026-06-06', 4, 17, NULL, 4, 12, 5),
    (true, '2026-07-07', 5, 19, 25, 5, 1, 7),
    (false, '2026-08-08', 6, 21, 28, 6, 2, 9),
    (true, '2026-09-09', 7, 23, 31, NULL, 3, 11);

CREATE TABLE hub.plan_tag (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_tag_id       integer      REFERENCES hub.proc_tag (id),
    qa_tag_id         integer      REFERENCES hub.qa_tag (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_tag (due_date, ref_no, priority, project_id, workorder_id, workorder_row_id, proc_tag_id, qa_tag_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 12, 1, 10, 11, 1, 1, 9, 10),
    ('2026-03-03', 'ref_no-02', 22, 2, 12, 14, 2, 2, 10, 12),
    ('2026-04-04', 'ref_no-03', 32, 3, 14, 17, 3, NULL, 11, 2),
    ('2026-05-05', 'ref_no-04', 42, 4, 16, 20, NULL, 4, 12, 4),
    ('2026-06-06', 'ref_no-05', 52, 5, 18, NULL, 5, 5, 1, 6),
    ('2026-07-07', 'ref_no-06', 62, 6, 20, 26, 6, 6, 2, 8),
    ('2026-08-08', 'ref_no-07', 72, 7, 22, 29, 7, NULL, 3, 10),
    ('2026-09-09', 'ref_no-08', 82, 8, 24, 32, NULL, 8, 4, 12);

CREATE TABLE hub.doc_tag (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_tag_id       integer      REFERENCES hub.plan_tag (id),
    proc_tag_id       integer      REFERENCES hub.proc_tag (id),
    ops_tag_id        integer      REFERENCES hub.ops_tag (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_tag (ref_no, priority, rate, note, project_id, workorder_id, workorder_row_id, plan_tag_id, proc_tag_id, ops_tag_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 1.0013, 'note-01', 2, 11, 12, 2, 2, 2, 10, 11),
    ('ref_no-02', 21, 2.0026, 'note-02', 3, 13, 15, 3, 3, NULL, 11, 1),
    ('ref_no-03', 31, 3.0039, 'note-03', 4, 15, 18, 4, NULL, 4, 12, 3),
    ('ref_no-04', 41, 4.0052, 'note-04', 5, 17, 21, NULL, 5, 5, 1, 5),
    ('ref_no-05', 51, 5.0065, 'note-05', 6, 19, NULL, 6, 6, 6, 2, 7),
    ('ref_no-06', 61, 6.0078, 'note-06', 7, 21, 27, 7, 7, NULL, 3, 9),
    ('ref_no-07', 71, 7.0091, 'note-07', 8, 23, 30, 8, NULL, 8, 4, 11),
    ('ref_no-08', 81, 8.0104, 'note-08', 1, 1, 33, NULL, 1, 1, 5, 1);

CREATE TABLE hub.crm_tag (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_tag_id        integer      REFERENCES hub.doc_tag (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_tag (priority, rate, project_id, workorder_id, workorder_row_id, doc_tag_id, created_by, changed_by) VALUES
    (10, 1.0013, 3, 12, 13, 3, 11, 12),
    (20, 2.0026, 4, 14, 16, 4, 12, 2),
    (30, 3.0039, 5, 16, 19, 5, 1, 4),
    (40, 4.0052, 6, 18, 22, NULL, 2, 6),
    (50, 5.0065, 7, 20, NULL, 7, 3, 8),
    (60, 6.0078, 8, 22, 28, 8, 4, 10),
    (70, 7.0091, 1, 24, 31, 1, 5, 12),
    (80, 8.0104, 2, 2, 34, NULL, 6, 2);

CREATE TABLE hub.asset_tag (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_tag_id        integer      REFERENCES hub.crm_tag (id),
    doc_tag_id        integer      REFERENCES hub.doc_tag (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_tag (rate, note, code, project_id, workorder_id, workorder_row_id, crm_tag_id, doc_tag_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 'code-01', 4, 13, 14, 4, 4, 12, 1),
    (2.0026, 'note-02', 'code-02', 5, 15, 17, 5, 5, 1, 3),
    (3.0039, 'note-03', 'code-03', 6, 17, 20, 6, NULL, 2, 5),
    (4.0052, 'note-04', 'code-04', 7, 19, 23, NULL, 7, 3, 7),
    (5.0065, 'note-05', 'code-05', 8, 21, NULL, 8, 8, 4, 9),
    (6.0078, 'note-06', 'code-06', 1, 23, 29, 1, 1, 5, 11),
    (7.0091, 'note-07', 'code-07', 2, 1, 32, 2, NULL, 6, 1),
    (8.0104, 'note-08', 'code-08', 3, 3, 35, NULL, 3, 7, 3);

CREATE TABLE hub.sched_tag (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_tag_id      integer      REFERENCES hub.asset_tag (id),
    crm_tag_id        integer      REFERENCES hub.crm_tag (id),
    plan_tag_id       integer      REFERENCES hub.plan_tag (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_tag (note, code, title, amount, project_id, workorder_id, workorder_row_id, asset_tag_id, crm_tag_id, plan_tag_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 'title-01', 7.03, 5, 14, 15, 5, 5, 5, 1, 2),
    ('note-02', 'code-02', 'title-02', 14.06, 6, 16, 18, 6, 6, NULL, 2, 4),
    ('note-03', 'code-03', 'title-03', 21.09, 7, 18, 21, 7, NULL, 7, 3, 6),
    ('note-04', 'code-04', 'title-04', 28.12, 8, 20, 24, NULL, 8, 8, 4, 8),
    ('note-05', 'code-05', 'title-05', 35.15, 1, 22, NULL, 1, 1, 1, 5, 10),
    ('note-06', 'code-06', 'title-06', 42.18, 2, 24, 30, 2, 2, NULL, 6, 12),
    ('note-07', 'code-07', 'title-07', 49.21, 3, 2, 33, 3, NULL, 3, 7, 2),
    ('note-08', 'code-08', 'title-08', 56.24, 4, 4, 36, NULL, 4, 4, 8, 4);

CREATE TABLE hub.core_category (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_tag_id      integer      REFERENCES hub.sched_tag (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_category (code, title, project_id, workorder_id, workorder_row_id, sched_tag_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 6, 15, 16, 6, 2, 3),
    ('code-02', 'title-02', 7, 17, 19, 7, 3, 5),
    ('code-03', 'title-03', 8, 19, 22, 8, 4, 7),
    ('code-04', 'title-04', 1, 21, 25, NULL, 5, 9),
    ('code-05', 'title-05', 2, 23, NULL, 2, 6, 11),
    ('code-06', 'title-06', 3, 1, 31, 3, 7, 1),
    ('code-07', 'title-07', 4, 3, 34, 4, 8, 3),
    ('code-08', 'title-08', 5, 5, 37, NULL, 9, 5);

CREATE TABLE hub.fin_category (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_category_id  integer      REFERENCES hub.core_category (id),
    sched_tag_id      integer      REFERENCES hub.sched_tag (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_category (title, amount, quantity, project_id, workorder_id, workorder_row_id, core_category_id, sched_tag_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 12, 7, 16, 17, 7, 7, 3, 4),
    ('title-02', 14.06, 22, 8, 18, 20, 8, 8, 4, 6),
    ('title-03', 21.09, 32, 1, 20, 23, 1, NULL, 5, 8),
    ('title-04', 28.12, 42, 2, 22, 26, NULL, 2, 6, 10),
    ('title-05', 35.15, 52, 3, 24, NULL, 3, 3, 7, 12),
    ('title-06', 42.18, 62, 4, 2, 32, 4, 4, 8, 2),
    ('title-07', 49.21, 72, 5, 4, 35, 5, NULL, 9, 4),
    ('title-08', 56.24, 82, 6, 6, 38, NULL, 6, 10, 6);

CREATE TABLE hub.ops_category (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_category_id   integer      REFERENCES hub.fin_category (id),
    core_category_id  integer      REFERENCES hub.core_category (id),
    asset_tag_id      integer      REFERENCES hub.asset_tag (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_category (amount, quantity, is_active, due_date, project_id, workorder_id, workorder_row_id, fin_category_id, core_category_id, asset_tag_id, created_by, changed_by) VALUES
    (7.03, 11, false, '2026-02-02', 8, 17, 18, 8, 8, 8, 4, 5),
    (14.06, 21, true, '2026-03-03', 1, 19, 21, 1, 1, NULL, 5, 7),
    (21.09, 31, false, '2026-04-04', 2, 21, 24, 2, NULL, 2, 6, 9),
    (28.12, 41, true, '2026-05-05', 3, 23, 27, NULL, 3, 3, 7, 11),
    (35.15, 51, false, '2026-06-06', 4, 1, NULL, 4, 4, 4, 8, 1),
    (42.18, 61, true, '2026-07-07', 5, 3, 33, 5, 5, NULL, 9, 3),
    (49.21, 71, false, '2026-08-08', 6, 5, 36, 6, NULL, 6, 10, 5),
    (56.24, 81, true, '2026-09-09', 7, 7, 39, NULL, 7, 7, 11, 7);

CREATE TABLE hub.qa_category (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_category_id   integer      REFERENCES hub.ops_category (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_category (quantity, is_active, project_id, workorder_id, workorder_row_id, ops_category_id, created_by, changed_by) VALUES
    (10, true, 1, 18, 19, 1, 5, 6),
    (20, false, 2, 20, 22, 2, 6, 8),
    (30, true, 3, 22, 25, 3, 7, 10),
    (40, false, 4, 24, 28, NULL, 8, 12),
    (50, true, 5, 2, NULL, 5, 9, 2),
    (60, false, 6, 4, 34, 6, 10, 4),
    (70, true, 7, 6, 37, 7, 11, 6),
    (80, false, 8, 8, 40, NULL, 12, 8);

CREATE TABLE hub.proc_category (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_category_id    integer      REFERENCES hub.qa_category (id),
    ops_category_id   integer      REFERENCES hub.ops_category (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_category (is_active, due_date, ref_no, project_id, workorder_id, workorder_row_id, qa_category_id, ops_category_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 'ref_no-01', 2, 19, 20, 2, 2, 6, 7),
    (true, '2026-03-03', 'ref_no-02', 3, 21, 23, 3, 3, 7, 9),
    (false, '2026-04-04', 'ref_no-03', 4, 23, 26, 4, NULL, 8, 11),
    (true, '2026-05-05', 'ref_no-04', 5, 1, 29, NULL, 5, 9, 1),
    (false, '2026-06-06', 'ref_no-05', 6, 3, NULL, 6, 6, 10, 3),
    (true, '2026-07-07', 'ref_no-06', 7, 5, 35, 7, 7, 11, 5),
    (false, '2026-08-08', 'ref_no-07', 8, 7, 38, 8, NULL, 12, 7),
    (true, '2026-09-09', 'ref_no-08', 1, 9, 41, NULL, 1, 1, 9);

CREATE TABLE hub.plan_category (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_category_id  integer      REFERENCES hub.proc_category (id),
    qa_category_id    integer      REFERENCES hub.qa_category (id),
    fin_category_id   integer      REFERENCES hub.fin_category (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_category (due_date, ref_no, priority, rate, project_id, workorder_id, workorder_row_id, proc_category_id, qa_category_id, fin_category_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 12, 1.0013, 3, 20, 21, 3, 3, 3, 7, 8),
    ('2026-03-03', 'ref_no-02', 22, 2.0026, 4, 22, 24, 4, 4, NULL, 8, 10),
    ('2026-04-04', 'ref_no-03', 32, 3.0039, 5, 24, 27, 5, NULL, 5, 9, 12),
    ('2026-05-05', 'ref_no-04', 42, 4.0052, 6, 2, 30, NULL, 6, 6, 10, 2),
    ('2026-06-06', 'ref_no-05', 52, 5.0065, 7, 4, NULL, 7, 7, 7, 11, 4),
    ('2026-07-07', 'ref_no-06', 62, 6.0078, 8, 6, 36, 8, 8, NULL, 12, 6),
    ('2026-08-08', 'ref_no-07', 72, 7.0091, 1, 8, 39, 1, NULL, 1, 1, 8),
    ('2026-09-09', 'ref_no-08', 82, 8.0104, 2, 10, 42, NULL, 2, 2, 2, 10);

CREATE TABLE hub.doc_category (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_category_id  integer      REFERENCES hub.plan_category (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_category (ref_no, priority, project_id, workorder_id, workorder_row_id, plan_category_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 4, 21, 22, 4, 8, 9),
    ('ref_no-02', 21, 5, 23, 25, 5, 9, 11),
    ('ref_no-03', 31, 6, 1, 28, 6, 10, 1),
    ('ref_no-04', 41, 7, 3, 31, NULL, 11, 3),
    ('ref_no-05', 51, 8, 5, NULL, 8, 12, 5),
    ('ref_no-06', 61, 1, 7, 37, 1, 1, 7),
    ('ref_no-07', 71, 2, 9, 40, 2, 2, 9),
    ('ref_no-08', 81, 3, 11, 43, NULL, 3, 11);

CREATE TABLE hub.crm_category (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_category_id   integer      REFERENCES hub.doc_category (id),
    plan_category_id  integer      REFERENCES hub.plan_category (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_category (priority, rate, note, project_id, workorder_id, workorder_row_id, doc_category_id, plan_category_id, created_by, changed_by) VALUES
    (10, 1.0013, 'note-01', 5, 22, 23, 5, 5, 9, 10),
    (20, 2.0026, 'note-02', 6, 24, 26, 6, 6, 10, 12),
    (30, 3.0039, 'note-03', 7, 2, 29, 7, NULL, 11, 2),
    (40, 4.0052, 'note-04', 8, 4, 32, NULL, 8, 12, 4),
    (50, 5.0065, 'note-05', 1, 6, NULL, 1, 1, 1, 6),
    (60, 6.0078, 'note-06', 2, 8, 38, 2, 2, 2, 8),
    (70, 7.0091, 'note-07', 3, 10, 41, 3, NULL, 3, 10),
    (80, 8.0104, 'note-08', 4, 12, 44, NULL, 4, 4, 12);

CREATE TABLE hub.asset_category (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_category_id   integer      REFERENCES hub.crm_category (id),
    doc_category_id   integer      REFERENCES hub.doc_category (id),
    proc_category_id  integer      REFERENCES hub.proc_category (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_category (rate, note, code, title, project_id, workorder_id, workorder_row_id, crm_category_id, doc_category_id, proc_category_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 'code-01', 'title-01', 6, 23, 24, 6, 6, 6, 10, 11),
    (2.0026, 'note-02', 'code-02', 'title-02', 7, 1, 27, 7, 7, NULL, 11, 1),
    (3.0039, 'note-03', 'code-03', 'title-03', 8, 3, 30, 8, NULL, 8, 12, 3),
    (4.0052, 'note-04', 'code-04', 'title-04', 1, 5, 33, NULL, 1, 1, 1, 5),
    (5.0065, 'note-05', 'code-05', 'title-05', 2, 7, NULL, 2, 2, 2, 2, 7),
    (6.0078, 'note-06', 'code-06', 'title-06', 3, 9, 39, 3, 3, NULL, 3, 9),
    (7.0091, 'note-07', 'code-07', 'title-07', 4, 11, 42, 4, NULL, 4, 4, 11),
    (8.0104, 'note-08', 'code-08', 'title-08', 5, 13, 45, NULL, 5, 5, 5, 1);

CREATE TABLE hub.sched_category (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_category_id integer      REFERENCES hub.asset_category (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_category (note, code, project_id, workorder_id, workorder_row_id, asset_category_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 7, 24, 25, 7, 11, 12),
    ('note-02', 'code-02', 8, 2, 28, 8, 12, 2),
    ('note-03', 'code-03', 1, 4, 31, 1, 1, 4),
    ('note-04', 'code-04', 2, 6, 34, NULL, 2, 6),
    ('note-05', 'code-05', 3, 8, NULL, 3, 3, 8),
    ('note-06', 'code-06', 4, 10, 40, 4, 4, 10),
    ('note-07', 'code-07', 5, 12, 43, 5, 5, 12),
    ('note-08', 'code-08', 6, 14, 46, NULL, 6, 2);

CREATE TABLE hub.core_status_history (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_category_id integer      REFERENCES hub.sched_category (id),
    asset_category_id integer      REFERENCES hub.asset_category (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_status_history (code, title, amount, project_id, workorder_id, workorder_row_id, sched_category_id, asset_category_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 7.03, 8, 1, 26, 8, 8, 12, 1),
    ('code-02', 'title-02', 14.06, 1, 3, 29, 1, 1, 1, 3),
    ('code-03', 'title-03', 21.09, 2, 5, 32, 2, NULL, 2, 5),
    ('code-04', 'title-04', 28.12, 3, 7, 35, NULL, 3, 3, 7),
    ('code-05', 'title-05', 35.15, 4, 9, NULL, 4, 4, 4, 9),
    ('code-06', 'title-06', 42.18, 5, 11, 41, 5, 5, 5, 11),
    ('code-07', 'title-07', 49.21, 6, 13, 44, 6, NULL, 6, 1),
    ('code-08', 'title-08', 56.24, 7, 15, 47, NULL, 7, 7, 3);

CREATE TABLE hub.fin_status_history (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_status_history_id integer      REFERENCES hub.core_status_history (id),
    sched_category_id integer      REFERENCES hub.sched_category (id),
    crm_category_id   integer      REFERENCES hub.crm_category (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_status_history (title, amount, quantity, is_active, project_id, workorder_id, workorder_row_id, core_status_history_id, sched_category_id, crm_category_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 12, true, 1, 2, 27, 1, 1, 1, 1, 2),
    ('title-02', 14.06, 22, false, 2, 4, 30, 2, 2, NULL, 2, 4),
    ('title-03', 21.09, 32, true, 3, 6, 33, 3, NULL, 3, 3, 6),
    ('title-04', 28.12, 42, false, 4, 8, 36, NULL, 4, 4, 4, 8),
    ('title-05', 35.15, 52, true, 5, 10, NULL, 5, 5, 5, 5, 10),
    ('title-06', 42.18, 62, false, 6, 12, 42, 6, 6, NULL, 6, 12),
    ('title-07', 49.21, 72, true, 7, 14, 45, 7, NULL, 7, 7, 2),
    ('title-08', 56.24, 82, false, 8, 16, 48, NULL, 8, 8, 8, 4);

CREATE TABLE hub.ops_status_history (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_status_history_id integer      REFERENCES hub.fin_status_history (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_status_history (amount, quantity, project_id, workorder_id, workorder_row_id, fin_status_history_id, created_by, changed_by) VALUES
    (7.03, 11, 2, 3, 28, 2, 2, 3),
    (14.06, 21, 3, 5, 31, 3, 3, 5),
    (21.09, 31, 4, 7, 34, 4, 4, 7),
    (28.12, 41, 5, 9, 37, NULL, 5, 9),
    (35.15, 51, 6, 11, NULL, 6, 6, 11),
    (42.18, 61, 7, 13, 43, 7, 7, 1),
    (49.21, 71, 8, 15, 46, 8, 8, 3),
    (56.24, 81, 1, 17, 1, NULL, 9, 5);

CREATE TABLE hub.qa_status_history (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_status_history_id integer      REFERENCES hub.ops_status_history (id),
    fin_status_history_id integer      REFERENCES hub.fin_status_history (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_status_history (quantity, is_active, due_date, project_id, workorder_id, workorder_row_id, ops_status_history_id, fin_status_history_id, created_by, changed_by) VALUES
    (10, true, '2026-02-02', 3, 4, 29, 3, 3, 3, 4),
    (20, false, '2026-03-03', 4, 6, 32, 4, 4, 4, 6),
    (30, true, '2026-04-04', 5, 8, 35, 5, NULL, 5, 8),
    (40, false, '2026-05-05', 6, 10, 38, NULL, 6, 6, 10),
    (50, true, '2026-06-06', 7, 12, NULL, 7, 7, 7, 12),
    (60, false, '2026-07-07', 8, 14, 44, 8, 8, 8, 2),
    (70, true, '2026-08-08', 1, 16, 47, 1, NULL, 9, 4),
    (80, false, '2026-09-09', 2, 18, 2, NULL, 2, 10, 6);

CREATE TABLE hub.proc_status_history (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_status_history_id integer      REFERENCES hub.qa_status_history (id),
    ops_status_history_id integer      REFERENCES hub.ops_status_history (id),
    core_status_history_id integer      REFERENCES hub.core_status_history (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_status_history (is_active, due_date, ref_no, priority, project_id, workorder_id, workorder_row_id, qa_status_history_id, ops_status_history_id, core_status_history_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 'ref_no-01', 13, 4, 5, 30, 4, 4, 4, 4, 5),
    (true, '2026-03-03', 'ref_no-02', 23, 5, 7, 33, 5, 5, NULL, 5, 7),
    (false, '2026-04-04', 'ref_no-03', 33, 6, 9, 36, 6, NULL, 6, 6, 9),
    (true, '2026-05-05', 'ref_no-04', 43, 7, 11, 39, NULL, 7, 7, 7, 11),
    (false, '2026-06-06', 'ref_no-05', 53, 8, 13, NULL, 8, 8, 8, 8, 1),
    (true, '2026-07-07', 'ref_no-06', 63, 1, 15, 45, 1, 1, NULL, 9, 3),
    (false, '2026-08-08', 'ref_no-07', 73, 2, 17, 48, 2, NULL, 2, 10, 5),
    (true, '2026-09-09', 'ref_no-08', 83, 3, 19, 3, NULL, 3, 3, 11, 7);

CREATE TABLE hub.plan_status_history (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_status_history_id integer      REFERENCES hub.proc_status_history (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_status_history (due_date, ref_no, project_id, workorder_id, workorder_row_id, proc_status_history_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 5, 6, 31, 5, 5, 6),
    ('2026-03-03', 'ref_no-02', 6, 8, 34, 6, 6, 8),
    ('2026-04-04', 'ref_no-03', 7, 10, 37, 7, 7, 10),
    ('2026-05-05', 'ref_no-04', 8, 12, 40, NULL, 8, 12),
    ('2026-06-06', 'ref_no-05', 1, 14, NULL, 1, 9, 2),
    ('2026-07-07', 'ref_no-06', 2, 16, 46, 2, 10, 4),
    ('2026-08-08', 'ref_no-07', 3, 18, 1, 3, 11, 6),
    ('2026-09-09', 'ref_no-08', 4, 20, 4, NULL, 12, 8);

CREATE TABLE hub.doc_status_history (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_status_history_id integer      REFERENCES hub.plan_status_history (id),
    proc_status_history_id integer      REFERENCES hub.proc_status_history (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_status_history (ref_no, priority, rate, project_id, workorder_id, workorder_row_id, plan_status_history_id, proc_status_history_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 1.0013, 6, 7, 32, 6, 6, 6, 7),
    ('ref_no-02', 21, 2.0026, 7, 9, 35, 7, 7, 7, 9),
    ('ref_no-03', 31, 3.0039, 8, 11, 38, 8, NULL, 8, 11),
    ('ref_no-04', 41, 4.0052, 1, 13, 41, NULL, 1, 9, 1),
    ('ref_no-05', 51, 5.0065, 2, 15, NULL, 2, 2, 10, 3),
    ('ref_no-06', 61, 6.0078, 3, 17, 47, 3, 3, 11, 5),
    ('ref_no-07', 71, 7.0091, 4, 19, 2, 4, NULL, 12, 7),
    ('ref_no-08', 81, 8.0104, 5, 21, 5, NULL, 5, 1, 9);

CREATE TABLE hub.crm_status_history (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_status_history_id integer      REFERENCES hub.doc_status_history (id),
    plan_status_history_id integer      REFERENCES hub.plan_status_history (id),
    qa_status_history_id integer      REFERENCES hub.qa_status_history (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_status_history (priority, rate, note, code, project_id, workorder_id, workorder_row_id, doc_status_history_id, plan_status_history_id, qa_status_history_id, created_by, changed_by) VALUES
    (10, 1.0013, 'note-01', 'code-01', 7, 8, 33, 7, 7, 7, 7, 8),
    (20, 2.0026, 'note-02', 'code-02', 8, 10, 36, 8, 8, NULL, 8, 10),
    (30, 3.0039, 'note-03', 'code-03', 1, 12, 39, 1, NULL, 1, 9, 12),
    (40, 4.0052, 'note-04', 'code-04', 2, 14, 42, NULL, 2, 2, 10, 2),
    (50, 5.0065, 'note-05', 'code-05', 3, 16, NULL, 3, 3, 3, 11, 4),
    (60, 6.0078, 'note-06', 'code-06', 4, 18, 48, 4, 4, NULL, 12, 6),
    (70, 7.0091, 'note-07', 'code-07', 5, 20, 3, 5, NULL, 5, 1, 8),
    (80, 8.0104, 'note-08', 'code-08', 6, 22, 6, NULL, 6, 6, 2, 10);

CREATE TABLE hub.asset_status_history (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_status_history_id integer      REFERENCES hub.crm_status_history (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_status_history (rate, note, project_id, workorder_id, workorder_row_id, crm_status_history_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 8, 9, 34, 8, 8, 9),
    (2.0026, 'note-02', 1, 11, 37, 1, 9, 11),
    (3.0039, 'note-03', 2, 13, 40, 2, 10, 1),
    (4.0052, 'note-04', 3, 15, 43, NULL, 11, 3),
    (5.0065, 'note-05', 4, 17, NULL, 4, 12, 5),
    (6.0078, 'note-06', 5, 19, 1, 5, 1, 7),
    (7.0091, 'note-07', 6, 21, 4, 6, 2, 9),
    (8.0104, 'note-08', 7, 23, 7, NULL, 3, 11);

CREATE TABLE hub.sched_status_history (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_status_history_id integer      REFERENCES hub.asset_status_history (id),
    crm_status_history_id integer      REFERENCES hub.crm_status_history (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_status_history (note, code, title, project_id, workorder_id, workorder_row_id, asset_status_history_id, crm_status_history_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 'title-01', 1, 10, 35, 1, 1, 9, 10),
    ('note-02', 'code-02', 'title-02', 2, 12, 38, 2, 2, 10, 12),
    ('note-03', 'code-03', 'title-03', 3, 14, 41, 3, NULL, 11, 2),
    ('note-04', 'code-04', 'title-04', 4, 16, 44, NULL, 4, 12, 4),
    ('note-05', 'code-05', 'title-05', 5, 18, NULL, 5, 5, 1, 6),
    ('note-06', 'code-06', 'title-06', 6, 20, 2, 6, 6, 2, 8),
    ('note-07', 'code-07', 'title-07', 7, 22, 5, 7, NULL, 3, 10),
    ('note-08', 'code-08', 'title-08', 8, 24, 8, NULL, 8, 4, 12);

CREATE TABLE hub.core_approval (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_status_history_id integer      REFERENCES hub.sched_status_history (id),
    asset_status_history_id integer      REFERENCES hub.asset_status_history (id),
    doc_status_history_id integer      REFERENCES hub.doc_status_history (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_approval (code, title, amount, quantity, project_id, workorder_id, workorder_row_id, sched_status_history_id, asset_status_history_id, doc_status_history_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 7.03, 13, 2, 11, 36, 2, 2, 2, 10, 11),
    ('code-02', 'title-02', 14.06, 23, 3, 13, 39, 3, 3, NULL, 11, 1),
    ('code-03', 'title-03', 21.09, 33, 4, 15, 42, 4, NULL, 4, 12, 3),
    ('code-04', 'title-04', 28.12, 43, 5, 17, 45, NULL, 5, 5, 1, 5),
    ('code-05', 'title-05', 35.15, 53, 6, 19, NULL, 6, 6, 6, 2, 7),
    ('code-06', 'title-06', 42.18, 63, 7, 21, 3, 7, 7, NULL, 3, 9),
    ('code-07', 'title-07', 49.21, 73, 8, 23, 6, 8, NULL, 8, 4, 11),
    ('code-08', 'title-08', 56.24, 83, 1, 1, 9, NULL, 1, 1, 5, 1);

CREATE TABLE hub.fin_approval (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_approval_id  integer      REFERENCES hub.core_approval (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_approval (title, amount, project_id, workorder_id, workorder_row_id, core_approval_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 3, 12, 37, 3, 11, 12),
    ('title-02', 14.06, 4, 14, 40, 4, 12, 2),
    ('title-03', 21.09, 5, 16, 43, 5, 1, 4),
    ('title-04', 28.12, 6, 18, 46, NULL, 2, 6),
    ('title-05', 35.15, 7, 20, NULL, 7, 3, 8),
    ('title-06', 42.18, 8, 22, 4, 8, 4, 10),
    ('title-07', 49.21, 1, 24, 7, 1, 5, 12),
    ('title-08', 56.24, 2, 2, 10, NULL, 6, 2);

CREATE TABLE hub.ops_approval (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_approval_id   integer      REFERENCES hub.fin_approval (id),
    core_approval_id  integer      REFERENCES hub.core_approval (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_approval (amount, quantity, is_active, project_id, workorder_id, workorder_row_id, fin_approval_id, core_approval_id, created_by, changed_by) VALUES
    (7.03, 11, false, 4, 13, 38, 4, 4, 12, 1),
    (14.06, 21, true, 5, 15, 41, 5, 5, 1, 3),
    (21.09, 31, false, 6, 17, 44, 6, NULL, 2, 5),
    (28.12, 41, true, 7, 19, 47, NULL, 7, 3, 7),
    (35.15, 51, false, 8, 21, NULL, 8, 8, 4, 9),
    (42.18, 61, true, 1, 23, 5, 1, 1, 5, 11),
    (49.21, 71, false, 2, 1, 8, 2, NULL, 6, 1),
    (56.24, 81, true, 3, 3, 11, NULL, 3, 7, 3);

CREATE TABLE hub.qa_approval (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_approval_id   integer      REFERENCES hub.ops_approval (id),
    fin_approval_id   integer      REFERENCES hub.fin_approval (id),
    sched_status_history_id integer      REFERENCES hub.sched_status_history (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_approval (quantity, is_active, due_date, ref_no, project_id, workorder_id, workorder_row_id, ops_approval_id, fin_approval_id, sched_status_history_id, created_by, changed_by) VALUES
    (10, true, '2026-02-02', 'ref_no-01', 5, 14, 39, 5, 5, 5, 1, 2),
    (20, false, '2026-03-03', 'ref_no-02', 6, 16, 42, 6, 6, NULL, 2, 4),
    (30, true, '2026-04-04', 'ref_no-03', 7, 18, 45, 7, NULL, 7, 3, 6),
    (40, false, '2026-05-05', 'ref_no-04', 8, 20, 48, NULL, 8, 8, 4, 8),
    (50, true, '2026-06-06', 'ref_no-05', 1, 22, NULL, 1, 1, 1, 5, 10),
    (60, false, '2026-07-07', 'ref_no-06', 2, 24, 6, 2, 2, NULL, 6, 12),
    (70, true, '2026-08-08', 'ref_no-07', 3, 2, 9, 3, NULL, 3, 7, 2),
    (80, false, '2026-09-09', 'ref_no-08', 4, 4, 12, NULL, 4, 4, 8, 4);

CREATE TABLE hub.proc_approval (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_approval_id    integer      REFERENCES hub.qa_approval (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_approval (is_active, due_date, project_id, workorder_id, workorder_row_id, qa_approval_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 6, 15, 40, 6, 2, 3),
    (true, '2026-03-03', 7, 17, 43, 7, 3, 5),
    (false, '2026-04-04', 8, 19, 46, 8, 4, 7),
    (true, '2026-05-05', 1, 21, 1, NULL, 5, 9),
    (false, '2026-06-06', 2, 23, NULL, 2, 6, 11),
    (true, '2026-07-07', 3, 1, 7, 3, 7, 1),
    (false, '2026-08-08', 4, 3, 10, 4, 8, 3),
    (true, '2026-09-09', 5, 5, 13, NULL, 9, 5);

CREATE TABLE hub.plan_approval (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_approval_id  integer      REFERENCES hub.proc_approval (id),
    qa_approval_id    integer      REFERENCES hub.qa_approval (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_approval (due_date, ref_no, priority, project_id, workorder_id, workorder_row_id, proc_approval_id, qa_approval_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 12, 7, 16, 41, 7, 7, 3, 4),
    ('2026-03-03', 'ref_no-02', 22, 8, 18, 44, 8, 8, 4, 6),
    ('2026-04-04', 'ref_no-03', 32, 1, 20, 47, 1, NULL, 5, 8),
    ('2026-05-05', 'ref_no-04', 42, 2, 22, 2, NULL, 2, 6, 10),
    ('2026-06-06', 'ref_no-05', 52, 3, 24, NULL, 3, 3, 7, 12),
    ('2026-07-07', 'ref_no-06', 62, 4, 2, 8, 4, 4, 8, 2),
    ('2026-08-08', 'ref_no-07', 72, 5, 4, 11, 5, NULL, 9, 4),
    ('2026-09-09', 'ref_no-08', 82, 6, 6, 14, NULL, 6, 10, 6);

CREATE TABLE hub.doc_approval (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_approval_id  integer      REFERENCES hub.plan_approval (id),
    proc_approval_id  integer      REFERENCES hub.proc_approval (id),
    ops_approval_id   integer      REFERENCES hub.ops_approval (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_approval (ref_no, priority, rate, note, project_id, workorder_id, workorder_row_id, plan_approval_id, proc_approval_id, ops_approval_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 1.0013, 'note-01', 8, 17, 42, 8, 8, 8, 4, 5),
    ('ref_no-02', 21, 2.0026, 'note-02', 1, 19, 45, 1, 1, NULL, 5, 7),
    ('ref_no-03', 31, 3.0039, 'note-03', 2, 21, 48, 2, NULL, 2, 6, 9),
    ('ref_no-04', 41, 4.0052, 'note-04', 3, 23, 3, NULL, 3, 3, 7, 11),
    ('ref_no-05', 51, 5.0065, 'note-05', 4, 1, NULL, 4, 4, 4, 8, 1),
    ('ref_no-06', 61, 6.0078, 'note-06', 5, 3, 9, 5, 5, NULL, 9, 3),
    ('ref_no-07', 71, 7.0091, 'note-07', 6, 5, 12, 6, NULL, 6, 10, 5),
    ('ref_no-08', 81, 8.0104, 'note-08', 7, 7, 15, NULL, 7, 7, 11, 7);

CREATE TABLE hub.crm_approval (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_approval_id   integer      REFERENCES hub.doc_approval (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_approval (priority, rate, project_id, workorder_id, workorder_row_id, doc_approval_id, created_by, changed_by) VALUES
    (10, 1.0013, 1, 18, 43, 1, 5, 6),
    (20, 2.0026, 2, 20, 46, 2, 6, 8),
    (30, 3.0039, 3, 22, 1, 3, 7, 10),
    (40, 4.0052, 4, 24, 4, NULL, 8, 12),
    (50, 5.0065, 5, 2, NULL, 5, 9, 2),
    (60, 6.0078, 6, 4, 10, 6, 10, 4),
    (70, 7.0091, 7, 6, 13, 7, 11, 6),
    (80, 8.0104, 8, 8, 16, NULL, 12, 8);

CREATE TABLE hub.asset_approval (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_approval_id   integer      REFERENCES hub.crm_approval (id),
    doc_approval_id   integer      REFERENCES hub.doc_approval (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_approval (rate, note, code, project_id, workorder_id, workorder_row_id, crm_approval_id, doc_approval_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 'code-01', 2, 19, 44, 2, 2, 6, 7),
    (2.0026, 'note-02', 'code-02', 3, 21, 47, 3, 3, 7, 9),
    (3.0039, 'note-03', 'code-03', 4, 23, 2, 4, NULL, 8, 11),
    (4.0052, 'note-04', 'code-04', 5, 1, 5, NULL, 5, 9, 1),
    (5.0065, 'note-05', 'code-05', 6, 3, NULL, 6, 6, 10, 3),
    (6.0078, 'note-06', 'code-06', 7, 5, 11, 7, 7, 11, 5),
    (7.0091, 'note-07', 'code-07', 8, 7, 14, 8, NULL, 12, 7),
    (8.0104, 'note-08', 'code-08', 1, 9, 17, NULL, 1, 1, 9);

CREATE TABLE hub.sched_approval (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_approval_id integer      REFERENCES hub.asset_approval (id),
    crm_approval_id   integer      REFERENCES hub.crm_approval (id),
    plan_approval_id  integer      REFERENCES hub.plan_approval (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_approval (note, code, title, amount, project_id, workorder_id, workorder_row_id, asset_approval_id, crm_approval_id, plan_approval_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 'title-01', 7.03, 3, 20, 45, 3, 3, 3, 7, 8),
    ('note-02', 'code-02', 'title-02', 14.06, 4, 22, 48, 4, 4, NULL, 8, 10),
    ('note-03', 'code-03', 'title-03', 21.09, 5, 24, 3, 5, NULL, 5, 9, 12),
    ('note-04', 'code-04', 'title-04', 28.12, 6, 2, 6, NULL, 6, 6, 10, 2),
    ('note-05', 'code-05', 'title-05', 35.15, 7, 4, NULL, 7, 7, 7, 11, 4),
    ('note-06', 'code-06', 'title-06', 42.18, 8, 6, 12, 8, 8, NULL, 12, 6),
    ('note-07', 'code-07', 'title-07', 49.21, 1, 8, 15, 1, NULL, 1, 1, 8),
    ('note-08', 'code-08', 'title-08', 56.24, 2, 10, 18, NULL, 2, 2, 2, 10);

CREATE TABLE hub.core_cost_center (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_approval_id integer      REFERENCES hub.sched_approval (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_cost_center (code, title, project_id, workorder_id, workorder_row_id, sched_approval_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 4, 21, 46, 4, 8, 9),
    ('code-02', 'title-02', 5, 23, 1, 5, 9, 11),
    ('code-03', 'title-03', 6, 1, 4, 6, 10, 1),
    ('code-04', 'title-04', 7, 3, 7, NULL, 11, 3),
    ('code-05', 'title-05', 8, 5, NULL, 8, 12, 5),
    ('code-06', 'title-06', 1, 7, 13, 1, 1, 7),
    ('code-07', 'title-07', 2, 9, 16, 2, 2, 9),
    ('code-08', 'title-08', 3, 11, 19, NULL, 3, 11);

CREATE TABLE hub.fin_cost_center (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_cost_center_id integer      REFERENCES hub.core_cost_center (id),
    sched_approval_id integer      REFERENCES hub.sched_approval (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_cost_center (title, amount, quantity, project_id, workorder_id, workorder_row_id, core_cost_center_id, sched_approval_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 12, 5, 22, 47, 5, 5, 9, 10),
    ('title-02', 14.06, 22, 6, 24, 2, 6, 6, 10, 12),
    ('title-03', 21.09, 32, 7, 2, 5, 7, NULL, 11, 2),
    ('title-04', 28.12, 42, 8, 4, 8, NULL, 8, 12, 4),
    ('title-05', 35.15, 52, 1, 6, NULL, 1, 1, 1, 6),
    ('title-06', 42.18, 62, 2, 8, 14, 2, 2, 2, 8),
    ('title-07', 49.21, 72, 3, 10, 17, 3, NULL, 3, 10),
    ('title-08', 56.24, 82, 4, 12, 20, NULL, 4, 4, 12);

CREATE TABLE hub.ops_cost_center (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_cost_center_id integer      REFERENCES hub.fin_cost_center (id),
    core_cost_center_id integer      REFERENCES hub.core_cost_center (id),
    asset_approval_id integer      REFERENCES hub.asset_approval (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_cost_center (amount, quantity, is_active, due_date, project_id, workorder_id, workorder_row_id, fin_cost_center_id, core_cost_center_id, asset_approval_id, created_by, changed_by) VALUES
    (7.03, 11, false, '2026-02-02', 6, 23, 48, 6, 6, 6, 10, 11),
    (14.06, 21, true, '2026-03-03', 7, 1, 3, 7, 7, NULL, 11, 1),
    (21.09, 31, false, '2026-04-04', 8, 3, 6, 8, NULL, 8, 12, 3),
    (28.12, 41, true, '2026-05-05', 1, 5, 9, NULL, 1, 1, 1, 5),
    (35.15, 51, false, '2026-06-06', 2, 7, NULL, 2, 2, 2, 2, 7),
    (42.18, 61, true, '2026-07-07', 3, 9, 15, 3, 3, NULL, 3, 9),
    (49.21, 71, false, '2026-08-08', 4, 11, 18, 4, NULL, 4, 4, 11),
    (56.24, 81, true, '2026-09-09', 5, 13, 21, NULL, 5, 5, 5, 1);

CREATE TABLE hub.qa_cost_center (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_cost_center_id integer      REFERENCES hub.ops_cost_center (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_cost_center (quantity, is_active, project_id, workorder_id, workorder_row_id, ops_cost_center_id, created_by, changed_by) VALUES
    (10, true, 7, 24, 1, 7, 11, 12),
    (20, false, 8, 2, 4, 8, 12, 2),
    (30, true, 1, 4, 7, 1, 1, 4),
    (40, false, 2, 6, 10, NULL, 2, 6),
    (50, true, 3, 8, NULL, 3, 3, 8),
    (60, false, 4, 10, 16, 4, 4, 10),
    (70, true, 5, 12, 19, 5, 5, 12),
    (80, false, 6, 14, 22, NULL, 6, 2);

CREATE TABLE hub.proc_cost_center (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_cost_center_id integer      REFERENCES hub.qa_cost_center (id),
    ops_cost_center_id integer      REFERENCES hub.ops_cost_center (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_cost_center (is_active, due_date, ref_no, project_id, workorder_id, workorder_row_id, qa_cost_center_id, ops_cost_center_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 'ref_no-01', 8, 1, 2, 8, 8, 12, 1),
    (true, '2026-03-03', 'ref_no-02', 1, 3, 5, 1, 1, 1, 3),
    (false, '2026-04-04', 'ref_no-03', 2, 5, 8, 2, NULL, 2, 5),
    (true, '2026-05-05', 'ref_no-04', 3, 7, 11, NULL, 3, 3, 7),
    (false, '2026-06-06', 'ref_no-05', 4, 9, NULL, 4, 4, 4, 9),
    (true, '2026-07-07', 'ref_no-06', 5, 11, 17, 5, 5, 5, 11),
    (false, '2026-08-08', 'ref_no-07', 6, 13, 20, 6, NULL, 6, 1),
    (true, '2026-09-09', 'ref_no-08', 7, 15, 23, NULL, 7, 7, 3);

CREATE TABLE hub.plan_cost_center (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_cost_center_id integer      REFERENCES hub.proc_cost_center (id),
    qa_cost_center_id integer      REFERENCES hub.qa_cost_center (id),
    fin_cost_center_id integer      REFERENCES hub.fin_cost_center (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_cost_center (due_date, ref_no, priority, rate, project_id, workorder_id, workorder_row_id, proc_cost_center_id, qa_cost_center_id, fin_cost_center_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 12, 1.0013, 1, 2, 3, 1, 1, 1, 1, 2),
    ('2026-03-03', 'ref_no-02', 22, 2.0026, 2, 4, 6, 2, 2, NULL, 2, 4),
    ('2026-04-04', 'ref_no-03', 32, 3.0039, 3, 6, 9, 3, NULL, 3, 3, 6),
    ('2026-05-05', 'ref_no-04', 42, 4.0052, 4, 8, 12, NULL, 4, 4, 4, 8),
    ('2026-06-06', 'ref_no-05', 52, 5.0065, 5, 10, NULL, 5, 5, 5, 5, 10),
    ('2026-07-07', 'ref_no-06', 62, 6.0078, 6, 12, 18, 6, 6, NULL, 6, 12),
    ('2026-08-08', 'ref_no-07', 72, 7.0091, 7, 14, 21, 7, NULL, 7, 7, 2),
    ('2026-09-09', 'ref_no-08', 82, 8.0104, 8, 16, 24, NULL, 8, 8, 8, 4);

CREATE TABLE hub.doc_cost_center (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_cost_center_id integer      REFERENCES hub.plan_cost_center (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_cost_center (ref_no, priority, project_id, workorder_id, workorder_row_id, plan_cost_center_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 2, 3, 4, 2, 2, 3),
    ('ref_no-02', 21, 3, 5, 7, 3, 3, 5),
    ('ref_no-03', 31, 4, 7, 10, 4, 4, 7),
    ('ref_no-04', 41, 5, 9, 13, NULL, 5, 9),
    ('ref_no-05', 51, 6, 11, NULL, 6, 6, 11),
    ('ref_no-06', 61, 7, 13, 19, 7, 7, 1),
    ('ref_no-07', 71, 8, 15, 22, 8, 8, 3),
    ('ref_no-08', 81, 1, 17, 25, NULL, 9, 5);

CREATE TABLE hub.crm_cost_center (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_cost_center_id integer      REFERENCES hub.doc_cost_center (id),
    plan_cost_center_id integer      REFERENCES hub.plan_cost_center (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_cost_center (priority, rate, note, project_id, workorder_id, workorder_row_id, doc_cost_center_id, plan_cost_center_id, created_by, changed_by) VALUES
    (10, 1.0013, 'note-01', 3, 4, 5, 3, 3, 3, 4),
    (20, 2.0026, 'note-02', 4, 6, 8, 4, 4, 4, 6),
    (30, 3.0039, 'note-03', 5, 8, 11, 5, NULL, 5, 8),
    (40, 4.0052, 'note-04', 6, 10, 14, NULL, 6, 6, 10),
    (50, 5.0065, 'note-05', 7, 12, NULL, 7, 7, 7, 12),
    (60, 6.0078, 'note-06', 8, 14, 20, 8, 8, 8, 2),
    (70, 7.0091, 'note-07', 1, 16, 23, 1, NULL, 9, 4),
    (80, 8.0104, 'note-08', 2, 18, 26, NULL, 2, 10, 6);

CREATE TABLE hub.asset_cost_center (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_cost_center_id integer      REFERENCES hub.crm_cost_center (id),
    doc_cost_center_id integer      REFERENCES hub.doc_cost_center (id),
    proc_cost_center_id integer      REFERENCES hub.proc_cost_center (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_cost_center (rate, note, code, title, project_id, workorder_id, workorder_row_id, crm_cost_center_id, doc_cost_center_id, proc_cost_center_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 'code-01', 'title-01', 4, 5, 6, 4, 4, 4, 4, 5),
    (2.0026, 'note-02', 'code-02', 'title-02', 5, 7, 9, 5, 5, NULL, 5, 7),
    (3.0039, 'note-03', 'code-03', 'title-03', 6, 9, 12, 6, NULL, 6, 6, 9),
    (4.0052, 'note-04', 'code-04', 'title-04', 7, 11, 15, NULL, 7, 7, 7, 11),
    (5.0065, 'note-05', 'code-05', 'title-05', 8, 13, NULL, 8, 8, 8, 8, 1),
    (6.0078, 'note-06', 'code-06', 'title-06', 1, 15, 21, 1, 1, NULL, 9, 3),
    (7.0091, 'note-07', 'code-07', 'title-07', 2, 17, 24, 2, NULL, 2, 10, 5),
    (8.0104, 'note-08', 'code-08', 'title-08', 3, 19, 27, NULL, 3, 3, 11, 7);

CREATE TABLE hub.sched_cost_center (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_cost_center_id integer      REFERENCES hub.asset_cost_center (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_cost_center (note, code, project_id, workorder_id, workorder_row_id, asset_cost_center_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 5, 6, 7, 5, 5, 6),
    ('note-02', 'code-02', 6, 8, 10, 6, 6, 8),
    ('note-03', 'code-03', 7, 10, 13, 7, 7, 10),
    ('note-04', 'code-04', 8, 12, 16, NULL, 8, 12),
    ('note-05', 'code-05', 1, 14, NULL, 1, 9, 2),
    ('note-06', 'code-06', 2, 16, 22, 2, 10, 4),
    ('note-07', 'code-07', 3, 18, 25, 3, 11, 6),
    ('note-08', 'code-08', 4, 20, 28, NULL, 12, 8);

CREATE TABLE hub.core_account (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_cost_center_id integer      REFERENCES hub.sched_cost_center (id),
    asset_cost_center_id integer      REFERENCES hub.asset_cost_center (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_account (code, title, amount, project_id, workorder_id, workorder_row_id, sched_cost_center_id, asset_cost_center_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 7.03, 6, 7, 8, 6, 6, 6, 7),
    ('code-02', 'title-02', 14.06, 7, 9, 11, 7, 7, 7, 9),
    ('code-03', 'title-03', 21.09, 8, 11, 14, 8, NULL, 8, 11),
    ('code-04', 'title-04', 28.12, 1, 13, 17, NULL, 1, 9, 1),
    ('code-05', 'title-05', 35.15, 2, 15, NULL, 2, 2, 10, 3),
    ('code-06', 'title-06', 42.18, 3, 17, 23, 3, 3, 11, 5),
    ('code-07', 'title-07', 49.21, 4, 19, 26, 4, NULL, 12, 7),
    ('code-08', 'title-08', 56.24, 5, 21, 29, NULL, 5, 1, 9);

CREATE TABLE hub.fin_account (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_account_id   integer      REFERENCES hub.core_account (id),
    sched_cost_center_id integer      REFERENCES hub.sched_cost_center (id),
    crm_cost_center_id integer      REFERENCES hub.crm_cost_center (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_account (title, amount, quantity, is_active, project_id, workorder_id, workorder_row_id, core_account_id, sched_cost_center_id, crm_cost_center_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 12, true, 7, 8, 9, 7, 7, 7, 7, 8),
    ('title-02', 14.06, 22, false, 8, 10, 12, 8, 8, NULL, 8, 10),
    ('title-03', 21.09, 32, true, 1, 12, 15, 1, NULL, 1, 9, 12),
    ('title-04', 28.12, 42, false, 2, 14, 18, NULL, 2, 2, 10, 2),
    ('title-05', 35.15, 52, true, 3, 16, NULL, 3, 3, 3, 11, 4),
    ('title-06', 42.18, 62, false, 4, 18, 24, 4, 4, NULL, 12, 6),
    ('title-07', 49.21, 72, true, 5, 20, 27, 5, NULL, 5, 1, 8),
    ('title-08', 56.24, 82, false, 6, 22, 30, NULL, 6, 6, 2, 10);

CREATE TABLE hub.ops_account (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_account_id    integer      REFERENCES hub.fin_account (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_account (amount, quantity, project_id, workorder_id, workorder_row_id, fin_account_id, created_by, changed_by) VALUES
    (7.03, 11, 8, 9, 10, 8, 8, 9),
    (14.06, 21, 1, 11, 13, 1, 9, 11),
    (21.09, 31, 2, 13, 16, 2, 10, 1),
    (28.12, 41, 3, 15, 19, NULL, 11, 3),
    (35.15, 51, 4, 17, NULL, 4, 12, 5),
    (42.18, 61, 5, 19, 25, 5, 1, 7),
    (49.21, 71, 6, 21, 28, 6, 2, 9),
    (56.24, 81, 7, 23, 31, NULL, 3, 11);

CREATE TABLE hub.qa_account (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_account_id    integer      REFERENCES hub.ops_account (id),
    fin_account_id    integer      REFERENCES hub.fin_account (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_account (quantity, is_active, due_date, project_id, workorder_id, workorder_row_id, ops_account_id, fin_account_id, created_by, changed_by) VALUES
    (10, true, '2026-02-02', 1, 10, 11, 1, 1, 9, 10),
    (20, false, '2026-03-03', 2, 12, 14, 2, 2, 10, 12),
    (30, true, '2026-04-04', 3, 14, 17, 3, NULL, 11, 2),
    (40, false, '2026-05-05', 4, 16, 20, NULL, 4, 12, 4),
    (50, true, '2026-06-06', 5, 18, NULL, 5, 5, 1, 6),
    (60, false, '2026-07-07', 6, 20, 26, 6, 6, 2, 8),
    (70, true, '2026-08-08', 7, 22, 29, 7, NULL, 3, 10),
    (80, false, '2026-09-09', 8, 24, 32, NULL, 8, 4, 12);

CREATE TABLE hub.proc_account (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_account_id     integer      REFERENCES hub.qa_account (id),
    ops_account_id    integer      REFERENCES hub.ops_account (id),
    core_account_id   integer      REFERENCES hub.core_account (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_account (is_active, due_date, ref_no, priority, project_id, workorder_id, workorder_row_id, qa_account_id, ops_account_id, core_account_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 'ref_no-01', 13, 2, 11, 12, 2, 2, 2, 10, 11),
    (true, '2026-03-03', 'ref_no-02', 23, 3, 13, 15, 3, 3, NULL, 11, 1),
    (false, '2026-04-04', 'ref_no-03', 33, 4, 15, 18, 4, NULL, 4, 12, 3),
    (true, '2026-05-05', 'ref_no-04', 43, 5, 17, 21, NULL, 5, 5, 1, 5),
    (false, '2026-06-06', 'ref_no-05', 53, 6, 19, NULL, 6, 6, 6, 2, 7),
    (true, '2026-07-07', 'ref_no-06', 63, 7, 21, 27, 7, 7, NULL, 3, 9),
    (false, '2026-08-08', 'ref_no-07', 73, 8, 23, 30, 8, NULL, 8, 4, 11),
    (true, '2026-09-09', 'ref_no-08', 83, 1, 1, 33, NULL, 1, 1, 5, 1);

CREATE TABLE hub.plan_account (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_account_id   integer      REFERENCES hub.proc_account (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_account (due_date, ref_no, project_id, workorder_id, workorder_row_id, proc_account_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 3, 12, 13, 3, 11, 12),
    ('2026-03-03', 'ref_no-02', 4, 14, 16, 4, 12, 2),
    ('2026-04-04', 'ref_no-03', 5, 16, 19, 5, 1, 4),
    ('2026-05-05', 'ref_no-04', 6, 18, 22, NULL, 2, 6),
    ('2026-06-06', 'ref_no-05', 7, 20, NULL, 7, 3, 8),
    ('2026-07-07', 'ref_no-06', 8, 22, 28, 8, 4, 10),
    ('2026-08-08', 'ref_no-07', 1, 24, 31, 1, 5, 12),
    ('2026-09-09', 'ref_no-08', 2, 2, 34, NULL, 6, 2);

CREATE TABLE hub.doc_account (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_account_id   integer      REFERENCES hub.plan_account (id),
    proc_account_id   integer      REFERENCES hub.proc_account (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_account (ref_no, priority, rate, project_id, workorder_id, workorder_row_id, plan_account_id, proc_account_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 1.0013, 4, 13, 14, 4, 4, 12, 1),
    ('ref_no-02', 21, 2.0026, 5, 15, 17, 5, 5, 1, 3),
    ('ref_no-03', 31, 3.0039, 6, 17, 20, 6, NULL, 2, 5),
    ('ref_no-04', 41, 4.0052, 7, 19, 23, NULL, 7, 3, 7),
    ('ref_no-05', 51, 5.0065, 8, 21, NULL, 8, 8, 4, 9),
    ('ref_no-06', 61, 6.0078, 1, 23, 29, 1, 1, 5, 11),
    ('ref_no-07', 71, 7.0091, 2, 1, 32, 2, NULL, 6, 1),
    ('ref_no-08', 81, 8.0104, 3, 3, 35, NULL, 3, 7, 3);

CREATE TABLE hub.crm_account (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_account_id    integer      REFERENCES hub.doc_account (id),
    plan_account_id   integer      REFERENCES hub.plan_account (id),
    qa_account_id     integer      REFERENCES hub.qa_account (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_account (priority, rate, note, code, project_id, workorder_id, workorder_row_id, doc_account_id, plan_account_id, qa_account_id, created_by, changed_by) VALUES
    (10, 1.0013, 'note-01', 'code-01', 5, 14, 15, 5, 5, 5, 1, 2),
    (20, 2.0026, 'note-02', 'code-02', 6, 16, 18, 6, 6, NULL, 2, 4),
    (30, 3.0039, 'note-03', 'code-03', 7, 18, 21, 7, NULL, 7, 3, 6),
    (40, 4.0052, 'note-04', 'code-04', 8, 20, 24, NULL, 8, 8, 4, 8),
    (50, 5.0065, 'note-05', 'code-05', 1, 22, NULL, 1, 1, 1, 5, 10),
    (60, 6.0078, 'note-06', 'code-06', 2, 24, 30, 2, 2, NULL, 6, 12),
    (70, 7.0091, 'note-07', 'code-07', 3, 2, 33, 3, NULL, 3, 7, 2),
    (80, 8.0104, 'note-08', 'code-08', 4, 4, 36, NULL, 4, 4, 8, 4);

CREATE TABLE hub.asset_account (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_account_id    integer      REFERENCES hub.crm_account (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_account (rate, note, project_id, workorder_id, workorder_row_id, crm_account_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 6, 15, 16, 6, 2, 3),
    (2.0026, 'note-02', 7, 17, 19, 7, 3, 5),
    (3.0039, 'note-03', 8, 19, 22, 8, 4, 7),
    (4.0052, 'note-04', 1, 21, 25, NULL, 5, 9),
    (5.0065, 'note-05', 2, 23, NULL, 2, 6, 11),
    (6.0078, 'note-06', 3, 1, 31, 3, 7, 1),
    (7.0091, 'note-07', 4, 3, 34, 4, 8, 3),
    (8.0104, 'note-08', 5, 5, 37, NULL, 9, 5);

CREATE TABLE hub.sched_account (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_account_id  integer      REFERENCES hub.asset_account (id),
    crm_account_id    integer      REFERENCES hub.crm_account (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_account (note, code, title, project_id, workorder_id, workorder_row_id, asset_account_id, crm_account_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 'title-01', 7, 16, 17, 7, 7, 3, 4),
    ('note-02', 'code-02', 'title-02', 8, 18, 20, 8, 8, 4, 6),
    ('note-03', 'code-03', 'title-03', 1, 20, 23, 1, NULL, 5, 8),
    ('note-04', 'code-04', 'title-04', 2, 22, 26, NULL, 2, 6, 10),
    ('note-05', 'code-05', 'title-05', 3, 24, NULL, 3, 3, 7, 12),
    ('note-06', 'code-06', 'title-06', 4, 2, 32, 4, 4, 8, 2),
    ('note-07', 'code-07', 'title-07', 5, 4, 35, 5, NULL, 9, 4),
    ('note-08', 'code-08', 'title-08', 6, 6, 38, NULL, 6, 10, 6);

CREATE TABLE hub.core_ledger_entry (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_account_id  integer      REFERENCES hub.sched_account (id),
    asset_account_id  integer      REFERENCES hub.asset_account (id),
    doc_account_id    integer      REFERENCES hub.doc_account (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_ledger_entry (code, title, amount, quantity, project_id, workorder_id, workorder_row_id, sched_account_id, asset_account_id, doc_account_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 7.03, 13, 8, 17, 18, 8, 8, 8, 4, 5),
    ('code-02', 'title-02', 14.06, 23, 1, 19, 21, 1, 1, NULL, 5, 7),
    ('code-03', 'title-03', 21.09, 33, 2, 21, 24, 2, NULL, 2, 6, 9),
    ('code-04', 'title-04', 28.12, 43, 3, 23, 27, NULL, 3, 3, 7, 11),
    ('code-05', 'title-05', 35.15, 53, 4, 1, NULL, 4, 4, 4, 8, 1),
    ('code-06', 'title-06', 42.18, 63, 5, 3, 33, 5, 5, NULL, 9, 3),
    ('code-07', 'title-07', 49.21, 73, 6, 5, 36, 6, NULL, 6, 10, 5),
    ('code-08', 'title-08', 56.24, 83, 7, 7, 39, NULL, 7, 7, 11, 7);

CREATE TABLE hub.fin_ledger_entry (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_ledger_entry_id integer      REFERENCES hub.core_ledger_entry (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_ledger_entry (title, amount, project_id, workorder_id, workorder_row_id, core_ledger_entry_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 1, 18, 19, 1, 5, 6),
    ('title-02', 14.06, 2, 20, 22, 2, 6, 8),
    ('title-03', 21.09, 3, 22, 25, 3, 7, 10),
    ('title-04', 28.12, 4, 24, 28, NULL, 8, 12),
    ('title-05', 35.15, 5, 2, NULL, 5, 9, 2),
    ('title-06', 42.18, 6, 4, 34, 6, 10, 4),
    ('title-07', 49.21, 7, 6, 37, 7, 11, 6),
    ('title-08', 56.24, 8, 8, 40, NULL, 12, 8);

CREATE TABLE hub.ops_ledger_entry (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_ledger_entry_id integer      REFERENCES hub.fin_ledger_entry (id),
    core_ledger_entry_id integer      REFERENCES hub.core_ledger_entry (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_ledger_entry (amount, quantity, is_active, project_id, workorder_id, workorder_row_id, fin_ledger_entry_id, core_ledger_entry_id, created_by, changed_by) VALUES
    (7.03, 11, false, 2, 19, 20, 2, 2, 6, 7),
    (14.06, 21, true, 3, 21, 23, 3, 3, 7, 9),
    (21.09, 31, false, 4, 23, 26, 4, NULL, 8, 11),
    (28.12, 41, true, 5, 1, 29, NULL, 5, 9, 1),
    (35.15, 51, false, 6, 3, NULL, 6, 6, 10, 3),
    (42.18, 61, true, 7, 5, 35, 7, 7, 11, 5),
    (49.21, 71, false, 8, 7, 38, 8, NULL, 12, 7),
    (56.24, 81, true, 1, 9, 41, NULL, 1, 1, 9);

CREATE TABLE hub.qa_ledger_entry (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_ledger_entry_id integer      REFERENCES hub.ops_ledger_entry (id),
    fin_ledger_entry_id integer      REFERENCES hub.fin_ledger_entry (id),
    sched_account_id  integer      REFERENCES hub.sched_account (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_ledger_entry (quantity, is_active, due_date, ref_no, project_id, workorder_id, workorder_row_id, ops_ledger_entry_id, fin_ledger_entry_id, sched_account_id, created_by, changed_by) VALUES
    (10, true, '2026-02-02', 'ref_no-01', 3, 20, 21, 3, 3, 3, 7, 8),
    (20, false, '2026-03-03', 'ref_no-02', 4, 22, 24, 4, 4, NULL, 8, 10),
    (30, true, '2026-04-04', 'ref_no-03', 5, 24, 27, 5, NULL, 5, 9, 12),
    (40, false, '2026-05-05', 'ref_no-04', 6, 2, 30, NULL, 6, 6, 10, 2),
    (50, true, '2026-06-06', 'ref_no-05', 7, 4, NULL, 7, 7, 7, 11, 4),
    (60, false, '2026-07-07', 'ref_no-06', 8, 6, 36, 8, 8, NULL, 12, 6),
    (70, true, '2026-08-08', 'ref_no-07', 1, 8, 39, 1, NULL, 1, 1, 8),
    (80, false, '2026-09-09', 'ref_no-08', 2, 10, 42, NULL, 2, 2, 2, 10);

CREATE TABLE hub.proc_ledger_entry (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_ledger_entry_id integer      REFERENCES hub.qa_ledger_entry (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_ledger_entry (is_active, due_date, project_id, workorder_id, workorder_row_id, qa_ledger_entry_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 4, 21, 22, 4, 8, 9),
    (true, '2026-03-03', 5, 23, 25, 5, 9, 11),
    (false, '2026-04-04', 6, 1, 28, 6, 10, 1),
    (true, '2026-05-05', 7, 3, 31, NULL, 11, 3),
    (false, '2026-06-06', 8, 5, NULL, 8, 12, 5),
    (true, '2026-07-07', 1, 7, 37, 1, 1, 7),
    (false, '2026-08-08', 2, 9, 40, 2, 2, 9),
    (true, '2026-09-09', 3, 11, 43, NULL, 3, 11);

CREATE TABLE hub.plan_ledger_entry (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_ledger_entry_id integer      REFERENCES hub.proc_ledger_entry (id),
    qa_ledger_entry_id integer      REFERENCES hub.qa_ledger_entry (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_ledger_entry (due_date, ref_no, priority, project_id, workorder_id, workorder_row_id, proc_ledger_entry_id, qa_ledger_entry_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 12, 5, 22, 23, 5, 5, 9, 10),
    ('2026-03-03', 'ref_no-02', 22, 6, 24, 26, 6, 6, 10, 12),
    ('2026-04-04', 'ref_no-03', 32, 7, 2, 29, 7, NULL, 11, 2),
    ('2026-05-05', 'ref_no-04', 42, 8, 4, 32, NULL, 8, 12, 4),
    ('2026-06-06', 'ref_no-05', 52, 1, 6, NULL, 1, 1, 1, 6),
    ('2026-07-07', 'ref_no-06', 62, 2, 8, 38, 2, 2, 2, 8),
    ('2026-08-08', 'ref_no-07', 72, 3, 10, 41, 3, NULL, 3, 10),
    ('2026-09-09', 'ref_no-08', 82, 4, 12, 44, NULL, 4, 4, 12);

CREATE TABLE hub.doc_ledger_entry (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_ledger_entry_id integer      REFERENCES hub.plan_ledger_entry (id),
    proc_ledger_entry_id integer      REFERENCES hub.proc_ledger_entry (id),
    ops_ledger_entry_id integer      REFERENCES hub.ops_ledger_entry (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_ledger_entry (ref_no, priority, rate, note, project_id, workorder_id, workorder_row_id, plan_ledger_entry_id, proc_ledger_entry_id, ops_ledger_entry_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 1.0013, 'note-01', 6, 23, 24, 6, 6, 6, 10, 11),
    ('ref_no-02', 21, 2.0026, 'note-02', 7, 1, 27, 7, 7, NULL, 11, 1),
    ('ref_no-03', 31, 3.0039, 'note-03', 8, 3, 30, 8, NULL, 8, 12, 3),
    ('ref_no-04', 41, 4.0052, 'note-04', 1, 5, 33, NULL, 1, 1, 1, 5),
    ('ref_no-05', 51, 5.0065, 'note-05', 2, 7, NULL, 2, 2, 2, 2, 7),
    ('ref_no-06', 61, 6.0078, 'note-06', 3, 9, 39, 3, 3, NULL, 3, 9),
    ('ref_no-07', 71, 7.0091, 'note-07', 4, 11, 42, 4, NULL, 4, 4, 11),
    ('ref_no-08', 81, 8.0104, 'note-08', 5, 13, 45, NULL, 5, 5, 5, 1);

CREATE TABLE hub.crm_ledger_entry (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_ledger_entry_id integer      REFERENCES hub.doc_ledger_entry (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_ledger_entry (priority, rate, project_id, workorder_id, workorder_row_id, doc_ledger_entry_id, created_by, changed_by) VALUES
    (10, 1.0013, 7, 24, 25, 7, 11, 12),
    (20, 2.0026, 8, 2, 28, 8, 12, 2),
    (30, 3.0039, 1, 4, 31, 1, 1, 4),
    (40, 4.0052, 2, 6, 34, NULL, 2, 6),
    (50, 5.0065, 3, 8, NULL, 3, 3, 8),
    (60, 6.0078, 4, 10, 40, 4, 4, 10),
    (70, 7.0091, 5, 12, 43, 5, 5, 12),
    (80, 8.0104, 6, 14, 46, NULL, 6, 2);

CREATE TABLE hub.asset_ledger_entry (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_ledger_entry_id integer      REFERENCES hub.crm_ledger_entry (id),
    doc_ledger_entry_id integer      REFERENCES hub.doc_ledger_entry (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_ledger_entry (rate, note, code, project_id, workorder_id, workorder_row_id, crm_ledger_entry_id, doc_ledger_entry_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 'code-01', 8, 1, 26, 8, 8, 12, 1),
    (2.0026, 'note-02', 'code-02', 1, 3, 29, 1, 1, 1, 3),
    (3.0039, 'note-03', 'code-03', 2, 5, 32, 2, NULL, 2, 5),
    (4.0052, 'note-04', 'code-04', 3, 7, 35, NULL, 3, 3, 7),
    (5.0065, 'note-05', 'code-05', 4, 9, NULL, 4, 4, 4, 9),
    (6.0078, 'note-06', 'code-06', 5, 11, 41, 5, 5, 5, 11),
    (7.0091, 'note-07', 'code-07', 6, 13, 44, 6, NULL, 6, 1),
    (8.0104, 'note-08', 'code-08', 7, 15, 47, NULL, 7, 7, 3);

CREATE TABLE hub.sched_ledger_entry (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_ledger_entry_id integer      REFERENCES hub.asset_ledger_entry (id),
    crm_ledger_entry_id integer      REFERENCES hub.crm_ledger_entry (id),
    plan_ledger_entry_id integer      REFERENCES hub.plan_ledger_entry (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_ledger_entry (note, code, title, amount, project_id, workorder_id, workorder_row_id, asset_ledger_entry_id, crm_ledger_entry_id, plan_ledger_entry_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 'title-01', 7.03, 1, 2, 27, 1, 1, 1, 1, 2),
    ('note-02', 'code-02', 'title-02', 14.06, 2, 4, 30, 2, 2, NULL, 2, 4),
    ('note-03', 'code-03', 'title-03', 21.09, 3, 6, 33, 3, NULL, 3, 3, 6),
    ('note-04', 'code-04', 'title-04', 28.12, 4, 8, 36, NULL, 4, 4, 4, 8),
    ('note-05', 'code-05', 'title-05', 35.15, 5, 10, NULL, 5, 5, 5, 5, 10),
    ('note-06', 'code-06', 'title-06', 42.18, 6, 12, 42, 6, 6, NULL, 6, 12),
    ('note-07', 'code-07', 'title-07', 49.21, 7, 14, 45, 7, NULL, 7, 7, 2),
    ('note-08', 'code-08', 'title-08', 56.24, 8, 16, 48, NULL, 8, 8, 8, 4);

CREATE TABLE hub.core_material (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_ledger_entry_id integer      REFERENCES hub.sched_ledger_entry (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_material (code, title, project_id, workorder_id, workorder_row_id, sched_ledger_entry_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 2, 3, 28, 2, 2, 3),
    ('code-02', 'title-02', 3, 5, 31, 3, 3, 5),
    ('code-03', 'title-03', 4, 7, 34, 4, 4, 7),
    ('code-04', 'title-04', 5, 9, 37, NULL, 5, 9),
    ('code-05', 'title-05', 6, 11, NULL, 6, 6, 11),
    ('code-06', 'title-06', 7, 13, 43, 7, 7, 1),
    ('code-07', 'title-07', 8, 15, 46, 8, 8, 3),
    ('code-08', 'title-08', 1, 17, 1, NULL, 9, 5);

CREATE TABLE hub.fin_material (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_material_id  integer      REFERENCES hub.core_material (id),
    sched_ledger_entry_id integer      REFERENCES hub.sched_ledger_entry (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_material (title, amount, quantity, project_id, workorder_id, workorder_row_id, core_material_id, sched_ledger_entry_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 12, 3, 4, 29, 3, 3, 3, 4),
    ('title-02', 14.06, 22, 4, 6, 32, 4, 4, 4, 6),
    ('title-03', 21.09, 32, 5, 8, 35, 5, NULL, 5, 8),
    ('title-04', 28.12, 42, 6, 10, 38, NULL, 6, 6, 10),
    ('title-05', 35.15, 52, 7, 12, NULL, 7, 7, 7, 12),
    ('title-06', 42.18, 62, 8, 14, 44, 8, 8, 8, 2),
    ('title-07', 49.21, 72, 1, 16, 47, 1, NULL, 9, 4),
    ('title-08', 56.24, 82, 2, 18, 2, NULL, 2, 10, 6);

CREATE TABLE hub.ops_material (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_material_id   integer      REFERENCES hub.fin_material (id),
    core_material_id  integer      REFERENCES hub.core_material (id),
    asset_ledger_entry_id integer      REFERENCES hub.asset_ledger_entry (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_material (amount, quantity, is_active, due_date, project_id, workorder_id, workorder_row_id, fin_material_id, core_material_id, asset_ledger_entry_id, created_by, changed_by) VALUES
    (7.03, 11, false, '2026-02-02', 4, 5, 30, 4, 4, 4, 4, 5),
    (14.06, 21, true, '2026-03-03', 5, 7, 33, 5, 5, NULL, 5, 7),
    (21.09, 31, false, '2026-04-04', 6, 9, 36, 6, NULL, 6, 6, 9),
    (28.12, 41, true, '2026-05-05', 7, 11, 39, NULL, 7, 7, 7, 11),
    (35.15, 51, false, '2026-06-06', 8, 13, NULL, 8, 8, 8, 8, 1),
    (42.18, 61, true, '2026-07-07', 1, 15, 45, 1, 1, NULL, 9, 3),
    (49.21, 71, false, '2026-08-08', 2, 17, 48, 2, NULL, 2, 10, 5),
    (56.24, 81, true, '2026-09-09', 3, 19, 3, NULL, 3, 3, 11, 7);

CREATE TABLE hub.qa_material (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_material_id   integer      REFERENCES hub.ops_material (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_material (quantity, is_active, project_id, workorder_id, workorder_row_id, ops_material_id, created_by, changed_by) VALUES
    (10, true, 5, 6, 31, 5, 5, 6),
    (20, false, 6, 8, 34, 6, 6, 8),
    (30, true, 7, 10, 37, 7, 7, 10),
    (40, false, 8, 12, 40, NULL, 8, 12),
    (50, true, 1, 14, NULL, 1, 9, 2),
    (60, false, 2, 16, 46, 2, 10, 4),
    (70, true, 3, 18, 1, 3, 11, 6),
    (80, false, 4, 20, 4, NULL, 12, 8);

CREATE TABLE hub.proc_material (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_material_id    integer      REFERENCES hub.qa_material (id),
    ops_material_id   integer      REFERENCES hub.ops_material (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_material (is_active, due_date, ref_no, project_id, workorder_id, workorder_row_id, qa_material_id, ops_material_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 'ref_no-01', 6, 7, 32, 6, 6, 6, 7),
    (true, '2026-03-03', 'ref_no-02', 7, 9, 35, 7, 7, 7, 9),
    (false, '2026-04-04', 'ref_no-03', 8, 11, 38, 8, NULL, 8, 11),
    (true, '2026-05-05', 'ref_no-04', 1, 13, 41, NULL, 1, 9, 1),
    (false, '2026-06-06', 'ref_no-05', 2, 15, NULL, 2, 2, 10, 3),
    (true, '2026-07-07', 'ref_no-06', 3, 17, 47, 3, 3, 11, 5),
    (false, '2026-08-08', 'ref_no-07', 4, 19, 2, 4, NULL, 12, 7),
    (true, '2026-09-09', 'ref_no-08', 5, 21, 5, NULL, 5, 1, 9);

CREATE TABLE hub.plan_material (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_material_id  integer      REFERENCES hub.proc_material (id),
    qa_material_id    integer      REFERENCES hub.qa_material (id),
    fin_material_id   integer      REFERENCES hub.fin_material (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_material (due_date, ref_no, priority, rate, project_id, workorder_id, workorder_row_id, proc_material_id, qa_material_id, fin_material_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 12, 1.0013, 7, 8, 33, 7, 7, 7, 7, 8),
    ('2026-03-03', 'ref_no-02', 22, 2.0026, 8, 10, 36, 8, 8, NULL, 8, 10),
    ('2026-04-04', 'ref_no-03', 32, 3.0039, 1, 12, 39, 1, NULL, 1, 9, 12),
    ('2026-05-05', 'ref_no-04', 42, 4.0052, 2, 14, 42, NULL, 2, 2, 10, 2),
    ('2026-06-06', 'ref_no-05', 52, 5.0065, 3, 16, NULL, 3, 3, 3, 11, 4),
    ('2026-07-07', 'ref_no-06', 62, 6.0078, 4, 18, 48, 4, 4, NULL, 12, 6),
    ('2026-08-08', 'ref_no-07', 72, 7.0091, 5, 20, 3, 5, NULL, 5, 1, 8),
    ('2026-09-09', 'ref_no-08', 82, 8.0104, 6, 22, 6, NULL, 6, 6, 2, 10);

CREATE TABLE hub.doc_material (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_material_id  integer      REFERENCES hub.plan_material (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_material (ref_no, priority, project_id, workorder_id, workorder_row_id, plan_material_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 8, 9, 34, 8, 8, 9),
    ('ref_no-02', 21, 1, 11, 37, 1, 9, 11),
    ('ref_no-03', 31, 2, 13, 40, 2, 10, 1),
    ('ref_no-04', 41, 3, 15, 43, NULL, 11, 3),
    ('ref_no-05', 51, 4, 17, NULL, 4, 12, 5),
    ('ref_no-06', 61, 5, 19, 1, 5, 1, 7),
    ('ref_no-07', 71, 6, 21, 4, 6, 2, 9),
    ('ref_no-08', 81, 7, 23, 7, NULL, 3, 11);

CREATE TABLE hub.crm_material (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_material_id   integer      REFERENCES hub.doc_material (id),
    plan_material_id  integer      REFERENCES hub.plan_material (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_material (priority, rate, note, project_id, workorder_id, workorder_row_id, doc_material_id, plan_material_id, created_by, changed_by) VALUES
    (10, 1.0013, 'note-01', 1, 10, 35, 1, 1, 9, 10),
    (20, 2.0026, 'note-02', 2, 12, 38, 2, 2, 10, 12),
    (30, 3.0039, 'note-03', 3, 14, 41, 3, NULL, 11, 2),
    (40, 4.0052, 'note-04', 4, 16, 44, NULL, 4, 12, 4),
    (50, 5.0065, 'note-05', 5, 18, NULL, 5, 5, 1, 6),
    (60, 6.0078, 'note-06', 6, 20, 2, 6, 6, 2, 8),
    (70, 7.0091, 'note-07', 7, 22, 5, 7, NULL, 3, 10),
    (80, 8.0104, 'note-08', 8, 24, 8, NULL, 8, 4, 12);

CREATE TABLE hub.asset_material (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_material_id   integer      REFERENCES hub.crm_material (id),
    doc_material_id   integer      REFERENCES hub.doc_material (id),
    proc_material_id  integer      REFERENCES hub.proc_material (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_material (rate, note, code, title, project_id, workorder_id, workorder_row_id, crm_material_id, doc_material_id, proc_material_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 'code-01', 'title-01', 2, 11, 36, 2, 2, 2, 10, 11),
    (2.0026, 'note-02', 'code-02', 'title-02', 3, 13, 39, 3, 3, NULL, 11, 1),
    (3.0039, 'note-03', 'code-03', 'title-03', 4, 15, 42, 4, NULL, 4, 12, 3),
    (4.0052, 'note-04', 'code-04', 'title-04', 5, 17, 45, NULL, 5, 5, 1, 5),
    (5.0065, 'note-05', 'code-05', 'title-05', 6, 19, NULL, 6, 6, 6, 2, 7),
    (6.0078, 'note-06', 'code-06', 'title-06', 7, 21, 3, 7, 7, NULL, 3, 9),
    (7.0091, 'note-07', 'code-07', 'title-07', 8, 23, 6, 8, NULL, 8, 4, 11),
    (8.0104, 'note-08', 'code-08', 'title-08', 1, 1, 9, NULL, 1, 1, 5, 1);

CREATE TABLE hub.sched_material (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_material_id integer      REFERENCES hub.asset_material (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_material (note, code, project_id, workorder_id, workorder_row_id, asset_material_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 3, 12, 37, 3, 11, 12),
    ('note-02', 'code-02', 4, 14, 40, 4, 12, 2),
    ('note-03', 'code-03', 5, 16, 43, 5, 1, 4),
    ('note-04', 'code-04', 6, 18, 46, NULL, 2, 6),
    ('note-05', 'code-05', 7, 20, NULL, 7, 3, 8),
    ('note-06', 'code-06', 8, 22, 4, 8, 4, 10),
    ('note-07', 'code-07', 1, 24, 7, 1, 5, 12),
    ('note-08', 'code-08', 2, 2, 10, NULL, 6, 2);

CREATE TABLE hub.core_resource (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_material_id integer      REFERENCES hub.sched_material (id),
    asset_material_id integer      REFERENCES hub.asset_material (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_resource (code, title, amount, project_id, workorder_id, workorder_row_id, sched_material_id, asset_material_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 7.03, 4, 13, 38, 4, 4, 12, 1),
    ('code-02', 'title-02', 14.06, 5, 15, 41, 5, 5, 1, 3),
    ('code-03', 'title-03', 21.09, 6, 17, 44, 6, NULL, 2, 5),
    ('code-04', 'title-04', 28.12, 7, 19, 47, NULL, 7, 3, 7),
    ('code-05', 'title-05', 35.15, 8, 21, NULL, 8, 8, 4, 9),
    ('code-06', 'title-06', 42.18, 1, 23, 5, 1, 1, 5, 11),
    ('code-07', 'title-07', 49.21, 2, 1, 8, 2, NULL, 6, 1),
    ('code-08', 'title-08', 56.24, 3, 3, 11, NULL, 3, 7, 3);

CREATE TABLE hub.fin_resource (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_resource_id  integer      REFERENCES hub.core_resource (id),
    sched_material_id integer      REFERENCES hub.sched_material (id),
    crm_material_id   integer      REFERENCES hub.crm_material (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_resource (title, amount, quantity, is_active, project_id, workorder_id, workorder_row_id, core_resource_id, sched_material_id, crm_material_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 12, true, 5, 14, 39, 5, 5, 5, 1, 2),
    ('title-02', 14.06, 22, false, 6, 16, 42, 6, 6, NULL, 2, 4),
    ('title-03', 21.09, 32, true, 7, 18, 45, 7, NULL, 7, 3, 6),
    ('title-04', 28.12, 42, false, 8, 20, 48, NULL, 8, 8, 4, 8),
    ('title-05', 35.15, 52, true, 1, 22, NULL, 1, 1, 1, 5, 10),
    ('title-06', 42.18, 62, false, 2, 24, 6, 2, 2, NULL, 6, 12),
    ('title-07', 49.21, 72, true, 3, 2, 9, 3, NULL, 3, 7, 2),
    ('title-08', 56.24, 82, false, 4, 4, 12, NULL, 4, 4, 8, 4);

CREATE TABLE hub.ops_resource (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_resource_id   integer      REFERENCES hub.fin_resource (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_resource (amount, quantity, project_id, workorder_id, workorder_row_id, fin_resource_id, created_by, changed_by) VALUES
    (7.03, 11, 6, 15, 40, 6, 2, 3),
    (14.06, 21, 7, 17, 43, 7, 3, 5),
    (21.09, 31, 8, 19, 46, 8, 4, 7),
    (28.12, 41, 1, 21, 1, NULL, 5, 9),
    (35.15, 51, 2, 23, NULL, 2, 6, 11),
    (42.18, 61, 3, 1, 7, 3, 7, 1),
    (49.21, 71, 4, 3, 10, 4, 8, 3),
    (56.24, 81, 5, 5, 13, NULL, 9, 5);

CREATE TABLE hub.qa_resource (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_resource_id   integer      REFERENCES hub.ops_resource (id),
    fin_resource_id   integer      REFERENCES hub.fin_resource (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_resource (quantity, is_active, due_date, project_id, workorder_id, workorder_row_id, ops_resource_id, fin_resource_id, created_by, changed_by) VALUES
    (10, true, '2026-02-02', 7, 16, 41, 7, 7, 3, 4),
    (20, false, '2026-03-03', 8, 18, 44, 8, 8, 4, 6),
    (30, true, '2026-04-04', 1, 20, 47, 1, NULL, 5, 8),
    (40, false, '2026-05-05', 2, 22, 2, NULL, 2, 6, 10),
    (50, true, '2026-06-06', 3, 24, NULL, 3, 3, 7, 12),
    (60, false, '2026-07-07', 4, 2, 8, 4, 4, 8, 2),
    (70, true, '2026-08-08', 5, 4, 11, 5, NULL, 9, 4),
    (80, false, '2026-09-09', 6, 6, 14, NULL, 6, 10, 6);

CREATE TABLE hub.proc_resource (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_resource_id    integer      REFERENCES hub.qa_resource (id),
    ops_resource_id   integer      REFERENCES hub.ops_resource (id),
    core_resource_id  integer      REFERENCES hub.core_resource (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_resource (is_active, due_date, ref_no, priority, project_id, workorder_id, workorder_row_id, qa_resource_id, ops_resource_id, core_resource_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 'ref_no-01', 13, 8, 17, 42, 8, 8, 8, 4, 5),
    (true, '2026-03-03', 'ref_no-02', 23, 1, 19, 45, 1, 1, NULL, 5, 7),
    (false, '2026-04-04', 'ref_no-03', 33, 2, 21, 48, 2, NULL, 2, 6, 9),
    (true, '2026-05-05', 'ref_no-04', 43, 3, 23, 3, NULL, 3, 3, 7, 11),
    (false, '2026-06-06', 'ref_no-05', 53, 4, 1, NULL, 4, 4, 4, 8, 1),
    (true, '2026-07-07', 'ref_no-06', 63, 5, 3, 9, 5, 5, NULL, 9, 3),
    (false, '2026-08-08', 'ref_no-07', 73, 6, 5, 12, 6, NULL, 6, 10, 5),
    (true, '2026-09-09', 'ref_no-08', 83, 7, 7, 15, NULL, 7, 7, 11, 7);

CREATE TABLE hub.plan_resource (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_resource_id  integer      REFERENCES hub.proc_resource (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_resource (due_date, ref_no, project_id, workorder_id, workorder_row_id, proc_resource_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 1, 18, 43, 1, 5, 6),
    ('2026-03-03', 'ref_no-02', 2, 20, 46, 2, 6, 8),
    ('2026-04-04', 'ref_no-03', 3, 22, 1, 3, 7, 10),
    ('2026-05-05', 'ref_no-04', 4, 24, 4, NULL, 8, 12),
    ('2026-06-06', 'ref_no-05', 5, 2, NULL, 5, 9, 2),
    ('2026-07-07', 'ref_no-06', 6, 4, 10, 6, 10, 4),
    ('2026-08-08', 'ref_no-07', 7, 6, 13, 7, 11, 6),
    ('2026-09-09', 'ref_no-08', 8, 8, 16, NULL, 12, 8);

CREATE TABLE hub.doc_resource (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_resource_id  integer      REFERENCES hub.plan_resource (id),
    proc_resource_id  integer      REFERENCES hub.proc_resource (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_resource (ref_no, priority, rate, project_id, workorder_id, workorder_row_id, plan_resource_id, proc_resource_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 1.0013, 2, 19, 44, 2, 2, 6, 7),
    ('ref_no-02', 21, 2.0026, 3, 21, 47, 3, 3, 7, 9),
    ('ref_no-03', 31, 3.0039, 4, 23, 2, 4, NULL, 8, 11),
    ('ref_no-04', 41, 4.0052, 5, 1, 5, NULL, 5, 9, 1),
    ('ref_no-05', 51, 5.0065, 6, 3, NULL, 6, 6, 10, 3),
    ('ref_no-06', 61, 6.0078, 7, 5, 11, 7, 7, 11, 5),
    ('ref_no-07', 71, 7.0091, 8, 7, 14, 8, NULL, 12, 7),
    ('ref_no-08', 81, 8.0104, 1, 9, 17, NULL, 1, 1, 9);

CREATE TABLE hub.crm_resource (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_resource_id   integer      REFERENCES hub.doc_resource (id),
    plan_resource_id  integer      REFERENCES hub.plan_resource (id),
    qa_resource_id    integer      REFERENCES hub.qa_resource (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_resource (priority, rate, note, code, project_id, workorder_id, workorder_row_id, doc_resource_id, plan_resource_id, qa_resource_id, created_by, changed_by) VALUES
    (10, 1.0013, 'note-01', 'code-01', 3, 20, 45, 3, 3, 3, 7, 8),
    (20, 2.0026, 'note-02', 'code-02', 4, 22, 48, 4, 4, NULL, 8, 10),
    (30, 3.0039, 'note-03', 'code-03', 5, 24, 3, 5, NULL, 5, 9, 12),
    (40, 4.0052, 'note-04', 'code-04', 6, 2, 6, NULL, 6, 6, 10, 2),
    (50, 5.0065, 'note-05', 'code-05', 7, 4, NULL, 7, 7, 7, 11, 4),
    (60, 6.0078, 'note-06', 'code-06', 8, 6, 12, 8, 8, NULL, 12, 6),
    (70, 7.0091, 'note-07', 'code-07', 1, 8, 15, 1, NULL, 1, 1, 8),
    (80, 8.0104, 'note-08', 'code-08', 2, 10, 18, NULL, 2, 2, 2, 10);

CREATE TABLE hub.asset_resource (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_resource_id   integer      REFERENCES hub.crm_resource (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_resource (rate, note, project_id, workorder_id, workorder_row_id, crm_resource_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 4, 21, 46, 4, 8, 9),
    (2.0026, 'note-02', 5, 23, 1, 5, 9, 11),
    (3.0039, 'note-03', 6, 1, 4, 6, 10, 1),
    (4.0052, 'note-04', 7, 3, 7, NULL, 11, 3),
    (5.0065, 'note-05', 8, 5, NULL, 8, 12, 5),
    (6.0078, 'note-06', 1, 7, 13, 1, 1, 7),
    (7.0091, 'note-07', 2, 9, 16, 2, 2, 9),
    (8.0104, 'note-08', 3, 11, 19, NULL, 3, 11);

CREATE TABLE hub.sched_resource (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    title             text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_resource_id integer      REFERENCES hub.asset_resource (id),
    crm_resource_id   integer      REFERENCES hub.crm_resource (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_resource (note, code, title, project_id, workorder_id, workorder_row_id, asset_resource_id, crm_resource_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 'title-01', 5, 22, 47, 5, 5, 9, 10),
    ('note-02', 'code-02', 'title-02', 6, 24, 2, 6, 6, 10, 12),
    ('note-03', 'code-03', 'title-03', 7, 2, 5, 7, NULL, 11, 2),
    ('note-04', 'code-04', 'title-04', 8, 4, 8, NULL, 8, 12, 4),
    ('note-05', 'code-05', 'title-05', 1, 6, NULL, 1, 1, 1, 6),
    ('note-06', 'code-06', 'title-06', 2, 8, 14, 2, 2, 2, 8),
    ('note-07', 'code-07', 'title-07', 3, 10, 17, 3, NULL, 3, 10),
    ('note-08', 'code-08', 'title-08', 4, 12, 20, NULL, 4, 4, 12);

CREATE TABLE hub.core_allocation (
    id                serial       PRIMARY KEY,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    quantity          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    sched_resource_id integer      REFERENCES hub.sched_resource (id),
    asset_resource_id integer      REFERENCES hub.asset_resource (id),
    doc_resource_id   integer      REFERENCES hub.doc_resource (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.core_allocation (code, title, amount, quantity, project_id, workorder_id, workorder_row_id, sched_resource_id, asset_resource_id, doc_resource_id, created_by, changed_by) VALUES
    ('code-01', 'title-01', 7.03, 13, 6, 23, 48, 6, 6, 6, 10, 11),
    ('code-02', 'title-02', 14.06, 23, 7, 1, 3, 7, 7, NULL, 11, 1),
    ('code-03', 'title-03', 21.09, 33, 8, 3, 6, 8, NULL, 8, 12, 3),
    ('code-04', 'title-04', 28.12, 43, 1, 5, 9, NULL, 1, 1, 1, 5),
    ('code-05', 'title-05', 35.15, 53, 2, 7, NULL, 2, 2, 2, 2, 7),
    ('code-06', 'title-06', 42.18, 63, 3, 9, 15, 3, 3, NULL, 3, 9),
    ('code-07', 'title-07', 49.21, 73, 4, 11, 18, 4, NULL, 4, 4, 11),
    ('code-08', 'title-08', 56.24, 83, 5, 13, 21, NULL, 5, 5, 5, 1);

CREATE TABLE hub.fin_allocation (
    id                serial       PRIMARY KEY,
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    core_allocation_id integer      REFERENCES hub.core_allocation (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.fin_allocation (title, amount, project_id, workorder_id, workorder_row_id, core_allocation_id, created_by, changed_by) VALUES
    ('title-01', 7.03, 7, 24, 1, 7, 11, 12),
    ('title-02', 14.06, 8, 2, 4, 8, 12, 2),
    ('title-03', 21.09, 1, 4, 7, 1, 1, 4),
    ('title-04', 28.12, 2, 6, 10, NULL, 2, 6),
    ('title-05', 35.15, 3, 8, NULL, 3, 3, 8),
    ('title-06', 42.18, 4, 10, 16, 4, 4, 10),
    ('title-07', 49.21, 5, 12, 19, 5, 5, 12),
    ('title-08', 56.24, 6, 14, 22, NULL, 6, 2);

CREATE TABLE hub.ops_allocation (
    id                serial       PRIMARY KEY,
    amount            numeric(14, 2),
    quantity          integer,
    is_active         boolean,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    fin_allocation_id integer      REFERENCES hub.fin_allocation (id),
    core_allocation_id integer      REFERENCES hub.core_allocation (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.ops_allocation (amount, quantity, is_active, project_id, workorder_id, workorder_row_id, fin_allocation_id, core_allocation_id, created_by, changed_by) VALUES
    (7.03, 11, false, 8, 1, 2, 8, 8, 12, 1),
    (14.06, 21, true, 1, 3, 5, 1, 1, 1, 3),
    (21.09, 31, false, 2, 5, 8, 2, NULL, 2, 5),
    (28.12, 41, true, 3, 7, 11, NULL, 3, 3, 7),
    (35.15, 51, false, 4, 9, NULL, 4, 4, 4, 9),
    (42.18, 61, true, 5, 11, 17, 5, 5, 5, 11),
    (49.21, 71, false, 6, 13, 20, 6, NULL, 6, 1),
    (56.24, 81, true, 7, 15, 23, NULL, 7, 7, 3);

CREATE TABLE hub.qa_allocation (
    id                serial       PRIMARY KEY,
    quantity          integer,
    is_active         boolean,
    due_date          date,
    ref_no            varchar(32),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    ops_allocation_id integer      REFERENCES hub.ops_allocation (id),
    fin_allocation_id integer      REFERENCES hub.fin_allocation (id),
    sched_resource_id integer      REFERENCES hub.sched_resource (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.qa_allocation (quantity, is_active, due_date, ref_no, project_id, workorder_id, workorder_row_id, ops_allocation_id, fin_allocation_id, sched_resource_id, created_by, changed_by) VALUES
    (10, true, '2026-02-02', 'ref_no-01', 1, 2, 3, 1, 1, 1, 1, 2),
    (20, false, '2026-03-03', 'ref_no-02', 2, 4, 6, 2, 2, NULL, 2, 4),
    (30, true, '2026-04-04', 'ref_no-03', 3, 6, 9, 3, NULL, 3, 3, 6),
    (40, false, '2026-05-05', 'ref_no-04', 4, 8, 12, NULL, 4, 4, 4, 8),
    (50, true, '2026-06-06', 'ref_no-05', 5, 10, NULL, 5, 5, 5, 5, 10),
    (60, false, '2026-07-07', 'ref_no-06', 6, 12, 18, 6, 6, NULL, 6, 12),
    (70, true, '2026-08-08', 'ref_no-07', 7, 14, 21, 7, NULL, 7, 7, 2),
    (80, false, '2026-09-09', 'ref_no-08', 8, 16, 24, NULL, 8, 8, 8, 4);

CREATE TABLE hub.proc_allocation (
    id                serial       PRIMARY KEY,
    is_active         boolean,
    due_date          date,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    qa_allocation_id  integer      REFERENCES hub.qa_allocation (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.proc_allocation (is_active, due_date, project_id, workorder_id, workorder_row_id, qa_allocation_id, created_by, changed_by) VALUES
    (false, '2026-02-02', 2, 3, 4, 2, 2, 3),
    (true, '2026-03-03', 3, 5, 7, 3, 3, 5),
    (false, '2026-04-04', 4, 7, 10, 4, 4, 7),
    (true, '2026-05-05', 5, 9, 13, NULL, 5, 9),
    (false, '2026-06-06', 6, 11, NULL, 6, 6, 11),
    (true, '2026-07-07', 7, 13, 19, 7, 7, 1),
    (false, '2026-08-08', 8, 15, 22, 8, 8, 3),
    (true, '2026-09-09', 1, 17, 25, NULL, 9, 5);

CREATE TABLE hub.plan_allocation (
    id                serial       PRIMARY KEY,
    due_date          date,
    ref_no            varchar(32),
    priority          integer,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    proc_allocation_id integer      REFERENCES hub.proc_allocation (id),
    qa_allocation_id  integer      REFERENCES hub.qa_allocation (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.plan_allocation (due_date, ref_no, priority, project_id, workorder_id, workorder_row_id, proc_allocation_id, qa_allocation_id, created_by, changed_by) VALUES
    ('2026-02-02', 'ref_no-01', 12, 3, 4, 5, 3, 3, 3, 4),
    ('2026-03-03', 'ref_no-02', 22, 4, 6, 8, 4, 4, 4, 6),
    ('2026-04-04', 'ref_no-03', 32, 5, 8, 11, 5, NULL, 5, 8),
    ('2026-05-05', 'ref_no-04', 42, 6, 10, 14, NULL, 6, 6, 10),
    ('2026-06-06', 'ref_no-05', 52, 7, 12, NULL, 7, 7, 7, 12),
    ('2026-07-07', 'ref_no-06', 62, 8, 14, 20, 8, 8, 8, 2),
    ('2026-08-08', 'ref_no-07', 72, 1, 16, 23, 1, NULL, 9, 4),
    ('2026-09-09', 'ref_no-08', 82, 2, 18, 26, NULL, 2, 10, 6);

CREATE TABLE hub.doc_allocation (
    id                serial       PRIMARY KEY,
    ref_no            varchar(32),
    priority          integer,
    rate              numeric(8, 4),
    note              text,
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    plan_allocation_id integer      REFERENCES hub.plan_allocation (id),
    proc_allocation_id integer      REFERENCES hub.proc_allocation (id),
    ops_allocation_id integer      REFERENCES hub.ops_allocation (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.doc_allocation (ref_no, priority, rate, note, project_id, workorder_id, workorder_row_id, plan_allocation_id, proc_allocation_id, ops_allocation_id, created_by, changed_by) VALUES
    ('ref_no-01', 11, 1.0013, 'note-01', 4, 5, 6, 4, 4, 4, 4, 5),
    ('ref_no-02', 21, 2.0026, 'note-02', 5, 7, 9, 5, 5, NULL, 5, 7),
    ('ref_no-03', 31, 3.0039, 'note-03', 6, 9, 12, 6, NULL, 6, 6, 9),
    ('ref_no-04', 41, 4.0052, 'note-04', 7, 11, 15, NULL, 7, 7, 7, 11),
    ('ref_no-05', 51, 5.0065, 'note-05', 8, 13, NULL, 8, 8, 8, 8, 1),
    ('ref_no-06', 61, 6.0078, 'note-06', 1, 15, 21, 1, 1, NULL, 9, 3),
    ('ref_no-07', 71, 7.0091, 'note-07', 2, 17, 24, 2, NULL, 2, 10, 5),
    ('ref_no-08', 81, 8.0104, 'note-08', 3, 19, 27, NULL, 3, 3, 11, 7);

CREATE TABLE hub.crm_allocation (
    id                serial       PRIMARY KEY,
    priority          integer,
    rate              numeric(8, 4),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    doc_allocation_id integer      REFERENCES hub.doc_allocation (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.crm_allocation (priority, rate, project_id, workorder_id, workorder_row_id, doc_allocation_id, created_by, changed_by) VALUES
    (10, 1.0013, 5, 6, 7, 5, 5, 6),
    (20, 2.0026, 6, 8, 10, 6, 6, 8),
    (30, 3.0039, 7, 10, 13, 7, 7, 10),
    (40, 4.0052, 8, 12, 16, NULL, 8, 12),
    (50, 5.0065, 1, 14, NULL, 1, 9, 2),
    (60, 6.0078, 2, 16, 22, 2, 10, 4),
    (70, 7.0091, 3, 18, 25, 3, 11, 6),
    (80, 8.0104, 4, 20, 28, NULL, 12, 8);

CREATE TABLE hub.asset_allocation (
    id                serial       PRIMARY KEY,
    rate              numeric(8, 4),
    note              text,
    code              varchar(24),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    crm_allocation_id integer      REFERENCES hub.crm_allocation (id),
    doc_allocation_id integer      REFERENCES hub.doc_allocation (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.asset_allocation (rate, note, code, project_id, workorder_id, workorder_row_id, crm_allocation_id, doc_allocation_id, created_by, changed_by) VALUES
    (1.0013, 'note-01', 'code-01', 6, 7, 8, 6, 6, 6, 7),
    (2.0026, 'note-02', 'code-02', 7, 9, 11, 7, 7, 7, 9),
    (3.0039, 'note-03', 'code-03', 8, 11, 14, 8, NULL, 8, 11),
    (4.0052, 'note-04', 'code-04', 1, 13, 17, NULL, 1, 9, 1),
    (5.0065, 'note-05', 'code-05', 2, 15, NULL, 2, 2, 10, 3),
    (6.0078, 'note-06', 'code-06', 3, 17, 23, 3, 3, 11, 5),
    (7.0091, 'note-07', 'code-07', 4, 19, 26, 4, NULL, 12, 7),
    (8.0104, 'note-08', 'code-08', 5, 21, 29, NULL, 5, 1, 9);

CREATE TABLE hub.sched_allocation (
    id                serial       PRIMARY KEY,
    note              text,
    code              varchar(24),
    title             text,
    amount            numeric(14, 2),
    project_id        integer      REFERENCES hub.projects (id),
    workorder_id      integer      REFERENCES hub.workorders (id),
    workorder_row_id  integer      REFERENCES hub.workorder_rows (id),
    asset_allocation_id integer      REFERENCES hub.asset_allocation (id),
    crm_allocation_id integer      REFERENCES hub.crm_allocation (id),
    plan_allocation_id integer      REFERENCES hub.plan_allocation (id),
    created_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        integer      NOT NULL REFERENCES hub.users (id),
    changed_at        timestamptz  NOT NULL DEFAULT now(),
    changed_by        integer      NOT NULL REFERENCES hub.users (id)
);

INSERT INTO hub.sched_allocation (note, code, title, amount, project_id, workorder_id, workorder_row_id, asset_allocation_id, crm_allocation_id, plan_allocation_id, created_by, changed_by) VALUES
    ('note-01', 'code-01', 'title-01', 7.03, 7, 8, 9, 7, 7, 7, 7, 8),
    ('note-02', 'code-02', 'title-02', 14.06, 8, 10, 12, 8, 8, NULL, 8, 10),
    ('note-03', 'code-03', 'title-03', 21.09, 1, 12, 15, 1, NULL, 1, 9, 12),
    ('note-04', 'code-04', 'title-04', 28.12, 2, 14, 18, NULL, 2, 2, 10, 2),
    ('note-05', 'code-05', 'title-05', 35.15, 3, 16, NULL, 3, 3, 3, 11, 4),
    ('note-06', 'code-06', 'title-06', 42.18, 4, 18, 24, 4, 4, NULL, 12, 6),
    ('note-07', 'code-07', 'title-07', 49.21, 5, 20, 27, 5, NULL, 5, 1, 8),
    ('note-08', 'code-08', 'title-08', 56.24, 6, 22, 30, NULL, 6, 6, 2, 10);

-- One enriched view per satellite: resolves the audit and hierarchy foreign
-- keys to human-readable columns. Each view therefore depends on its
-- satellite plus users, projects and workorders.

CREATE VIEW hub.v_core_contact AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_contact s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_contact AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_contact s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_contact AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_contact s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_contact AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_contact s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_contact AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_contact s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_contact AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_contact s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_contact AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_contact s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_contact AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_contact s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_contact AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_contact s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_contact AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_contact s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_address AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_address s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_address AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_address s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_address AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_address s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_address AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_address s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_address AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_address s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_address AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_address s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_address AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_address s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_address AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_address s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_address AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_address s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_address AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_address s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_document AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_document s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_document AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_document s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_document AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_document s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_document AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_document s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_document AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_document s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_document AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_document s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_document AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_document s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_document AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_document s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_document AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_document s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_document AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_document s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_attachment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_attachment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_attachment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_attachment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_attachment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_attachment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_attachment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_attachment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_attachment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_attachment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_attachment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_attachment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_attachment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_attachment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_attachment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_attachment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_attachment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_attachment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_attachment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_attachment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_comment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_comment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_comment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_comment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_comment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_comment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_comment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_comment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_comment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_comment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_comment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_comment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_comment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_comment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_comment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_comment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_comment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_comment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_comment AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_comment s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_tag AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_tag s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_tag AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_tag s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_tag AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_tag s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_tag AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_tag s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_tag AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_tag s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_tag AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_tag s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_tag AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_tag s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_tag AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_tag s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_tag AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_tag s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_tag AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_tag s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_category AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_category s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_category AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_category s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_category AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_category s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_category AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_category s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_category AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_category s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_category AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_category s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_category AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_category s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_category AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_category s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_category AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_category s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_category AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_category s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_status_history AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_status_history s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_status_history AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_status_history s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_status_history AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_status_history s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_status_history AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_status_history s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_status_history AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_status_history s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_status_history AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_status_history s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_status_history AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_status_history s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_status_history AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_status_history s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_status_history AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_status_history s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_status_history AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_status_history s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_approval AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_approval s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_approval AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_approval s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_approval AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_approval s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_approval AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_approval s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_approval AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_approval s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_approval AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_approval s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_approval AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_approval s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_approval AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_approval s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_approval AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_approval s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_approval AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_approval s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_cost_center AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_cost_center s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_cost_center AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_cost_center s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_cost_center AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_cost_center s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_cost_center AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_cost_center s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_cost_center AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_cost_center s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_cost_center AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_cost_center s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_cost_center AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_cost_center s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_cost_center AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_cost_center s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_cost_center AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_cost_center s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_cost_center AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_cost_center s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_account AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_account s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_account AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_account s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_account AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_account s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_account AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_account s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_account AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_account s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_account AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_account s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_account AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_account s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_account AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_account s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_account AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_account s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_account AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_account s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_ledger_entry AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_ledger_entry s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_ledger_entry AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_ledger_entry s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_ledger_entry AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_ledger_entry s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_ledger_entry AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_ledger_entry s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_ledger_entry AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_ledger_entry s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_ledger_entry AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_ledger_entry s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_ledger_entry AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_ledger_entry s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_ledger_entry AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_ledger_entry s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_ledger_entry AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_ledger_entry s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_ledger_entry AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_ledger_entry s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_material AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_material s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_material AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_material s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_material AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_material s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_material AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_material s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_material AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_material s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_material AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_material s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_material AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_material s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_material AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_material s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_material AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_material s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_material AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_material s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_resource AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_resource s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_resource AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_resource s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_resource AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_resource s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_resource AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_resource s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_resource AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_resource s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_resource AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_resource s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_resource AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_resource s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_resource AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_resource s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_resource AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_resource s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_resource AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_resource s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_core_allocation AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.core_allocation s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_fin_allocation AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.fin_allocation s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_ops_allocation AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.ops_allocation s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_qa_allocation AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.qa_allocation s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_proc_allocation AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.proc_allocation s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_plan_allocation AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.plan_allocation s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_doc_allocation AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.doc_allocation s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_crm_allocation AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.crm_allocation s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_asset_allocation AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.asset_allocation s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

CREATE VIEW hub.v_sched_allocation AS
    SELECT s.id, s.created_at, s.changed_at,
           cu.username  AS created_by,
           chu.username AS changed_by,
           p.code       AS project_code,
           w.number     AS workorder_number
    FROM hub.sched_allocation s
    LEFT JOIN hub.users cu      ON cu.id  = s.created_by
    LEFT JOIN hub.users chu     ON chu.id = s.changed_by
    LEFT JOIN hub.projects p    ON p.id   = s.project_id
    LEFT JOIN hub.workorders w  ON w.id   = s.workorder_id;

-- Cross-satellite summary views: per-project roll-ups that each touch two
-- satellites at once, so the view layer also carries multi-table dependencies.

CREATE VIEW hub.summary_00 AS
    SELECT p.code AS project_code,
           count(DISTINCT a.id) AS core_contact_count,
           count(DISTINCT b.id) AS fin_contact_count
    FROM hub.projects p
    LEFT JOIN hub.core_contact a ON a.project_id = p.id
    LEFT JOIN hub.fin_contact b ON b.project_id = p.id
    GROUP BY p.code;

CREATE VIEW hub.summary_01 AS
    SELECT p.code AS project_code,
           count(DISTINCT a.id) AS ops_contact_count,
           count(DISTINCT b.id) AS qa_contact_count
    FROM hub.projects p
    LEFT JOIN hub.ops_contact a ON a.project_id = p.id
    LEFT JOIN hub.qa_contact b ON b.project_id = p.id
    GROUP BY p.code;

CREATE VIEW hub.summary_02 AS
    SELECT p.code AS project_code,
           count(DISTINCT a.id) AS proc_contact_count,
           count(DISTINCT b.id) AS plan_contact_count
    FROM hub.projects p
    LEFT JOIN hub.proc_contact a ON a.project_id = p.id
    LEFT JOIN hub.plan_contact b ON b.project_id = p.id
    GROUP BY p.code;

CREATE VIEW hub.summary_03 AS
    SELECT p.code AS project_code,
           count(DISTINCT a.id) AS doc_contact_count,
           count(DISTINCT b.id) AS crm_contact_count
    FROM hub.projects p
    LEFT JOIN hub.doc_contact a ON a.project_id = p.id
    LEFT JOIN hub.crm_contact b ON b.project_id = p.id
    GROUP BY p.code;

CREATE VIEW hub.summary_04 AS
    SELECT p.code AS project_code,
           count(DISTINCT a.id) AS asset_contact_count,
           count(DISTINCT b.id) AS sched_contact_count
    FROM hub.projects p
    LEFT JOIN hub.asset_contact a ON a.project_id = p.id
    LEFT JOIN hub.sched_contact b ON b.project_id = p.id
    GROUP BY p.code;

CREATE VIEW hub.summary_05 AS
    SELECT p.code AS project_code,
           count(DISTINCT a.id) AS core_address_count,
           count(DISTINCT b.id) AS fin_address_count
    FROM hub.projects p
    LEFT JOIN hub.core_address a ON a.project_id = p.id
    LEFT JOIN hub.fin_address b ON b.project_id = p.id
    GROUP BY p.code;

CREATE VIEW hub.summary_06 AS
    SELECT p.code AS project_code,
           count(DISTINCT a.id) AS ops_address_count,
           count(DISTINCT b.id) AS qa_address_count
    FROM hub.projects p
    LEFT JOIN hub.ops_address a ON a.project_id = p.id
    LEFT JOIN hub.qa_address b ON b.project_id = p.id
    GROUP BY p.code;

CREATE VIEW hub.summary_07 AS
    SELECT p.code AS project_code,
           count(DISTINCT a.id) AS proc_address_count,
           count(DISTINCT b.id) AS plan_address_count
    FROM hub.projects p
    LEFT JOIN hub.proc_address a ON a.project_id = p.id
    LEFT JOIN hub.plan_address b ON b.project_id = p.id
    GROUP BY p.code;

CREATE VIEW hub.summary_08 AS
    SELECT p.code AS project_code,
           count(DISTINCT a.id) AS doc_address_count,
           count(DISTINCT b.id) AS crm_address_count
    FROM hub.projects p
    LEFT JOIN hub.doc_address a ON a.project_id = p.id
    LEFT JOIN hub.crm_address b ON b.project_id = p.id
    GROUP BY p.code;

CREATE VIEW hub.summary_09 AS
    SELECT p.code AS project_code,
           count(DISTINCT a.id) AS asset_address_count,
           count(DISTINCT b.id) AS sched_address_count
    FROM hub.projects p
    LEFT JOIN hub.asset_address a ON a.project_id = p.id
    LEFT JOIN hub.sched_address b ON b.project_id = p.id
    GROUP BY p.code;

