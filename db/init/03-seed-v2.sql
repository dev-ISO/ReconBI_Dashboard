-- Demo dataset v2: richer maintenance story layered on top of 02-seed-demo-app.
--
-- Adds a deeper FK web for multi-hop join demos:
--   work_order_parts -> work_orders -> valves -> units -> sites
--   work_order_parts -> parts -> vendors
--   work_orders -> employees -> sites   (second path to sites = ambiguity demo)
-- work_orders carries TWO date columns (opened_on / closed_on) so one fact can
-- role-play against an engine date table. work_order_parts is a composite-key
-- bridge table.
--
-- Idempotent-ish: tables use IF NOT EXISTS; row seeds either upsert with
-- ON CONFLICT DO NOTHING (natural keys) or only run when the table is empty.

CREATE TABLE IF NOT EXISTS vendors (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE,
    region text NOT NULL,
    rating numeric(3, 1) NOT NULL
);
COMMENT ON TABLE vendors IS 'Parts suppliers';

CREATE TABLE IF NOT EXISTS parts (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id integer NOT NULL REFERENCES vendors (id),
    part_number text NOT NULL UNIQUE,
    description text NOT NULL,
    unit_cost numeric(10, 2) NOT NULL,
    category text NOT NULL
);
COMMENT ON TABLE parts IS 'Replacement parts catalog';

CREATE TABLE IF NOT EXISTS employees (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    title text NOT NULL,
    site_id integer NOT NULL REFERENCES sites (id),
    hired_on date NOT NULL
);
COMMENT ON TABLE employees IS 'Maintenance staff (declared FK to sites - second path to sites vs work_orders->valves->units->sites)';

CREATE TABLE IF NOT EXISTS work_orders (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    valve_id integer NOT NULL REFERENCES valves (id),
    assigned_to integer NOT NULL REFERENCES employees (id),
    opened_on date NOT NULL,
    closed_on date NULL,
    priority text NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    status text NOT NULL CHECK (status IN ('open', 'in_progress', 'closed', 'cancelled')),
    labor_hours numeric(6, 2) NOT NULL,
    total_cost numeric(12, 2) NOT NULL
);
COMMENT ON TABLE work_orders IS 'Maintenance work orders (fact table; opened_on/closed_on = role-playing dates)';

CREATE TABLE IF NOT EXISTS work_order_parts (
    work_order_id integer NOT NULL REFERENCES work_orders (id),
    part_id integer NOT NULL REFERENCES parts (id),
    quantity integer NOT NULL,
    line_cost numeric(12, 2) NOT NULL,
    PRIMARY KEY (work_order_id, part_id)
);
COMMENT ON TABLE work_order_parts IS 'Parts consumed per work order (composite-key bridge table)';

-- ---------------------------------------------------------------------------
-- Seed data (deterministic pseudo-random via modular arithmetic, like 02).
-- ---------------------------------------------------------------------------

INSERT INTO vendors (name, region, rating) VALUES
    ('Apex Valve Supply', 'Gulf Coast', 4.6),
    ('Gulf Industrial Parts', 'Gulf Coast', 4.1),
    ('Meridian Flow Controls', 'Midwest', 4.8),
    ('TriState Seal & Gasket', 'Midwest', 3.7),
    ('Precision Actuation Co', 'West', 4.3),
    ('Lakeshore Instrument Supply', 'Midwest', 3.9),
    ('Bayou Fasteners', 'Gulf Coast', 3.4),
    ('Summit Pressure Systems', 'Southeast', 4.5)
ON CONFLICT (name) DO NOTHING;

-- 60 parts across 6 categories; vendor spread via (n * 3) % 8.
INSERT INTO parts (vendor_id, part_number, description, unit_cost, category)
SELECT 1 + (n * 3) % 8,
       'PRT-' || lpad(n::text, 4, '0'),
       (ARRAY['Spiral wound gasket', 'Compression spring', 'Nozzle assembly',
              'Pneumatic actuator seal kit', 'Stud bolt set', 'Pressure gauge'])[1 + n % 6]
           || ' - size ' || (1 + (n * 7) % 12),
       round((4 + (n * 137 % 1200) + ((n * 29) % 100) / 100.0)::numeric, 2),
       (ARRAY['Seals & Gaskets', 'Springs', 'Valve Trim',
              'Actuators', 'Fasteners', 'Instrumentation'])[1 + n % 6]
FROM generate_series(1, 60) AS n
ON CONFLICT (part_number) DO NOTHING;

-- 24 employees, 4 per site (site_id cycles 1..6).
INSERT INTO employees (name, title, site_id, hired_on)
SELECT (ARRAY['Ava', 'Ben', 'Cara', 'Dan', 'Elena', 'Frank', 'Grace', 'Hugo',
              'Iris', 'Jack', 'Kira', 'Liam', 'Maya', 'Noah', 'Opal', 'Pete',
              'Quinn', 'Rosa', 'Sam', 'Tara', 'Umar', 'Vera', 'Wade', 'Ximena'])[e]
           || ' ' ||
       (ARRAY['Alvarez', 'Brooks', 'Chen', 'Dawson', 'Ellis', 'Foster', 'Grant', 'Hughes'])[1 + (e * 3) % 8],
       (ARRAY['Maintenance Tech I', 'Maintenance Tech II', 'Senior Technician',
              'Reliability Engineer', 'Maintenance Planner', 'Maintenance Supervisor'])[1 + e % 6],
       1 + (e - 1) % 6,
       DATE '2012-03-01' + ((e * 211 + 37) % 4900)
FROM generate_series(1, 24) AS e
WHERE NOT EXISTS (SELECT 1 FROM employees);

-- 1,200 work orders opened 2023-01-01 .. 2026-07-31 (1308-day span).
-- 70% are closed 1-45 days after opening (i % 10 in 0..6); the rest split
-- open / in_progress / cancelled. Priorities skew toward low/medium.
INSERT INTO work_orders (valve_id, assigned_to, opened_on, closed_on, priority, status, labor_hours, total_cost)
SELECT 1 + (i * 37) % (SELECT count(*) FROM valves)::int,
       1 + (i * 11) % (SELECT count(*) FROM employees)::int,
       d.opened,
       CASE WHEN i % 10 <= 6 THEN d.opened + 1 + (i * 7) % 45 ELSE NULL END,
       CASE
           WHEN i % 17 = 0 THEN 'critical'
           WHEN i % 5 = 0 THEN 'high'
           WHEN i % 3 = 0 THEN 'medium'
           ELSE 'low'
       END,
       CASE i % 10
           WHEN 7 THEN 'open'
           WHEN 8 THEN 'in_progress'
           WHEN 9 THEN 'cancelled'
           ELSE 'closed'
       END,
       round((0.5 + (i * 23 % 320) / 8.0)::numeric, 2),
       round((120 + (i * 61 % 8800) + ((i * 17) % 400) / 4.0)::numeric, 2)
FROM generate_series(1, 1200) AS i,
     LATERAL (SELECT DATE '2023-01-01' + (i * 89) % 1308 AS opened) AS d
WHERE NOT EXISTS (SELECT 1 FROM work_orders);

-- ~2,500 bridge rows; the (wo, part) pair map only repeats at lcm(1200, 59),
-- so all 2,500 pairs are distinct. line_cost = quantity * catalog unit_cost.
INSERT INTO work_order_parts (work_order_id, part_id, quantity, line_cost)
SELECT w.wo_id,
       w.pt_id,
       w.qty,
       round((w.qty * p.unit_cost)::numeric, 2)
FROM (
    SELECT 1 + (i * 7) % (SELECT count(*) FROM work_orders)::int AS wo_id,
           1 + (i * 13) % 59 AS pt_id,
           1 + (i * 3) % 5 AS qty
    FROM generate_series(1, 2500) AS i
) AS w
JOIN parts p ON p.id = w.pt_id
ON CONFLICT (work_order_id, part_id) DO NOTHING;

ANALYZE;

-- Default privileges from 02 already cover new tables, but re-grant explicitly
-- so this script stands alone.
GRANT USAGE ON SCHEMA public TO chart_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO chart_reader;
