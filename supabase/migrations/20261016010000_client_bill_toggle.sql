-- Interruptor de Ver cuenta para instalaciones que ya tienen las cartas.
begin;
alter table public.business_settings
  add column if not exists client_bill_enabled boolean not null default true;
commit;
