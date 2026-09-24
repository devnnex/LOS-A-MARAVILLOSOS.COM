-- Roles Jefe / Administrador / Mesero y permisos por sección.
-- Convierte los administradores existentes en Jefes para conservar el acceso total.

begin;

alter table public.app_users
  add column if not exists permissions jsonb not null default '[]'::jsonb;

alter table public.app_users drop constraint if exists app_users_role_check;
update public.app_users set role = 'boss' where role = 'admin';
alter table public.app_users
  add constraint app_users_role_check check (role in ('boss', 'admin', 'waiter'));

create or replace function public.public_user(user_value public.app_users)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'id', user_value.id,
    'full_name', user_value.full_name,
    'username', user_value.username,
    'role', user_value.role,
    'permissions', coalesce(user_value.permissions, '[]'::jsonb),
    'is_active', user_value.is_active,
    'last_login_at', user_value.last_login_at,
    'created_at', user_value.created_at,
    'updated_at', user_value.updated_at
  );
$$;

create or replace function public.app_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce((public.app_user_for_token(public.request_header('x-app-token'))).role in ('boss', 'admin'), false);
$$;

create or replace function public.app_is_boss()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce((public.app_user_for_token(public.request_header('x-app-token'))).role = 'boss', false);
$$;

create or replace function public.app_can_access_section(section_name text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select case
    when (staff).id is null then false
    when (staff).role = 'boss' then true
    when (staff).role <> 'admin' then section_name = 'service'
    else coalesce((staff).permissions, '[]'::jsonb) ? section_name
  end
  from (select public.app_user_for_token(public.request_header('x-app-token')) as staff) current_staff;
$$;

create or replace function public.require_boss(token text)
returns public.app_users
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare result public.app_users;
begin
  result := public.require_app_user(token);
  if result.role <> 'boss' then raise exception 'Permiso exclusivo del Jefe.'; end if;
  return result;
end;
$$;

-- Las funciones administrativas históricas pasan a ser exclusivas del Jefe.
create or replace function public.require_admin(token text)
returns public.app_users
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  return public.require_boss(token);
end;
$$;

create or replace function public.list_users(auth_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.require_boss(auth_token);
  return (select coalesce(jsonb_agg(public.public_user(u) order by u.full_name), '[]'::jsonb) from public.app_users u);
end;
$$;

drop function if exists public.save_user(text, uuid, text, text, text, text, boolean);

create function public.save_user(
  auth_token text,
  id uuid,
  full_name text,
  username text,
  pin text default '',
  role text default 'waiter',
  is_active boolean default true,
  permissions jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  saved public.app_users;
  current_row public.app_users;
  clean_role text := case when $6 in ('boss', 'admin', 'waiter') then $6 else 'waiter' end;
  clean_permissions jsonb := case when $6 = 'admin' and jsonb_typeof(coalesce($8, '[]'::jsonb)) = 'array' then coalesce($8, '[]'::jsonb) else '[]'::jsonb end;
begin
  perform public.require_boss($1);
  if trim($3) = '' or lower(trim($4)) !~ '^[a-z0-9._-]{3,40}$' then raise exception 'Nombre o usuario invalido.'; end if;
  if $5 <> '' and $5 !~ '^[0-9]{4,12}$' then raise exception 'El PIN debe tener entre 4 y 12 digitos.'; end if;
  if clean_role = 'admin' and jsonb_array_length(clean_permissions) = 0 then raise exception 'Selecciona al menos una seccion para el Administrador.'; end if;

  select u.* into current_row from public.app_users u where u.id = $2;
  if current_row.id is null and $5 = '' then raise exception 'El PIN es obligatorio para un usuario nuevo.'; end if;
  if current_row.role = 'boss' and (clean_role <> 'boss' or not $7)
     and not exists(select 1 from public.app_users u where u.id <> current_row.id and u.role = 'boss' and u.is_active) then
    raise exception 'No puedes desactivar o cambiar el rol del ultimo Jefe.';
  end if;

  insert into public.app_users(id, full_name, username, pin_hash, role, is_active, permissions)
  values ($2, trim($3), lower(trim($4)), crypt($5, gen_salt('bf', 10)), clean_role, $7, clean_permissions)
  on conflict on constraint app_users_pkey do update set
    full_name = excluded.full_name,
    username = excluded.username,
    role = excluded.role,
    is_active = excluded.is_active,
    permissions = excluded.permissions,
    pin_hash = case when $5 <> '' then crypt($5, gen_salt('bf', 10)) else app_users.pin_hash end
  returning * into saved;
  return public.public_user(saved);
exception when unique_violation then
  raise exception 'Ese nombre de usuario ya esta en uso.';
end;
$$;

create or replace function public.delete_user(auth_token text, user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare actor public.app_users; target public.app_users;
begin
  actor := public.require_boss(auth_token);
  select * into target from public.app_users where id = user_id;
  if target.id is null then return jsonb_build_object('deleted', false, 'reason', 'not_found'); end if;
  if target.id = actor.id then raise exception 'No puedes eliminar tu propio usuario mientras tienes la sesion abierta.'; end if;
  if target.role = 'boss' and target.is_active
     and not exists(select 1 from public.app_users u where u.id <> target.id and u.role = 'boss' and u.is_active) then
    raise exception 'No puedes eliminar el ultimo Jefe activo.';
  end if;
  delete from public.app_users where id = target.id;
  return jsonb_build_object('deleted', true, 'id', target.id, 'full_name', target.full_name);
end;
$$;

grant execute on function public.app_is_boss() to anon, authenticated;
grant execute on function public.app_can_access_section(text) to anon, authenticated;
revoke all on function public.require_boss(text) from public, anon, authenticated;
grant execute on function public.save_user(text, uuid, text, text, text, text, boolean, jsonb) to anon, authenticated;

-- Separa crear/editar de eliminar: Administrador puede operar sus secciones,
-- pero únicamente Jefe puede borrar datos.
drop policy if exists admin_business_all on public.business_settings;
drop policy if exists admin_categories_all on public.menu_categories;
drop policy if exists admin_items_all on public.menu_items;
drop policy if exists admin_tables_all on public.restaurant_tables;

create policy staff_business_insert on public.business_settings for insert to anon with check (public.app_can_access_section('brand'));
create policy staff_business_update on public.business_settings for update to anon using (public.app_can_access_section('brand')) with check (public.app_can_access_section('brand'));
create policy boss_business_delete on public.business_settings for delete to anon using (public.app_is_boss());

create policy staff_categories_insert on public.menu_categories for insert to anon with check (public.app_can_access_section('menu') or public.app_can_access_section('inventory'));
create policy staff_categories_update on public.menu_categories for update to anon using (public.app_can_access_section('menu') or public.app_can_access_section('inventory')) with check (public.app_can_access_section('menu') or public.app_can_access_section('inventory'));
create policy boss_categories_delete on public.menu_categories for delete to anon using (public.app_is_boss());

create policy staff_items_insert on public.menu_items for insert to anon with check (public.app_can_access_section('menu') or public.app_can_access_section('inventory'));
create policy staff_items_update on public.menu_items for update to anon using (public.app_can_access_section('menu') or public.app_can_access_section('inventory')) with check (public.app_can_access_section('menu') or public.app_can_access_section('inventory'));
create policy boss_menu_items_delete on public.menu_items for delete to anon using (public.app_is_boss());

create policy staff_tables_insert on public.restaurant_tables for insert to anon with check (public.app_can_access_section('menu'));
create policy staff_tables_update on public.restaurant_tables for update to anon using (public.app_can_access_section('menu')) with check (public.app_can_access_section('menu'));
create policy boss_tables_delete on public.restaurant_tables for delete to anon using (public.app_is_boss());

drop policy if exists staff_items_delete on public.session_items;
drop policy if exists staff_requests_delete on public.service_requests;
drop policy if exists staff_sessions_delete on public.table_sessions;
create policy boss_session_items_delete on public.session_items for delete to anon using (public.app_is_boss());
create policy boss_service_requests_delete on public.service_requests for delete to anon using (public.app_is_boss());
create policy boss_table_sessions_delete on public.table_sessions for delete to anon using (public.app_is_boss());

create or replace function public.enforce_staff_mutation_limits()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare actor public.app_users;
begin
  actor := public.app_user_for_token(public.request_header('x-app-token'));
  if actor.id is null then return new; end if;
  if tg_table_name = 'session_items' and new.status = 'cancelled' and old.status is distinct from new.status and actor.role <> 'boss' then
    raise exception 'Solo el Jefe puede eliminar consumos.';
  end if;
  if tg_table_name = 'table_sessions' and actor.role = 'waiter' and new.status is distinct from old.status then
    raise exception 'El Mesero solo puede agregar o editar consumos.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_session_item_role_limits on public.session_items;
create trigger enforce_session_item_role_limits before update on public.session_items
for each row execute function public.enforce_staff_mutation_limits();

drop trigger if exists enforce_table_session_role_limits on public.table_sessions;
create trigger enforce_table_session_role_limits before update on public.table_sessions
for each row execute function public.enforce_staff_mutation_limits();


create or replace function public.bootstrap_first_admin(full_name text, username text, pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  saved public.app_users;
  normalized_username text := lower(trim(username));
begin
  perform pg_advisory_xact_lock(hashtext('app_users_initial_admin'));
  if exists(select 1 from public.app_users) then
    raise exception 'La configuración inicial ya fue completada.';
  end if;
  if trim(full_name) = '' or normalized_username !~ '^[a-z0-9._-]{3,40}$' then
    raise exception 'Nombre o usuario inválido.';
  end if;
  if coalesce(pin, '') !~ '^[0-9]{4,12}$' then
    raise exception 'El PIN debe tener entre 4 y 12 dígitos.';
  end if;
  insert into public.app_users(full_name, username, pin_hash, role, is_active, permissions)
  values (trim(full_name), normalized_username, crypt(pin, gen_salt('bf', 10)), 'boss', true, '[]'::jsonb)
  returning * into saved;
  return public.public_user(saved);
end;
$$;

grant execute on function public.bootstrap_first_admin(text, text, text) to anon, authenticated;

commit;
