-- 007: what the admin review queues need.
--
--   volunteer_application.decision_reason
--       Why an application was declined. Task 1 requires a reason to decline
--       (state machine, Section 7.6.2) and the applicant's decision email
--       includes it. Assistance requests and pledges already have this column.
--   *_decline_reason_check
--       A declined volunteer application, assistance request or pledge must
--       have its reason saved, whichever program writes it.

-- migrate:up

ALTER TABLE volunteer_application ADD COLUMN decision_reason text;

ALTER TABLE volunteer_application
  ADD CONSTRAINT volunteer_application_decline_reason_check
    CHECK (status <> 'Declined' OR decision_reason IS NOT NULL);

ALTER TABLE assistance_request
  ADD CONSTRAINT assistance_request_decline_reason_check
    CHECK (status <> 'Declined' OR decision_reason IS NOT NULL);

ALTER TABLE donation_pledge
  ADD CONSTRAINT donation_pledge_decline_reason_check
    CHECK (status <> 'Declined' OR decision_reason IS NOT NULL);

-- migrate:down

ALTER TABLE donation_pledge DROP CONSTRAINT donation_pledge_decline_reason_check;
ALTER TABLE assistance_request DROP CONSTRAINT assistance_request_decline_reason_check;
ALTER TABLE volunteer_application DROP CONSTRAINT volunteer_application_decline_reason_check;
ALTER TABLE volunteer_application DROP COLUMN decision_reason;
