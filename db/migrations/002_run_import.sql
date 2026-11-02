-- Runs copied from a browser's v1 history (localStorage) by the one-time
-- import. imported_from is the v1 run's id. One v1 run covered several
-- models, so (imported_from, model) names one v2 run, and the unique index
-- turns a repeated import (two tabs, a retry) into a no-op.
alter table runs add column imported_from uuid;

create unique index runs_imported_from_model_idx
  on runs (imported_from, model) where imported_from is not null;
