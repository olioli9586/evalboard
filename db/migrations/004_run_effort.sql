-- The effort level a run asked for (output_config.effort). Null means the
-- model's own default.
alter table runs add column effort text
  check (effort in ('low', 'medium', 'high', 'xhigh', 'max'));
