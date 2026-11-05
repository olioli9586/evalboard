-- A person's verdict on a graded result, next to the judge's (pass), for
-- measuring how often the judge agrees with a human. Null: not labeled.
alter table results add column human_pass boolean;
