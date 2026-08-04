-- Demo dataset: plant-maintenance flavor, seeded into demo_app.
--
-- Declared FKs form the chain the modeling GUI auto-suggests:
--   inspections -> valves -> units -> sites   and   inspections -> technicians
-- technicians.home_site_id deliberately has NO foreign key — it is the
-- relationship the user adds by hand in the canvas demo.
-- inspections carries the measures (labor_hours, parts_cost); dates span ~3
-- years for time-bucketing demos; sites.region powers the row-scoping demo
-- (alice is limited to 'Gulf Coast').

CREATE TABLE sites (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE,
    region text NOT NULL
);
COMMENT ON TABLE sites IS 'Plant sites';

CREATE TABLE units (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    site_id integer NOT NULL REFERENCES sites (id),
    name text NOT NULL
);
COMMENT ON TABLE units IS 'Process units within a site';

CREATE TABLE valves (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    unit_id integer NOT NULL REFERENCES units (id),
    tag text NOT NULL UNIQUE,
    valve_type text NOT NULL,
    set_pressure_psi numeric(8, 1) NOT NULL,
    install_date date NOT NULL
);
COMMENT ON TABLE valves IS 'Pressure safety valves';

CREATE TABLE technicians (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    home_site_id integer NOT NULL -- intentionally NO FK: the GUI demo adds this relationship manually
);
COMMENT ON COLUMN technicians.home_site_id IS 'Site the technician is based at (no declared FK on purpose)';

CREATE TABLE inspections (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    valve_id integer NOT NULL REFERENCES valves (id),
    technician_id integer NOT NULL REFERENCES technicians (id),
    inspected_on date NOT NULL,
    result text NOT NULL,
    labor_hours numeric(5, 2) NOT NULL,
    parts_cost numeric(10, 2) NOT NULL
);
COMMENT ON TABLE inspections IS 'Valve inspection events (the fact table)';

INSERT INTO sites (name, region) VALUES
    ('Baytown Plant', 'Gulf Coast'),
    ('Port Arthur Refinery', 'Gulf Coast'),
    ('Toledo Works', 'Midwest'),
    ('Gary Terminal', 'Midwest'),
    ('Carson Facility', 'West'),
    ('Savannah Depot', 'Southeast');

INSERT INTO units (site_id, name)
SELECT s.id, s.name || ' - Unit ' || u
FROM sites s, generate_series(1, 3) AS u;

INSERT INTO valves (unit_id, tag, valve_type, set_pressure_psi, install_date)
SELECT u.id,
       'PSV-' || u.id || '-' || lpad(v::text, 3, '0'),
       (ARRAY['Conventional', 'Balanced Bellows', 'Pilot Operated'])[1 + (u.id + v) % 3],
       150 + ((u.id * 7 + v * 13) % 40) * 25,
       DATE '2015-01-01' + ((u.id * 89 + v * 157) % 2900)
FROM units u, generate_series(1, 15) AS v;

INSERT INTO technicians (name, home_site_id)
SELECT 'Technician ' || chr(64 + t),
       1 + (t - 1) % 6
FROM generate_series(1, 12) AS t;

-- ~2,400 inspections spread across ~3 years ending near 2026-08.
INSERT INTO inspections (valve_id, technician_id, inspected_on, result, labor_hours, parts_cost)
SELECT 1 + (i * 17) % (SELECT count(*) FROM valves)::int,
       1 + (i * 5) % 12,
       DATE '2023-08-01' + (i % 1095),
       CASE
           WHEN i % 11 = 0 THEN 'fail'
           WHEN i % 5 = 0 THEN 'adjusted'
           ELSE 'pass'
       END,
       round((0.5 + (i * 37 % 60) / 8.0)::numeric, 2),
       CASE WHEN i % 11 = 0 THEN round((50 + (i * 91 % 4500) / 10.0)::numeric, 2) ELSE round(((i * 13 % 800) / 10.0)::numeric, 2) END
FROM generate_series(1, 2400) AS i;

ANALYZE;

-- SELECT-only access for the charting role — the pattern hosts should copy.
GRANT USAGE ON SCHEMA public TO chart_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO chart_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO chart_reader;
