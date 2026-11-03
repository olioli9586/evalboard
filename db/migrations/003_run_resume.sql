-- When an admin last restarted a stuck or failed run's chain of batches.
-- Counts as activity, so a second resume right after the first is refused
-- instead of starting a second chain.
alter table runs add column resumed_at timestamptz;
