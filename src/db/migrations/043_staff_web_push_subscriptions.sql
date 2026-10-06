-- Per-staff Web Push subscriptions for installed portal/PWA notifications.
-- One browser/device endpoint can belong to only one currently authenticated user.
CREATE TABLE IF NOT EXISTS staff_push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  disabled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_staff_push_subscriptions_user_active
  ON staff_push_subscriptions (user_id, updated_at DESC)
  WHERE disabled_at IS NULL;
