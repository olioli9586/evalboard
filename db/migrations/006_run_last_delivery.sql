-- When a queue delivery last picked up the run, failed batches included. A
-- chain that keeps failing writes no results, so without this a run that is
-- still retrying would look stuck, and an admin resume would start a second
-- chain next to the live one.
alter table runs add column last_delivery_at timestamptz;
