-- 003: customer accounts and the clothing shop (not part of the Task 1 design).
-- Money in the shop is stored as whole cents (integers) so totals never drift.
-- Merchandise stock lives in PRODUCT_VARIANT, never in STOCK_ITEM, which holds
-- donated goods for distribution.

-- migrate:up

CREATE TABLE customer (
  customer_id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  first_name         varchar(60)  NOT NULL,
  last_name          varchar(60)  NOT NULL,
  email              varchar(254) NOT NULL,
  mobile             varchar(20)  NOT NULL,
  password_hash      varchar(255) NOT NULL,
  email_verified_at  timestamptz,
  two_factor_enabled boolean      NOT NULL DEFAULT false,
  failed_login_count integer      NOT NULL DEFAULT 0
    CONSTRAINT customer_failed_login_count_check CHECK (failed_login_count >= 0),
  locked_until       timestamptz,
  terms_accepted_at  timestamptz  NOT NULL,
  is_active          boolean      NOT NULL DEFAULT true,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

-- One account per email address, ignoring upper and lower case.
CREATE UNIQUE INDEX customer_email_key ON customer (lower(email));

-- Push notifications can now be linked to a signed-in customer.
ALTER TABLE device_token
  ADD COLUMN customer_id integer REFERENCES customer (customer_id) ON DELETE SET NULL;

-- 6-digit codes: email verification, login codes, password resets, email changes.
CREATE TABLE verification_code (
  code_id     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id integer     NOT NULL REFERENCES customer (customer_id) ON DELETE RESTRICT,
  purpose     varchar(20) NOT NULL
    CONSTRAINT verification_code_purpose_check
    CHECK (purpose IN ('verify_email', 'login_2fa', 'reset_password', 'change_email')),
  code_hash   char(64)    NOT NULL,
  new_email   varchar(254),
  expires_at  timestamptz NOT NULL,
  attempts    integer     NOT NULL DEFAULT 0
    CONSTRAINT verification_code_attempts_check CHECK (attempts >= 0),
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_code_new_email_check
    CHECK ((purpose = 'change_email') = (new_email IS NOT NULL))
);

CREATE TABLE product_category (
  category_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        varchar(60) NOT NULL CONSTRAINT product_category_name_key UNIQUE,
  sort_order  integer     NOT NULL DEFAULT 0
);

CREATE TABLE product (
  product_id  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id integer      NOT NULL REFERENCES product_category (category_id) ON DELETE RESTRICT,
  name        varchar(120) NOT NULL,
  colour      varchar(40),
  material    varchar(60),
  description text,
  price_cents integer      NOT NULL CONSTRAINT product_price_cents_check CHECK (price_cents > 0),
  image_url   varchar(500),
  is_active   boolean      NOT NULL DEFAULT true,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE product_variant (
  variant_id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id       integer     NOT NULL REFERENCES product (product_id) ON DELETE RESTRICT,
  size             varchar(10) NOT NULL
    CONSTRAINT product_variant_size_check
    CHECK (size IN ('XS', 'S', 'M', 'L', 'XL', 'XXL', 'One size')),
  sku              varchar(40) NOT NULL CONSTRAINT product_variant_sku_key UNIQUE,
  quantity_on_hand integer     NOT NULL DEFAULT 0
    CONSTRAINT product_variant_quantity_on_hand_check CHECK (quantity_on_hand >= 0),
  CONSTRAINT product_variant_size_key UNIQUE (product_id, size)
);

-- Order numbers in the app's format, LAFM-1001, LAFM-1002, ...
CREATE SEQUENCE order_number_seq START WITH 1001;

-- ORDER is a reserved word in SQL, hence CUSTOMER_ORDER.
CREATE TABLE customer_order (
  order_id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_number      varchar(20)  NOT NULL DEFAULT ('LAFM-' || nextval('order_number_seq'))
    CONSTRAINT customer_order_order_number_key UNIQUE,
  customer_id       integer      NOT NULL REFERENCES customer (customer_id) ON DELETE RESTRICT,
  status            varchar(20)  NOT NULL
    CONSTRAINT customer_order_status_check
    CHECK (status IN ('Pending payment', 'Confirmed', 'Packed', 'Shipped', 'Delivered', 'Cancelled')),
  payment_method    varchar(20)  NOT NULL
    CONSTRAINT customer_order_payment_method_check
    CHECK (payment_method IN ('EFT', 'Cash on delivery', 'PayFast')),
  payment_status    varchar(10)  NOT NULL DEFAULT 'Unpaid'
    CONSTRAINT customer_order_payment_status_check
    CHECK (payment_status IN ('Unpaid', 'Paid', 'Refunded')),
  recipient_name    varchar(120) NOT NULL,
  street_address    varchar(120) NOT NULL,
  city              varchar(60)  NOT NULL,
  postal_code       char(4)      NOT NULL
    CONSTRAINT customer_order_postal_code_check CHECK (postal_code ~ '^[0-9]{4}$'),
  phone             varchar(20)  NOT NULL,
  subtotal_cents    bigint       NOT NULL CONSTRAINT customer_order_subtotal_check CHECK (subtotal_cents >= 0),
  delivery_cents    bigint       NOT NULL CONSTRAINT customer_order_delivery_check CHECK (delivery_cents >= 0),
  total_cents       bigint       NOT NULL,
  courier_reference varchar(60),
  cancel_reason     text,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  -- A wrong calculation is rejected by the database even if the code has a bug.
  CONSTRAINT customer_order_total_check CHECK (total_cents = subtotal_cents + delivery_cents),
  CONSTRAINT customer_order_shipped_check
    CHECK (status NOT IN ('Shipped', 'Delivered') OR courier_reference IS NOT NULL)
);

ALTER SEQUENCE order_number_seq OWNED BY customer_order.order_number;

CREATE TABLE order_item (
  order_item_id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id         integer      NOT NULL REFERENCES customer_order (order_id) ON DELETE RESTRICT,
  variant_id       integer      NOT NULL REFERENCES product_variant (variant_id) ON DELETE RESTRICT,
  -- Copied at checkout, so a later price or name change never alters a past order.
  product_name     varchar(120) NOT NULL,
  size             varchar(10)  NOT NULL,
  unit_price_cents integer      NOT NULL CONSTRAINT order_item_unit_price_check CHECK (unit_price_cents > 0),
  quantity         integer      NOT NULL CONSTRAINT order_item_quantity_check CHECK (quantity BETWEEN 1 AND 10),
  line_total_cents bigint       NOT NULL,
  CONSTRAINT order_item_line_total_check CHECK (line_total_cents = unit_price_cents * quantity::bigint)
);

-- Each status change, which drives the tracking steps on the app's Orders tab.
CREATE TABLE order_status_history (
  history_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   integer     NOT NULL REFERENCES customer_order (order_id) ON DELETE RESTRICT,
  status     varchar(20) NOT NULL
    CONSTRAINT order_status_history_status_check
    CHECK (status IN ('Pending payment', 'Confirmed', 'Packed', 'Shipped', 'Delivered', 'Cancelled')),
  changed_by integer REFERENCES admin_user (admin_id) ON DELETE RESTRICT,
  note       text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment (
  payment_id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id           integer      NOT NULL REFERENCES customer_order (order_id) ON DELETE RESTRICT,
  provider           varchar(20)  NOT NULL
    CONSTRAINT payment_provider_check CHECK (provider IN ('Manual EFT', 'Cash on delivery', 'PayFast')),
  provider_reference varchar(100),
  amount_cents       bigint       NOT NULL CONSTRAINT payment_amount_check CHECK (amount_cents > 0),
  status             varchar(10)  NOT NULL
    CONSTRAINT payment_status_check CHECK (status IN ('Complete', 'Failed', 'Cancelled')),
  raw_notification   jsonb,
  recorded_by        integer REFERENCES admin_user (admin_id) ON DELETE RESTRICT,
  received_at        timestamptz  NOT NULL DEFAULT now(),
  -- The same PayFast notification arriving twice is stored once.
  CONSTRAINT payment_provider_reference_key UNIQUE (provider, provider_reference)
);

-- Stops a double tap on "Place order" creating two orders.
CREATE TABLE idempotency_key (
  customer_id     integer      NOT NULL REFERENCES customer (customer_id) ON DELETE RESTRICT,
  idempotency_key uuid         NOT NULL,
  endpoint        varchar(100) NOT NULL,
  request_hash    char(64)     NOT NULL,
  response_status smallint,
  response_body   jsonb,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, idempotency_key)
);

-- migrate:down

DROP TABLE idempotency_key;
DROP TABLE payment;
DROP TABLE order_status_history;
DROP TABLE order_item;
DROP TABLE customer_order;
DROP TABLE product_variant;
DROP TABLE product;
DROP TABLE product_category;
DROP TABLE verification_code;
ALTER TABLE device_token DROP COLUMN customer_id;
DROP TABLE customer;
