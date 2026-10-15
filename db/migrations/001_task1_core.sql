-- 001: the ten tables from Task 1, Section 8, exactly as designed.
--
-- Task 1 names tables in upper case (ADMIN_USER). PostgreSQL folds unquoted
-- names to lower case, so ADMIN_USER and admin_user are the same table.
-- Every change to this design is made in a later migration, so each
-- departure from Task 1 can be traced.

-- migrate:up

CREATE TABLE admin_user (
  admin_id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      varchar(50)  NOT NULL CONSTRAINT admin_user_username_key UNIQUE,
  email         varchar(150) NOT NULL,
  password_hash varchar(255) NOT NULL,
  full_name     varchar(150) NOT NULL,
  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE initiative_type (
  initiative_type_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type_name          varchar(100) NOT NULL CONSTRAINT initiative_type_type_name_key UNIQUE,
  description        varchar(255)
);

CREATE TABLE stock_item (
  stock_item_id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_name        varchar(150) NOT NULL,
  category         varchar(100),
  unit_of_measure  varchar(50)  NOT NULL,
  quantity_on_hand integer      NOT NULL
    CONSTRAINT stock_item_quantity_on_hand_check CHECK (quantity_on_hand >= 0)
);

CREATE TABLE initiative (
  initiative_id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  initiative_type_id  integer      NOT NULL
    REFERENCES initiative_type (initiative_type_id) ON DELETE RESTRICT,
  created_by          integer      NOT NULL
    REFERENCES admin_user (admin_id) ON DELETE RESTRICT,
  title               varchar(200) NOT NULL,
  description         text         NOT NULL,
  location            varchar(200),
  start_date          date         NOT NULL,
  end_date            date         NOT NULL,
  volunteers_required boolean      NOT NULL,
  status              varchar(20)  NOT NULL
    CONSTRAINT initiative_status_check CHECK (status IN ('Draft', 'Published', 'Closed')),
  created_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE assistance_request (
  request_id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference_number varchar(20)  NOT NULL CONSTRAINT assistance_request_reference_number_key UNIQUE,
  reviewed_by      integer
    REFERENCES admin_user (admin_id) ON DELETE RESTRICT,
  applicant_name   varchar(150) NOT NULL,
  contact_number   varchar(20)  NOT NULL,
  email            varchar(150),
  request_type     varchar(100) NOT NULL,
  description      text         NOT NULL,
  status           varchar(20)  NOT NULL
    CONSTRAINT assistance_request_status_check
    CHECK (status IN ('Submitted', 'Under review', 'Approved', 'Declined', 'Fulfilled', 'Closed')),
  submitted_date   timestamptz  NOT NULL DEFAULT now(),
  reviewed_date    timestamptz,
  decision_reason  text
);

CREATE TABLE volunteer_application (
  application_id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  initiative_id     integer      NOT NULL
    REFERENCES initiative (initiative_id) ON DELETE RESTRICT,
  reviewed_by       integer
    REFERENCES admin_user (admin_id) ON DELETE RESTRICT,
  applicant_name    varchar(150) NOT NULL,
  contact_number    varchar(20)  NOT NULL,
  email             varchar(150),
  availability_note text,
  status            varchar(20)  NOT NULL
    CONSTRAINT volunteer_application_status_check
    CHECK (status IN ('Submitted', 'Accepted', 'Declined', 'Attended', 'Did not attend')),
  submitted_date    timestamptz  NOT NULL DEFAULT now(),
  reviewed_date     timestamptz
);

CREATE TABLE donation (
  donation_id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_by       integer      NOT NULL
    REFERENCES admin_user (admin_id) ON DELETE RESTRICT,
  initiative_id     integer
    REFERENCES initiative (initiative_id) ON DELETE SET NULL,
  stock_item_id     integer
    REFERENCES stock_item (stock_item_id) ON DELETE RESTRICT,
  donor_name        varchar(150) NOT NULL,
  is_anonymous      boolean      NOT NULL DEFAULT false,
  donation_type     varchar(10)  NOT NULL
    CONSTRAINT donation_donation_type_check CHECK (donation_type IN ('Monetary', 'Goods')),
  amount            numeric(10, 2)
    CONSTRAINT donation_amount_check CHECK (amount > 0),
  receipt_reference varchar(50),
  quantity          integer
    CONSTRAINT donation_quantity_check CHECK (quantity > 0),
  date_received     date         NOT NULL,
  -- Section 8.4: the columns filled in must match the donation type.
  CONSTRAINT donation_type_columns_check CHECK (
    (donation_type = 'Monetary'
      AND amount IS NOT NULL AND quantity IS NULL AND stock_item_id IS NULL)
    OR
    (donation_type = 'Goods'
      AND quantity IS NOT NULL AND stock_item_id IS NOT NULL AND amount IS NULL)
  )
);

CREATE TABLE stock_movement (
  movement_id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stock_item_id integer     NOT NULL
    REFERENCES stock_item (stock_item_id) ON DELETE RESTRICT,
  donation_id   integer
    REFERENCES donation (donation_id) ON DELETE RESTRICT,
  request_id    integer
    REFERENCES assistance_request (request_id) ON DELETE RESTRICT,
  recorded_by   integer     NOT NULL
    REFERENCES admin_user (admin_id) ON DELETE RESTRICT,
  movement_type varchar(10) NOT NULL
    CONSTRAINT stock_movement_movement_type_check CHECK (movement_type IN ('Increase', 'Decrease')),
  quantity      integer     NOT NULL
    CONSTRAINT stock_movement_quantity_check CHECK (quantity > 0),
  movement_date timestamptz NOT NULL DEFAULT now(),
  -- Section 8.4: every movement comes from exactly one donation or one request.
  CONSTRAINT stock_movement_source_check CHECK (num_nonnulls(donation_id, request_id) = 1)
);

CREATE TABLE announcement (
  announcement_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  published_by    integer      NOT NULL
    REFERENCES admin_user (admin_id) ON DELETE RESTRICT,
  title           varchar(200) NOT NULL,
  body            text         NOT NULL,
  published_date  timestamptz  NOT NULL DEFAULT now(),
  is_active       boolean      NOT NULL DEFAULT true
);

CREATE TABLE enquiry (
  enquiry_id     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_name   varchar(150) NOT NULL,
  contact_number varchar(20),
  email          varchar(150) NOT NULL,
  enquiry_type   varchar(20)  NOT NULL
    CONSTRAINT enquiry_enquiry_type_check CHECK (enquiry_type IN ('Donor', 'Partner')),
  message        text         NOT NULL,
  status         varchar(20)  NOT NULL
    CONSTRAINT enquiry_status_check CHECK (status IN ('New', 'Reviewed')),
  submitted_date timestamptz  NOT NULL DEFAULT now()
);

-- migrate:down

DROP TABLE enquiry;
DROP TABLE announcement;
DROP TABLE stock_movement;
DROP TABLE donation;
DROP TABLE volunteer_application;
DROP TABLE assistance_request;
DROP TABLE initiative;
DROP TABLE stock_item;
DROP TABLE initiative_type;
DROP TABLE admin_user;
