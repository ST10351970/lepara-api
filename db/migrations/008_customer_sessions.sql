-- 008: what customer accounts need beyond migration 003.
--
--   customer.session_version
--       Every customer access token carries this number. Raising it ends all
--       of a customer's sessions at once: after a password change or reset,
--       or when the account is deleted.
--   customer.last_login_at
--       Shown on the Security tab.

-- migrate:up

ALTER TABLE customer
  ADD COLUMN session_version integer NOT NULL DEFAULT 0
    CONSTRAINT customer_session_version_check CHECK (session_version >= 0),
  ADD COLUMN last_login_at timestamptz;

-- migrate:down

ALTER TABLE customer
  DROP COLUMN last_login_at,
  DROP COLUMN session_version;
