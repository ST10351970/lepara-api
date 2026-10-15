-- 004: indexes for the lists and filters the API will run, plus one rule
-- that is easiest to enforce with a unique index.
-- Unique constraints (reference numbers, usernames, SKUs) already have indexes.

-- migrate:up

-- Public event lists: published or closed, ordered by date.
CREATE INDEX initiative_status_start_idx ON initiative (status, start_date);
CREATE INDEX initiative_type_idx ON initiative (initiative_type_id);

-- Admin review queues: filter by status, newest first.
CREATE INDEX assistance_request_status_idx ON assistance_request (status, submitted_date DESC);
CREATE INDEX volunteer_application_status_idx ON volunteer_application (status, submitted_date DESC);
CREATE INDEX volunteer_application_initiative_idx ON volunteer_application (initiative_id, status);
CREATE INDEX donation_pledge_status_idx ON donation_pledge (status, submitted_date DESC);
CREATE INDEX enquiry_status_idx ON enquiry (status, submitted_date DESC);

-- One pending application per phone number per initiative (a second one gets a friendly 409).
CREATE UNIQUE INDEX volunteer_application_pending_key
  ON volunteer_application (initiative_id, contact_number)
  WHERE status = 'Submitted';

-- Donation register and reports.
CREATE INDEX donation_date_idx ON donation (date_received);
CREATE INDEX donation_initiative_idx ON donation (initiative_id);
CREATE INDEX stock_movement_item_idx ON stock_movement (stock_item_id, movement_date);
CREATE INDEX stock_movement_request_idx ON stock_movement (request_id);

-- News list.
CREATE INDEX announcement_active_idx ON announcement (is_active, published_date DESC);

-- Sessions, codes, audit.
CREATE INDEX refresh_token_user_idx ON refresh_token (user_type, user_id);
CREATE INDEX refresh_token_family_idx ON refresh_token (family_id);
CREATE INDEX verification_code_customer_idx ON verification_code (customer_id, purpose);
CREATE INDEX device_token_customer_idx ON device_token (customer_id);
CREATE INDEX audit_log_record_idx ON audit_log (table_name, record_id);
CREATE INDEX audit_log_admin_idx ON audit_log (admin_id, created_at);

-- Shop.
CREATE INDEX product_category_active_idx ON product (category_id, is_active);
CREATE INDEX customer_order_customer_idx ON customer_order (customer_id, created_at DESC);
CREATE INDEX customer_order_status_idx ON customer_order (status, created_at);
CREATE INDEX order_item_order_idx ON order_item (order_id);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, changed_at);
CREATE INDEX payment_order_idx ON payment (order_id);

-- migrate:down

DROP INDEX payment_order_idx;
DROP INDEX order_status_history_order_idx;
DROP INDEX order_item_order_idx;
DROP INDEX customer_order_status_idx;
DROP INDEX customer_order_customer_idx;
DROP INDEX product_category_active_idx;
DROP INDEX audit_log_admin_idx;
DROP INDEX audit_log_record_idx;
DROP INDEX device_token_customer_idx;
DROP INDEX verification_code_customer_idx;
DROP INDEX refresh_token_family_idx;
DROP INDEX refresh_token_user_idx;
DROP INDEX announcement_active_idx;
DROP INDEX stock_movement_request_idx;
DROP INDEX stock_movement_item_idx;
DROP INDEX donation_initiative_idx;
DROP INDEX donation_date_idx;
DROP INDEX volunteer_application_pending_key;
DROP INDEX enquiry_status_idx;
DROP INDEX donation_pledge_status_idx;
DROP INDEX volunteer_application_initiative_idx;
DROP INDEX volunteer_application_status_idx;
DROP INDEX assistance_request_status_idx;
DROP INDEX initiative_type_idx;
DROP INDEX initiative_status_start_idx;
