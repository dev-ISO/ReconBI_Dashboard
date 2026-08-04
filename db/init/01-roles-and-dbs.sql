-- Runs once on first container start (docker-entrypoint-initdb.d), connected to
-- demo_app as the postgres superuser.
--
-- Two databases prove the recommended split: chart queries hit demo_app through
-- the SELECT-only chart_reader role, while the library's own rcd_ tables live
-- in demo_dashboards under the app role. Passwords are dev-only defaults; the
-- compose file wires the same values into the demo API.

CREATE DATABASE demo_dashboards;

CREATE ROLE chart_reader LOGIN PASSWORD 'chart_reader_password';
GRANT CONNECT ON DATABASE demo_app TO chart_reader;
