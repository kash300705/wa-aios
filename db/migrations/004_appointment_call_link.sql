-- 004 — Tie an appointment to the Retell call it was booked on, so the
-- call_analyzed webhook can attach the call to the SAME contact the in-call
-- booking created (web/phone calls where the webhook's from_number is unreliable
-- were producing a second, orphaned contact).

alter table appointments add column if not exists retell_call_id text;
create index if not exists appointments_tenant_retell_call_idx
  on appointments (tenant_id, retell_call_id) where retell_call_id is not null;
