-- Cartas privadas por mesa e interruptores del cliente.
begin;

alter table public.business_settings
  add column if not exists client_menu_enabled boolean not null default true,
  add column if not exists client_bill_enabled boolean not null default true,
  add column if not exists client_waiter_enabled boolean not null default true,
  add column if not exists client_chat_enabled boolean not null default true,
  add column if not exists client_song_enabled boolean not null default true;

create table if not exists public.business_menu_cards (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  image_path text not null unique,
  color text not null check (color in ('blue', 'violet', 'green', 'amber', 'rose', 'cyan')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.business_menu_card_tables (
  card_id uuid not null references public.business_menu_cards(id) on delete cascade,
  table_id uuid not null references public.restaurant_tables(id) on delete cascade,
  primary key (card_id, table_id)
);
create index if not exists business_menu_card_tables_table_idx
  on public.business_menu_card_tables(table_id, card_id);

alter table public.business_menu_cards enable row level security;
alter table public.business_menu_card_tables enable row level security;
revoke all on public.business_menu_cards, public.business_menu_card_tables from anon, authenticated;

create or replace function public.require_menu_card_admin(p_auth_token text)
returns void language plpgsql stable security definer set search_path = public, extensions as $$
declare actor public.app_users;
begin
  actor := public.require_app_user(p_auth_token);
  if actor.role <> 'boss' and (actor.role <> 'admin' or not coalesce(actor.permissions, '[]'::jsonb) ? 'brand') then
    raise exception 'No tienes permiso para configurar las cartas.';
  end if;
end;
$$;

create or replace function public.list_business_menu_cards(p_auth_token text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform public.require_menu_card_admin(p_auth_token);
  return coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('table_ids', (
    select coalesce(jsonb_agg(m.table_id order by m.table_id), '[]'::jsonb)
    from public.business_menu_card_tables m where m.card_id = c.id
  )) order by c.created_at, c.id) from public.business_menu_cards c), '[]'::jsonb);
end;
$$;

create or replace function public.save_business_menu_card(
  p_card_id uuid, p_name text, p_image_path text, p_color text,
  p_table_ids uuid[], p_auth_token text
)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare saved public.business_menu_cards;
begin
  perform public.require_menu_card_admin(p_auth_token);
  if p_card_id is null or length(trim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'Escribe un nombre para la carta (máximo 80 caracteres).';
  end if;
  -- Serializa las altas para respetar el máximo aun con dos administradores.
  perform pg_advisory_xact_lock(hashtext('business_menu_cards_limit'));
  if not exists (select 1 from public.business_menu_cards where id = p_card_id)
     and (select count(*) from public.business_menu_cards) >= 5 then
    raise exception 'Puedes subir hasta 5 imágenes de cartas. Elimina una antes de añadir otra.';
  end if;
  if p_image_path is null or p_image_path not like 'cards/' || p_card_id::text || '/%'
     or not exists (select 1 from storage.objects where bucket_id = 'menu-cards' and name = p_image_path) then
    raise exception 'Sube la imagen de esta carta antes de guardarla.';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_table_ids, array[]::uuid[])) selected(id)
    where not exists (select 1 from public.restaurant_tables t where t.id = selected.id and t.is_active)
  ) then raise exception 'La selección contiene mesas que ya no están activas. Actualiza la página.'; end if;
  insert into public.business_menu_cards(id, name, image_path, color)
  values (p_card_id, trim(p_name), p_image_path, p_color)
  on conflict (id) do update set name = excluded.name, image_path = excluded.image_path,
    color = excluded.color, updated_at = clock_timestamp()
  returning * into saved;
  delete from public.business_menu_card_tables where card_id = saved.id;
  insert into public.business_menu_card_tables(card_id, table_id)
    select saved.id, selected.id from (select distinct unnest(coalesce(p_table_ids, array[]::uuid[])) id) selected;
  return to_jsonb(saved) || jsonb_build_object('table_ids', to_jsonb(coalesce(p_table_ids, array[]::uuid[])));
end;
$$;

create or replace function public.delete_business_menu_card(p_card_id uuid, p_auth_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.require_menu_card_admin(p_auth_token);
  delete from public.business_menu_cards where id = p_card_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.get_table_menu_cards(p_table_id uuid, p_table_access_code text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not public.valid_table_access(p_table_id, p_table_access_code) then raise exception 'Mesa no autorizada.'; end if;
  if exists (select 1 from public.business_settings where is_primary and not client_menu_enabled) then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'image_path', c.image_path) order by c.created_at, c.id)
    from public.business_menu_cards c join public.business_menu_card_tables m on m.card_id = c.id
    where m.table_id = p_table_id
  ), '[]'::jsonb);
end;
$$;

-- Las imágenes no son públicas: conocer una ruta no concede acceso a otra carta.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('menu-cards', 'menu-cards', false, 15728640, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_read_menu_card_image(p_image_path text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select (public.app_is_admin() and public.app_can_access_section('brand')) or (
    not exists (select 1 from public.business_settings where is_primary and not client_menu_enabled)
    and exists (
      select 1 from public.business_menu_cards c
      join public.business_menu_card_tables m on m.card_id = c.id
      where c.image_path = p_image_path and public.valid_table_header(m.table_id)
    )
  );
$$;

drop policy if exists menu_card_images_read on storage.objects;
create policy menu_card_images_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'menu-cards' and public.can_read_menu_card_image(name));
drop policy if exists menu_card_images_insert on storage.objects;
create policy menu_card_images_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'menu-cards' and public.app_is_admin() and public.app_can_access_section('brand'));
drop policy if exists menu_card_images_update on storage.objects;
create policy menu_card_images_update on storage.objects for update to anon, authenticated
  using (bucket_id = 'menu-cards' and public.app_is_admin() and public.app_can_access_section('brand'))
  with check (bucket_id = 'menu-cards' and public.app_is_admin() and public.app_can_access_section('brand'));
drop policy if exists menu_card_images_delete on storage.objects;
create policy menu_card_images_delete on storage.objects for delete to anon, authenticated
  using (bucket_id = 'menu-cards' and public.app_is_admin() and public.app_can_access_section('brand'));

revoke all on function public.require_menu_card_admin(text) from public;
revoke all on function public.list_business_menu_cards(text) from public;
revoke all on function public.save_business_menu_card(uuid, text, text, text, uuid[], text) from public;
revoke all on function public.delete_business_menu_card(uuid, text) from public;
revoke all on function public.get_table_menu_cards(uuid, text) from public;
revoke all on function public.can_read_menu_card_image(text) from public;
grant execute on function public.list_business_menu_cards(text),
  public.save_business_menu_card(uuid, text, text, text, uuid[], text),
  public.delete_business_menu_card(uuid, text), public.get_table_menu_cards(uuid, text),
  public.can_read_menu_card_image(text) to anon, authenticated;

commit;
