-- Permite consultar el aviso antes del login y amplía el plazo anterior a 50 horas.
alter table public.business_settings
  add column if not exists payment_deadline timestamptz;

update public.business_settings
   set payment_deadline = payment_deadline + interval '2 hours'
 where payment_deadline is not null;

create or replace function public.get_payment_deadline()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  deadline_value timestamptz;
begin
  insert into public.business_settings (is_primary)
  values (true)
  on conflict (is_primary) do nothing;

  update public.business_settings
     set payment_deadline = clock_timestamp() + interval '50 hours'
   where is_primary = true and payment_deadline is null
   returning payment_deadline into deadline_value;

  if deadline_value is null then
    select payment_deadline into deadline_value
      from public.business_settings
     where is_primary = true;
  end if;

  return jsonb_build_object(
    'deadline', deadline_value,
    'server_now', clock_timestamp()
  );
end;
$$;

grant execute on function public.get_payment_deadline() to anon, authenticated, service_role;
