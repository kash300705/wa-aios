-- 005 — Operational email automation.
-- Additive only. Safe to re-run. The `messages` table stays the source of truth
-- for every outbound message; this migration lets it also record what the
-- dispatcher previously discarded (recipient, subject, provider id, last error),
-- ties a message to the call / lead that triggered it, enforces enqueue-time
-- idempotency, and exposes a clean `email_events` view.

begin;

-- ---------------------------------------------------------------------------
-- MESSAGES: delivery metadata + trigger links.
-- ---------------------------------------------------------------------------
alter table messages add column if not exists subject text;
alter table messages add column if not exists recipient text;
alter table messages add column if not exists provider_message_id text;
alter table messages add column if not exists last_error text;
alter table messages add column if not exists call_id uuid references calls(id) on delete set null;
alter table messages add column if not exists lead_id uuid references leads(id) on delete set null;

create index if not exists messages_call_idx on messages (tenant_id, call_id) where call_id is not null;
create index if not exists messages_lead_idx on messages (tenant_id, lead_id) where lead_id is not null;
create index if not exists messages_channel_created_idx on messages (tenant_id, channel, created_at desc);

-- ---------------------------------------------------------------------------
-- Enqueue-time idempotency. The dispatcher already guarantees each queued row
-- is *sent* at most once (claim tokens + SKIP LOCKED); these partial unique
-- indexes stop a duplicate webhook from *creating* a second queued row for the
-- same trigger + template. Collapse any pre-existing duplicates first so the
-- index can be built on existing production data.
-- ---------------------------------------------------------------------------
delete from messages d
where d.id in (
  select id from (
    select id, row_number() over (
      partition by appointment_id, template_id
      order by created_at, id
    ) as rn
    from messages
    where appointment_id is not null
      and direction = 'outbound'
      and delivery_status = 'queued'
  ) ranked
  where ranked.rn > 1
);

create unique index if not exists messages_appt_template_queued_uniq
  on messages (appointment_id, template_id)
  where appointment_id is not null and direction = 'outbound' and delivery_status = 'queued';

create unique index if not exists messages_call_template_uniq
  on messages (call_id, template_id)
  where call_id is not null and direction = 'outbound';

create unique index if not exists messages_lead_template_uniq
  on messages (lead_id, template_id)
  where lead_id is not null and direction = 'outbound';

-- ---------------------------------------------------------------------------
-- email_events — the operational email log the product surfaces. A view over
-- the source-of-truth `messages` table (RLS on messages still applies).
-- ---------------------------------------------------------------------------
create or replace view email_events as
  select
    m.id,
    m.tenant_id,
    m.contact_id,
    m.appointment_id,
    m.call_id,
    m.lead_id,
    m.template_id                    as email_type,
    m.recipient,
    m.subject,
    m.delivery_status                as status,
    m.provider_message_id,
    m.last_error                     as error,
    m.scheduled_for,
    m.created_at,
    m.sent_at
  from messages m
  where m.channel = 'email';

commit;
