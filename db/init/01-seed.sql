-- SQLAdmin demo seed.
--
-- Runs once, when the Postgres data volume is first created (Docker's
-- /docker-entrypoint-initdb.d hook). Gives Phase 0 a real schema to
-- introspect and render — public.customers is the table Phase 0 targets.
-- Re-seed with: docker compose down -v && docker compose up -d db

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
