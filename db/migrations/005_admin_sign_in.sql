-- 005: what admin sign-in needs beyond migration 002.
--
--   admin_user.session_version
--       Every access token carries this number. Raising it ends all of an
--       admin's sessions at once: after a password change, "sign out
--       everywhere", or when a stolen refresh token is detected.
--   admin_user.totp_last_used_step
--       The last authenticator time step that was accepted (seconds since
--       1970 divided by 30). A code at or before it is refused, so each
--       6-digit code works only once.
--   refresh_token.revoke_reason
--       Why a refresh token stopped working. A token that was replaced
--       ("rotated") and then comes back is a sign it was copied, so the API
--       signs that admin out everywhere.

-- migrate:up

ALTER TABLE admin_user
  ADD COLUMN session_version integer NOT NULL DEFAULT 0
    CONSTRAINT admin_user_session_version_check CHECK (session_version >= 0),
  ADD COLUMN totp_last_used_step integer
    CONSTRAINT admin_user_totp_last_used_step_check CHECK (totp_last_used_step >= 0);

ALTER TABLE refresh_token
  ADD COLUMN revoke_reason varchar(30)
    CONSTRAINT refresh_token_revoke_reason_check CHECK (
      revoke_reason IN (
        'rotated',
        'signed_out',
        'signed_out_everywhere',
        'password_changed',
        'reuse_detected',
        'account_deactivated'
      )
    ),
  ADD CONSTRAINT refresh_token_revoked_check
    CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL));

-- migrate:down

ALTER TABLE refresh_token
  DROP CONSTRAINT refresh_token_revoked_check,
  DROP COLUMN revoke_reason;

ALTER TABLE admin_user
  DROP COLUMN totp_last_used_step,
  DROP COLUMN session_version;
