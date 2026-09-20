-- Configuracion compartida de propina y ubicacion visual de mesas.
-- Supabase es la autoridad para que todos los dispositivos vean lo mismo.

alter table public.business_settings
  add column if not exists tips_enabled boolean not null default false,
  add column if not exists tip_percentage integer not null default 10;

alter table public.business_settings
  drop constraint if exists business_settings_tip_percentage_check;

alter table public.business_settings
  add constraint business_settings_tip_percentage_check
  check (tip_percentage between 1 and 100);

alter table public.restaurant_tables
  add column if not exists is_outdoor boolean not null default false;

create or replace function public.save_table_zones(
  auth_token text,
  outdoor_table_ids uuid[] default array[]::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.require_admin(auth_token);

  update public.restaurant_tables
  set is_outdoor = (id = any(coalesce(outdoor_table_ids, array[]::uuid[]))),
      updated_at = now();

  return jsonb_build_object(
    'ok', true,
    'tables', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', table_row.id,
        'is_outdoor', table_row.is_outdoor
      ) order by table_row.table_number), '[]'::jsonb)
      from public.restaurant_tables table_row
    )
  );
end;
$$;

grant execute on function public.save_table_zones(text, uuid[]) to anon, authenticated, service_role;

alter table public.business_settings replica identity full;
alter table public.restaurant_tables replica identity full;
alter table public.menu_categories replica identity full;
alter table public.menu_items replica identity full;

do $$
begin
  begin alter publication supabase_realtime add table public.business_settings; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.restaurant_tables; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.menu_categories; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.menu_items; exception when duplicate_object then null; end;
end;
$$;
