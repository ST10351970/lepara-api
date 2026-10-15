-- 002: additions the apps need on top of the Task 1 core.
-- Each block says what it adds and why. Record these in the Task 1 design
-- sections (ERD, class diagram) so the code and the document match.
--
-- NOT NULL columns without defaults are added to tables that are still
-- empty when this runs on a new database.

-- migrate:up

-- ADMIN_USER: roles, authenticator-app sign-in, lockout after failed attempts.
ALTER TABLE admin_user
  ADD COLUMN role varchar(20) NOT NULL DEFAULT 'staff'
    CONSTRAINT admin_user_role_check CHECK (role IN ('super_admin', 'staff')),
  ADD COLUMN totp_secret_encrypted text,
  ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0
    CONSTRAINT admin_user_failed_login_count_check CHECK (failed_login_count >= 0),
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN last_login_at timestamptz,
  ADD CONSTRAINT admin_user_two_factor_secret_check
    CHECK (NOT two_factor_enabled OR totp_secret_encrypted IS NOT NULL);

-- One-time backup codes for a lost phone, stored hashed.
CREATE TABLE admin_backup_code (
  backup_code_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id       integer     NOT NULL REFERENCES admin_user (admin_id) ON DELETE RESTRICT,
  code_hash      char(64)    NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_backup_code_hash_key UNIQUE (admin_id, code_hash)
);

-- INITIATIVE: what the app's event cards show (short text, times, what to donate, image).
ALTER TABLE initiative
  ADD COLUMN summary varchar(200),
  ADD COLUMN start_time time,
  ADD COLUMN end_time time,
  ADD COLUMN donation_needs varchar(255),
  ADD COLUMN image_url varchar(500),
  ADD CONSTRAINT initiative_dates_check CHECK (end_date >= start_date),
  ADD CONSTRAINT initiative_times_check CHECK (
    start_time IS NULL OR end_time IS NULL OR end_date > start_date OR end_time > start_time
  );

-- Volunteer tasks per initiative, for the Task picker on the volunteer form.
CREATE TABLE initiative_task (
  initiative_task_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  initiative_id      integer      NOT NULL REFERENCES initiative (initiative_id) ON DELETE RESTRICT,
  task_name          varchar(100) NOT NULL,
  volunteers_needed  integer
    CONSTRAINT initiative_task_volunteers_needed_check CHECK (volunteers_needed > 0),
  CONSTRAINT initiative_task_name_key UNIQUE (initiative_id, task_name),
  -- Lets an application's task be checked against the application's initiative.
  CONSTRAINT initiative_task_initiative_key UNIQUE (initiative_task_id, initiative_id)
);

-- VOLUNTEER_APPLICATION: fields on the app's form, a tracking reference, POPIA consent.
ALTER TABLE volunteer_application
  ADD COLUMN reference_number varchar(20) NOT NULL
    CONSTRAINT volunteer_application_reference_number_key UNIQUE,
  ADD COLUMN initiative_task_id integer,
  ADD COLUMN contribution_description text,
  ADD COLUMN consent_given_at timestamptz NOT NULL,
  -- The chosen task must belong to the initiative applied for.
  ADD CONSTRAINT volunteer_application_task_fkey
    FOREIGN KEY (initiative_task_id, initiative_id)
    REFERENCES initiative_task (initiative_task_id, initiative_id) ON DELETE RESTRICT;

-- POPIA consent on the other public forms.
ALTER TABLE assistance_request ADD COLUMN consent_given_at timestamptz NOT NULL;
ALTER TABLE enquiry ADD COLUMN consent_given_at timestamptz NOT NULL;

-- DONATION_PLEDGE: the public Give form. An admin turns an accepted pledge
-- into a recorded DONATION once the money or goods arrive.
CREATE TABLE donation_pledge (
  pledge_id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference_number varchar(20)  NOT NULL CONSTRAINT donation_pledge_reference_number_key UNIQUE,
  initiative_id    integer REFERENCES initiative (initiative_id) ON DELETE SET NULL,
  donor_name       varchar(150) NOT NULL,
  email            varchar(150) NOT NULL,
  contact_number   varchar(20)  NOT NULL,
  category         varchar(30)  NOT NULL
    CONSTRAINT donation_pledge_category_check
    CHECK (category IN ('Goods', 'Monetary', 'School supplies', 'Food and essentials')),
  description      text         NOT NULL,
  estimated_value  numeric(10, 2)
    CONSTRAINT donation_pledge_estimated_value_check
    CHECK (estimated_value >= 0 AND estimated_value <= 1000000),
  status           varchar(20)  NOT NULL DEFAULT 'Pending'
    CONSTRAINT donation_pledge_status_check
    CHECK (status IN ('Pending', 'Accepted', 'Received', 'Declined')),
  consent_given_at timestamptz  NOT NULL,
  submitted_date   timestamptz  NOT NULL DEFAULT now(),
  reviewed_by      integer REFERENCES admin_user (admin_id) ON DELETE RESTRICT,
  reviewed_date    timestamptz,
  decision_reason  text
);

-- DONATION: link to its pledge; voiding instead of deleting.
ALTER TABLE donation
  ADD COLUMN pledge_id integer
    CONSTRAINT donation_pledge_id_key UNIQUE
    REFERENCES donation_pledge (pledge_id) ON DELETE RESTRICT,
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by integer REFERENCES admin_user (admin_id) ON DELETE RESTRICT,
  ADD COLUMN void_reason text,
  ADD CONSTRAINT donation_void_check CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL)
  );

-- STOCK_ITEM: unique names, a starting quantity of 0, a low-stock level for the dashboard.
ALTER TABLE stock_item
  ALTER COLUMN quantity_on_hand SET DEFAULT 0,
  ADD COLUMN reorder_level integer NOT NULL DEFAULT 0
    CONSTRAINT stock_item_reorder_level_check CHECK (reorder_level >= 0),
  ADD CONSTRAINT stock_item_item_name_key UNIQUE (item_name);

-- STOCK_MOVEMENT: allow manual adjustments (damaged or expired goods, a
-- recount). Task 1 required every movement to come from a donation or a
-- request; an adjustment has neither, so it must give a reason instead.
ALTER TABLE stock_movement
  ADD COLUMN reason text,
  DROP CONSTRAINT stock_movement_source_check,
  ADD CONSTRAINT stock_movement_source_check CHECK (
    num_nonnulls(donation_id, request_id) = 1
    OR (donation_id IS NULL AND request_id IS NULL AND reason IS NOT NULL)
  );

-- Sessions: refresh tokens are stored hashed so a stolen database copy cannot sign anyone in.
CREATE TABLE refresh_token (
  token_id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_type   varchar(10)  NOT NULL
    CONSTRAINT refresh_token_user_type_check CHECK (user_type IN ('admin', 'customer')),
  user_id     integer      NOT NULL,
  token_hash  char(64)     NOT NULL CONSTRAINT refresh_token_token_hash_key UNIQUE,
  family_id   uuid         NOT NULL,
  expires_at  timestamptz  NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  user_agent  varchar(255)
);

-- Phones and browsers registered for push notifications.
CREATE TABLE device_token (
  device_token_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token           varchar(512) NOT NULL CONSTRAINT device_token_token_key UNIQUE,
  platform        varchar(10)  NOT NULL
    CONSTRAINT device_token_platform_check CHECK (platform IN ('android', 'ios', 'web')),
  created_at      timestamptz  NOT NULL DEFAULT now(),
  last_seen_at    timestamptz  NOT NULL DEFAULT now()
);

-- Who changed what, for data integrity.
CREATE TABLE audit_log (
  audit_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id   integer     NOT NULL REFERENCES admin_user (admin_id) ON DELETE RESTRICT,
  action     varchar(50) NOT NULL,
  table_name varchar(50) NOT NULL,
  record_id  varchar(50) NOT NULL,
  details    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- migrate:down

DROP TABLE audit_log;
DROP TABLE device_token;
DROP TABLE refresh_token;

ALTER TABLE stock_movement
  DROP CONSTRAINT stock_movement_source_check,
  ADD CONSTRAINT stock_movement_source_check CHECK (num_nonnulls(donation_id, request_id) = 1),
  DROP COLUMN reason;

ALTER TABLE stock_item
  DROP CONSTRAINT stock_item_item_name_key,
  DROP COLUMN reorder_level,
  ALTER COLUMN quantity_on_hand DROP DEFAULT;

ALTER TABLE donation
  DROP CONSTRAINT donation_void_check,
  DROP COLUMN void_reason,
  DROP COLUMN voided_by,
  DROP COLUMN voided_at,
  DROP COLUMN pledge_id;

DROP TABLE donation_pledge;

ALTER TABLE enquiry DROP COLUMN consent_given_at;
ALTER TABLE assistance_request DROP COLUMN consent_given_at;

ALTER TABLE volunteer_application
  DROP CONSTRAINT volunteer_application_task_fkey,
  DROP COLUMN consent_given_at,
  DROP COLUMN contribution_description,
  DROP COLUMN initiative_task_id,
  DROP COLUMN reference_number;

DROP TABLE initiative_task;

ALTER TABLE initiative
  DROP CONSTRAINT initiative_times_check,
  DROP CONSTRAINT initiative_dates_check,
  DROP COLUMN image_url,
  DROP COLUMN donation_needs,
  DROP COLUMN end_time,
  DROP COLUMN start_time,
  DROP COLUMN summary;

DROP TABLE admin_backup_code;

ALTER TABLE admin_user
  DROP CONSTRAINT admin_user_two_factor_secret_check,
  DROP COLUMN last_login_at,
  DROP COLUMN locked_until,
  DROP COLUMN failed_login_count,
  DROP COLUMN must_change_password,
  DROP COLUMN two_factor_enabled,
  DROP COLUMN totp_secret_encrypted,
  DROP COLUMN role;
