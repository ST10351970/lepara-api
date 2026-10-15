-- Creates lepara_app, the limited user the running API connects as.
-- It can read, add and change rows, but it cannot drop or alter tables, and it
-- cannot delete donations, submissions, orders or any other record people rely on.
--
-- Run once, as the database owner, AFTER `npm run migrate:up`:
--   psql "<owner connection string>" -v app_password='<a long random password>' -f db/setup/create-app-user.sql
-- Then use lepara_app in DATABASE_URL. Re-run the GRANT lines after future migrations
-- add tables (the ALTER DEFAULT PRIVILEGES lines cover tables the owner creates later).

\set ON_ERROR_STOP on

CREATE ROLE lepara_app LOGIN PASSWORD :'app_password';

GRANT CONNECT ON DATABASE :"DBNAME" TO lepara_app;
GRANT USAGE ON SCHEMA public TO lepara_app;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO lepara_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lepara_app;

-- Only short-lived rows may be deleted: sessions, codes, device tokens, tasks.
GRANT DELETE ON refresh_token, verification_code, device_token, idempotency_key,
  admin_backup_code, initiative_task TO lepara_app;

-- The migration history is the owner's business.
REVOKE ALL ON schema_migrations FROM lepara_app;

-- Tables and sequences the owner creates later get the same read, add and change rights.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO lepara_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO lepara_app;
