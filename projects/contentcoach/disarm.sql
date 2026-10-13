-- Runs on every fresh snapshot of staging, before anything connects to it.
-- Real data stays; anything that could act on the outside world goes.
-- migrations GRANT to the app's least-privilege role; it must exist in the
-- factory's cluster (previews connect as the factory superuser)
DO $$BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cc_app') THEN CREATE ROLE cc_app NOLOGIN; END IF;
END$$;
BEGIN;
-- inherited work: renewals, refreshes, deliveries, reports
DELETE FROM jobs WHERE status IN ('queued', 'running', 'cancelling');
-- Paylov's vault tokens are what a charge needs; the rows (last4, plan) stay
UPDATE paylov_cards SET card_id = 'disarmed-' || md5(card_id), renews_at = NULL;
-- staging's sign-in links must not open a preview, and the reverse
DELETE FROM web_login_tokens;
DELETE FROM connect_tokens;
COMMIT;
