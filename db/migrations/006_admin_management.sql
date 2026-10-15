-- 006: what admin management needs.
--
--   admin_user_email_key
--       One admin account per email address, ignoring capitals.
--   refresh_token.revoke_reason
--       Two more reasons a session can end: a super admin reset that
--       admin's two-factor sign-in, or gave them a new temporary password.

-- migrate:up

CREATE UNIQUE INDEX admin_user_email_key ON admin_user (lower(email));

ALTER TABLE refresh_token
  DROP CONSTRAINT refresh_token_revoke_reason_check,
  ADD CONSTRAINT refresh_token_revoke_reason_check CHECK (
    revoke_reason IN (
      'rotated',
      'signed_out',
      'signed_out_everywhere',
      'password_changed',
      'reuse_detected',
      'account_deactivated',
      'two_factor_reset',
      'password_reset'
    )
  );

-- migrate:down

UPDATE refresh_token SET revoke_reason = 'signed_out_everywhere'
WHERE revoke_reason IN ('two_factor_reset', 'password_reset');

ALTER TABLE refresh_token
  DROP CONSTRAINT refresh_token_revoke_reason_check,
  ADD CONSTRAINT refresh_token_revoke_reason_check CHECK (
    revoke_reason IN (
      'rotated',
      'signed_out',
      'signed_out_everywhere',
      'password_changed',
      'reuse_detected',
      'account_deactivated'
    )
  );

DROP INDEX admin_user_email_key;
