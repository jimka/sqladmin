-- ---------------------------------------------------------------------------
-- Functions & procedures across the demo schemas, so the navigator lists
-- function / procedure objects and the create/edit/drop-function tooling has a
-- realistic mix to exercise: SQL and PL/pgSQL languages, scalar / set / table
-- returns, default and multiple arguments, an overloaded name (to exercise
-- signature-disambiguated DROP), and a stored PROCEDURE. Runs after the tables
-- (01) and roles (02) so every referenced relation already exists.
-- ---------------------------------------------------------------------------

-- public: a scalar SQL function taking one argument.
CREATE OR REPLACE FUNCTION public.customer_balance(p_customer_id integer)
    RETURNS numeric
    LANGUAGE sql
    STABLE
AS $$
    SELECT balance FROM public.customers WHERE id = p_customer_id;
$$;

-- public: an overloaded pair (same name, different arity) — the zero-arg form
-- counts every order, the one-arg form counts a single customer's. Exercises
-- DROP FUNCTION's argument-signature disambiguation (both must coexist).
CREATE OR REPLACE FUNCTION public.total_orders()
    RETURNS bigint
    LANGUAGE sql
    STABLE
AS $$
    SELECT count(*) FROM public.orders;
$$;

CREATE OR REPLACE FUNCTION public.total_orders(p_customer_id integer)
    RETURNS bigint
    LANGUAGE sql
    STABLE
AS $$
    SELECT count(*) FROM public.orders WHERE customer_id = p_customer_id;
$$;

-- sales: a PL/pgSQL function with a DEFAULT argument.
CREATE OR REPLACE FUNCTION sales.discounted_price(p_price numeric, p_pct numeric DEFAULT 10)
    RETURNS numeric
    LANGUAGE plpgsql
    IMMUTABLE
AS $$
BEGIN
    RETURN round(p_price * (1 - p_pct / 100.0), 2);
END;
$$;

-- sales: a set-returning function (RETURNS SETOF a table row type).
CREATE OR REPLACE FUNCTION sales.products_in_category(p_category text)
    RETURNS SETOF sales.products
    LANGUAGE sql
    STABLE
AS $$
    SELECT * FROM sales.products WHERE category = p_category ORDER BY name;
$$;

-- inventory: a PL/pgSQL function with branching logic.
CREATE OR REPLACE FUNCTION inventory.stock_status(p_quantity integer)
    RETURNS text
    LANGUAGE plpgsql
    IMMUTABLE
AS $$
BEGIN
    IF p_quantity <= 0 THEN
        RETURN 'out';
    ELSIF p_quantity < 20 THEN
        RETURN 'low';
    ELSE
        RETURN 'ok';
    END IF;
END;
$$;

-- hr: a scalar SQL function.
CREATE OR REPLACE FUNCTION hr.employee_count(p_department_id integer)
    RETURNS bigint
    LANGUAGE sql
    STABLE
AS $$
    SELECT count(*) FROM hr.employees WHERE department_id = p_department_id;
$$;

-- hr: a stored PROCEDURE (no return) that mutates a row — exercises the
-- "procedure" object kind and DROP PROCEDURE.
CREATE OR REPLACE PROCEDURE hr.adjust_budget(p_department_id integer, p_delta numeric)
    LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE hr.departments
    SET budget = budget + p_delta
    WHERE id = p_department_id;
END;
$$;

-- analytics: a zero-arg scalar SQL function returning an aggregate.
CREATE OR REPLACE FUNCTION analytics.avg_order_value()
    RETURNS numeric
    LANGUAGE sql
    STABLE
AS $$
    SELECT round(avg(total), 2) FROM public.orders;
$$;

-- ---------------------------------------------------------------------------
-- Overload families whose members all take arguments — so the navigator lists
-- several same-name rows, each with a distinct argument signature, and the
-- execute-with-arguments / signature-disambiguated-drop flows have realistic
-- overloads to exercise. Two disambiguation styles are covered: by arity (same
-- argument types, different count) and by type (same count, different types).
-- ---------------------------------------------------------------------------

-- sales.price_with_tax: an ARITY overload — the one-arg form applies a default
-- 25% rate, the two-arg form takes an explicit rate. Both take arguments, so
-- neither collapses to a bare-name call. (Distinct from sales.discounted_price
-- above, which uses a DEFAULT argument rather than a second overload — do NOT
-- give these a DEFAULT, or price_with_tax(100) would be ambiguous.)
CREATE OR REPLACE FUNCTION sales.price_with_tax(p_price numeric)
    RETURNS numeric
    LANGUAGE sql
    IMMUTABLE
AS $$
    SELECT round(p_price * 1.25, 2);
$$;

CREATE OR REPLACE FUNCTION sales.price_with_tax(p_price numeric, p_rate numeric)
    RETURNS numeric
    LANGUAGE sql
    IMMUTABLE
AS $$
    SELECT round(p_price * (1 + p_rate / 100.0), 2);
$$;

-- public.describe: a three-way TYPE overload — same arity, one argument, but a
-- different type each (integer / numeric / text), so describe(5), describe(5.5)
-- and describe('x') each resolve to a different routine. Three same-name rows
-- in the tree, all requiring an argument.
CREATE OR REPLACE FUNCTION public.describe(p_value integer)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
AS $$
    SELECT 'integer ' || p_value::text;
$$;

CREATE OR REPLACE FUNCTION public.describe(p_value numeric)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
AS $$
    SELECT 'numeric ' || p_value::text;
$$;

CREATE OR REPLACE FUNCTION public.describe(p_value text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
AS $$
    SELECT 'text ' || quote_literal(p_value);
$$;

-- hr.headcount: a TYPE overload backed by real tables — count a department's
-- employees either by its id or by its name (joining hr.departments). Both take
-- an argument; the type of the argument picks the overload.
CREATE OR REPLACE FUNCTION hr.headcount(p_department_id integer)
    RETURNS bigint
    LANGUAGE sql
    STABLE
AS $$
    SELECT count(*) FROM hr.employees WHERE department_id = p_department_id;
$$;

CREATE OR REPLACE FUNCTION hr.headcount(p_department_name text)
    RETURNS bigint
    LANGUAGE sql
    STABLE
AS $$
    SELECT count(*)
    FROM hr.employees e
    JOIN hr.departments d ON d.id = e.department_id
    WHERE d.name = p_department_name;
$$;
