-- Instalador completo para una nueva empresa.
-- Ejecutar una sola vez en el SQL Editor de un proyecto Supabase nuevo.
-- No incluye usuarios, ventas, mesas ni datos de otro negocio.




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."acknowledge_service_requests"("auth_token" "text", "ids" "uuid"[], "acknowledged_at" timestamp with time zone DEFAULT "now"(), "message" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare staff_user public.app_users;
begin
  staff_user := public.require_app_user(auth_token);
  if coalesce(array_length(ids, 1), 0) = 0 or array_length(ids, 1) > 50 then raise exception 'Solicitudes invalidas.'; end if;
  return (
    with changed as (
      update public.service_requests set
        status = 'acknowledged', acknowledged_by_user_id = staff_user.id,
        acknowledged_at = acknowledge_service_requests.acknowledged_at,
        message = case when acknowledge_service_requests.message is null then service_requests.message else left(acknowledge_service_requests.message, 1000) end
      where id = any(ids) returning *
    ) select coalesce(jsonb_agg(to_jsonb(changed)), '[]'::jsonb) from changed
  );
end;
$$;


ALTER FUNCTION "public"."acknowledge_service_requests"("auth_token" "text", "ids" "uuid"[], "acknowledged_at" timestamp with time zone, "message" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
  select (public.app_user_for_token(public.request_header('x-app-token'))).role = 'admin';
$$;


ALTER FUNCTION "public"."app_is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_is_authenticated"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
  select (public.app_user_for_token(public.request_header('x-app-token'))).id is not null;
$$;


ALTER FUNCTION "public"."app_is_authenticated"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."app_users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "full_name" "text" NOT NULL,
    "username" "text" NOT NULL,
    "pin_hash" "text" NOT NULL,
    "role" "text" DEFAULT 'waiter'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "last_login_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "app_users_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'waiter'::"text"]))),
    CONSTRAINT "app_users_username_check" CHECK (("username" ~ '^[a-z0-9._-]{3,40}$'::"text"))
);


ALTER TABLE "public"."app_users" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_user_for_token"("token" "text") RETURNS "public"."app_users"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
  select u
  from public.auth_sessions s
  join public.app_users u on u.id = s.user_id
  where s.token_hash = encode(digest(token, 'sha256'), 'hex')
    and s.expires_at > now()
    and u.is_active
  limit 1;
$$;


ALTER FUNCTION "public"."app_user_for_token"("token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."broadcast_table_refresh"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'realtime'
    AS $$
declare affected_table uuid;
begin
  affected_table := case when tg_op = 'DELETE' then old.table_id else new.table_id end;
  perform realtime.send(jsonb_build_object('table_id', affected_table), 'refresh', 'admin', false);
  if affected_table is not null then
    perform realtime.send(jsonb_build_object('table_id', affected_table), 'refresh', 'table:' || affected_table::text, false);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."broadcast_table_refresh"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."chat_client_can_access"("p_table_id" "uuid", "p_session_id" "uuid", "p_table_access_code" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.valid_table_access(p_table_id, p_table_access_code) and exists (
    select 1
    from public.restaurant_tables rt
    join public.table_sessions ts on ts.table_id = rt.id
    where rt.id = p_table_id
      and ts.id = p_session_id
      and ts.status = 'open'
  );
$$;


ALTER FUNCTION "public"."chat_client_can_access"("p_table_id" "uuid", "p_session_id" "uuid", "p_table_access_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."chat_staff_user"("p_auth_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  staff jsonb;
begin
  if coalesce(p_auth_token, '') = '' then return null; end if;
  select to_jsonb(public.get_current_user(p_auth_token)) into staff;
  if coalesce((staff->>'is_active')::boolean, false) is not true then return null; end if;
  return staff;
exception when others then
  return null;
end;
$$;


ALTER FUNCTION "public"."chat_staff_user"("p_auth_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_old_data"("auth_token" "text", "retention_days" integer DEFAULT 90) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare removed integer;
begin
  perform public.require_admin(auth_token);
  if retention_days < 7 then raise exception 'La retencion minima es de 7 dias.'; end if;
  delete from public.table_sessions where status in ('closed','cancelled') and closed_at < now() - make_interval(days => retention_days);
  get diagnostics removed = row_count;
  delete from public.auth_sessions where expires_at <= now();
  return removed;
end;
$$;


ALTER FUNCTION "public"."cleanup_old_data"("auth_token" "text", "retention_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."close_chat_session"("p_session_id" "uuid", "p_auth_token" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  staff jsonb;
  deleted_count integer;
begin
  staff := public.chat_staff_user(p_auth_token);
  if staff is null then raise exception 'Usuario administrativo no autorizado'; end if;
  delete from public.chat_messages cm where cm.session_id = p_session_id;
  get diagnostics deleted_count = row_count;
  return jsonb_build_object('closed', true, 'deleted', deleted_count);
end;
$$;


ALTER FUNCTION "public"."close_chat_session"("p_session_id" "uuid", "p_auth_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_service_request"("request_id" "uuid", "table_id" "uuid", "table_access_code" "text", "request_type" "text", "message" "text" DEFAULT ''::"text", "session_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare current_session public.table_sessions; saved public.service_requests; was_duplicate boolean := false;
begin
  if not public.valid_table_access(table_id, table_access_code) then raise exception 'QR de mesa invalido.'; end if;
  if request_type not in ('waiter','bill','other') then raise exception 'Tipo de solicitud no permitido.'; end if;
  select * into saved from public.service_requests r where r.id = request_id;
  if saved.id is not null then return jsonb_build_object('request', to_jsonb(saved), 'duplicate', true); end if;
  select * into current_session from public.table_sessions s
    where s.table_id = create_service_request.table_id and s.status = 'open' limit 1;
  if current_session.id is null then
    insert into public.table_sessions(table_id) values (create_service_request.table_id)
    on conflict (table_id) where status = 'open' do update set table_id = excluded.table_id
    returning * into current_session;
  end if;
  insert into public.service_requests(id, table_id, session_id, request_type, message)
  values (request_id, table_id, current_session.id, request_type, left(coalesce(message,''), 1000))
  returning * into saved;
  return jsonb_build_object('request', to_jsonb(saved), 'duplicate', was_duplicate);
end;
$$;


ALTER FUNCTION "public"."create_service_request"("request_id" "uuid", "table_id" "uuid", "table_access_code" "text", "request_type" "text", "message" "text", "session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_service_requests_batch"("requests" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare event jsonb; result jsonb; results jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(requests) <> 'array' or jsonb_array_length(requests) > 50 then raise exception 'Lote de solicitudes invalido.'; end if;
  for event in select value from jsonb_array_elements(requests) loop
    result := public.create_service_request(
      (event->>'request_id')::uuid, (event->>'table_id')::uuid, event->>'table_access_code',
      event->>'request_type', coalesce(event->>'message',''), nullif(event->>'session_id','')::uuid
    );
    results := results || jsonb_build_array(result);
  end loop;
  return jsonb_build_object('results', results);
end;
$$;


ALTER FUNCTION "public"."create_service_requests_batch"("requests" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_user"("auth_token" "text", "user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  actor public.app_users;
  target public.app_users;
begin
  actor := public.require_admin(auth_token);
  select * into target from public.app_users where id = user_id;
  if target.id is null then return jsonb_build_object('deleted', false, 'reason', 'not_found'); end if;
  if target.id = actor.id then raise exception 'No puedes eliminar tu propio usuario mientras tienes la sesion abierta.'; end if;
  if target.role = 'admin' and target.is_active
     and not exists(select 1 from public.app_users u where u.id <> target.id and u.role = 'admin' and u.is_active) then
    raise exception 'No puedes eliminar el ultimo administrador activo.';
  end if;
  delete from public.app_users where id = target.id;
  return jsonb_build_object('deleted', true, 'id', target.id, 'full_name', target.full_name);
end;
$$;


ALTER FUNCTION "public"."delete_user"("auth_token" "text", "user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_snapshot"("auth_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform public.require_app_user(auth_token);
  return jsonb_build_object(
    'requests', (
      select coalesce(jsonb_agg(
        to_jsonb(r) || jsonb_build_object(
          'restaurant_tables', jsonb_build_object('table_number', t.table_number, 'table_name', t.table_name),
          'acknowledged_by_user', case when u.id is null then null else public.public_user(u) end
        ) order by r.created_at desc), '[]'::jsonb)
      from public.service_requests r
      join public.restaurant_tables t on t.id = r.table_id
      left join public.app_users u on u.id = r.acknowledged_by_user_id
      where r.status in ('pending', 'acknowledged')
    ),
    'sessions', (
      select coalesce(jsonb_agg(
        to_jsonb(s) || jsonb_build_object(
          'restaurant_tables', case when t.id is null then null else jsonb_build_object('table_number', t.table_number, 'table_name', t.table_name) end,
          'assigned_waiter', case when u.id is null then null else public.public_user(u) end,
          'session_items', (
            select coalesce(jsonb_agg(
              to_jsonb(i) || jsonb_build_object('created_by_user', case when cu.id is null then null else public.public_user(cu) end)
              order by i.created_at
            ), '[]'::jsonb)
            from public.session_items i
            left join public.app_users cu on cu.id = i.created_by_user_id
            where i.session_id = s.id
          )
        ) order by s.opened_at desc), '[]'::jsonb)
      from public.table_sessions s
      left join public.restaurant_tables t on t.id = s.table_id
      left join public.app_users u on u.id = s.assigned_waiter_id
      where s.status = 'open'
    )
  );
end;
$$;


ALTER FUNCTION "public"."get_admin_snapshot"("auth_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_bootstrap_data"("auth_token" "text" DEFAULT ''::"text", "table_access_code" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare tables_json jsonb;
begin
  if (public.app_user_for_token(auth_token)).id is not null then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.table_number), '[]'::jsonb) into tables_json
    from public.restaurant_tables t;
  elsif table_access_code <> '' then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.table_number), '[]'::jsonb) into tables_json
    from public.restaurant_tables t where t.qr_code = table_access_code and t.is_active;
  else
    select coalesce(jsonb_agg(to_jsonb(t) order by t.table_number), '[]'::jsonb) into tables_json
    from public.restaurant_tables t where t.is_active;
  end if;
  return jsonb_build_object(
    'business', (select to_jsonb(b) from public.business_settings b where b.is_primary limit 1),
    'tables', tables_json,
    'categories', (select coalesce(jsonb_agg(to_jsonb(c) order by c.sort_order), '[]'::jsonb) from public.menu_categories c where c.is_active),
    'items', (select coalesce(jsonb_agg(to_jsonb(i) || jsonb_build_object('menu_categories', jsonb_build_object('name', c.name)) order by i.sort_order), '[]'::jsonb)
              from public.menu_items i left join public.menu_categories c on c.id = i.category_id where i.is_available)
  );
end;
$$;


ALTER FUNCTION "public"."get_bootstrap_data"("auth_token" "text", "table_access_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_table_zones"("auth_token" "text", "outdoor_table_ids" "uuid"[] DEFAULT ARRAY[]::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
begin
  perform public.require_admin(auth_token);
  update public.restaurant_tables
  set is_outdoor = (id = any(coalesce(outdoor_table_ids, array[]::uuid[]))),
      updated_at = now();
  return jsonb_build_object(
    'ok', true,
    'tables', (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'is_outdoor', t.is_outdoor) order by t.table_number), '[]'::jsonb)
      from public.restaurant_tables t
    )
  );
end;
$$;


ALTER FUNCTION "public"."save_table_zones"("auth_token" "text", "outdoor_table_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_client_snapshot"("session_id" "uuid", "table_id" "uuid", "table_access_code" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.valid_table_access(table_id, table_access_code) then raise exception 'QR de mesa invalido.'; end if;
  if not exists(select 1 from public.table_sessions s where s.id = session_id and s.table_id = get_client_snapshot.table_id) then
    return jsonb_build_object('sessionItems', '[]'::jsonb, 'requests', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'sessionItems', (select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at desc), '[]'::jsonb) from public.session_items i where i.session_id = get_client_snapshot.session_id and i.status <> 'cancelled'),
    'requests', (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb) from public.service_requests r where r.session_id = get_client_snapshot.session_id)
  );
end;
$$;


ALTER FUNCTION "public"."get_client_snapshot"("session_id" "uuid", "table_id" "uuid", "table_access_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_client_table_state"("table_id" "uuid", "table_access_code" "text", "ensure_session" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare current_session public.table_sessions; items_json jsonb; requests_json jsonb;
begin
  if not public.valid_table_access(table_id, table_access_code) then raise exception 'QR de mesa invalido.'; end if;
  select * into current_session from public.table_sessions s where s.table_id = get_client_table_state.table_id and s.status = 'open' limit 1;
  if current_session.id is null and ensure_session then
    insert into public.table_sessions(table_id) values (get_client_table_state.table_id)
    on conflict (table_id) where status = 'open' do update set table_id = excluded.table_id
    returning * into current_session;
  end if;
  if current_session.id is null then
    return jsonb_build_object('session', null, 'sessionItems', '[]'::jsonb, 'requests', '[]'::jsonb, 'hasAccount', false, 'subtotal', 0);
  end if;
  select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at desc), '[]'::jsonb) into items_json
    from public.session_items i where i.session_id = current_session.id and i.status <> 'cancelled';
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb) into requests_json
    from public.service_requests r where r.session_id = current_session.id;
  return jsonb_build_object(
    'session', to_jsonb(current_session), 'sessionItems', items_json, 'requests', requests_json,
    'hasAccount', jsonb_array_length(items_json) > 0,
    'subtotal', coalesce((select sum(i.quantity * i.unit_price) from public.session_items i where i.session_id = current_session.id and i.status <> 'cancelled'), 0)
  );
end;
$$;


ALTER FUNCTION "public"."get_client_table_state"("table_id" "uuid", "table_access_code" "text", "ensure_session" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_current_user"("auth_token" "text") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
  select public.public_user(public.require_app_user(auth_token));
$$;


ALTER FUNCTION "public"."get_current_user"("auth_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_chat_messages"("p_session_id" "uuid", "p_table_id" "uuid" DEFAULT NULL::"uuid", "p_table_access_code" "text" DEFAULT ''::"text", "p_auth_token" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  staff jsonb;
  result jsonb;
begin
  staff := public.chat_staff_user(p_auth_token);
  if staff is null and not public.chat_client_can_access(p_table_id, p_session_id, p_table_access_code) then
    raise exception 'Acceso al chat no autorizado';
  end if;
  select jsonb_build_object('messages', coalesce(jsonb_agg(to_jsonb(cm) order by cm.created_at), '[]'::jsonb))
    into result
  from public.chat_messages cm
  where cm.session_id = p_session_id;
  return result;
end;
$$;


ALTER FUNCTION "public"."list_chat_messages"("p_session_id" "uuid", "p_table_id" "uuid", "p_table_access_code" "text", "p_auth_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_users"("auth_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
begin
  perform public.require_admin(auth_token);
  return (select coalesce(jsonb_agg(public.public_user(u) order by u.full_name), '[]'::jsonb) from public.app_users u);
end;
$$;


ALTER FUNCTION "public"."list_users"("auth_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."login"("username" "text", "pin" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $_$
declare
  normalized text := lower(trim($1));
  found_user public.app_users;
  attempt public.login_attempts;
  raw_token text;
  expiry timestamptz := now() + interval '12 hours';
begin
  select a.* into attempt from public.login_attempts a where a.username = normalized;
  if attempt.blocked_until > now() then return null; end if;

  select u.* into found_user
  from public.app_users u
  where u.username = normalized and u.is_active
  limit 1;

  if found_user.id is null or crypt($2, found_user.pin_hash) <> found_user.pin_hash then
    insert into public.login_attempts(username, attempts, blocked_until)
    values (normalized, 1, null)
    on conflict on constraint login_attempts_pkey do update set
      attempts = case when login_attempts.blocked_until <= now() then 1 else login_attempts.attempts + 1 end,
      blocked_until = case when login_attempts.attempts + 1 >= 8 then now() + interval '5 minutes' else login_attempts.blocked_until end,
      updated_at = now();
    return null;
  end if;

  delete from public.login_attempts a where a.username = normalized;
  delete from public.auth_sessions s where s.expires_at <= now();
  raw_token := encode(gen_random_bytes(32), 'hex');
  insert into public.auth_sessions(user_id, token_hash, expires_at)
  values (found_user.id, encode(digest(raw_token, 'sha256'), 'hex'), expiry);
  update public.app_users u set last_login_at = now() where u.id = found_user.id returning u.* into found_user;
  return jsonb_build_object('token', raw_token, 'expires_at', expiry, 'user', public.public_user(found_user));
end;
$_$;


ALTER FUNCTION "public"."login"("username" "text", "pin" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."logout"("auth_token" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
begin
  delete from public.auth_sessions where token_hash = encode(digest(auth_token, 'sha256'), 'hex');
  return true;
end;
$$;


ALTER FUNCTION "public"."logout"("auth_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_client_item"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare catalog_item public.menu_items;
begin
  if not public.app_is_authenticated() then
    new.status := 'pending';
    new.created_by_user_id := null;
    new.updated_by_user_id := null;
    new.quantity := greatest(1, least(100, new.quantity));
    new.notes := left(coalesce(new.notes, ''), 500);
    if new.menu_item_id is not null then
      select * into catalog_item from public.menu_items i where i.id = new.menu_item_id and i.is_available;
      if catalog_item.id is null then raise exception 'Producto no disponible.'; end if;
      new.item_name := catalog_item.name;
      new.unit_price := catalog_item.price;
    else
      new.item_name := left(coalesce(new.item_name, 'Producto'), 160);
      new.unit_price := greatest(0, least(10000000, new.unit_price));
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."normalize_client_item"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_client_session"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.app_is_authenticated() then
    new.status := 'open';
    new.payer_name := null;
    new.assigned_waiter_id := null;
    new.closed_at := null;
    new.subtotal := 0; new.discount := 0; new.tax := 0; new.service_fee := 0; new.total := 0;
    new.payment_method := null; new.notes := null;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."normalize_client_session"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_user"("user_value" "public"."app_users") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select jsonb_build_object(
    'id', user_value.id, 'full_name', user_value.full_name, 'username', user_value.username,
    'role', user_value.role, 'is_active', user_value.is_active,
    'last_login_at', user_value.last_login_at, 'created_at', user_value.created_at,
    'updated_at', user_value.updated_at
  );
$$;


ALTER FUNCTION "public"."public_user"("user_value" "public"."app_users") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."request_header"("header_name" "text") RETURNS "text"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> lower(header_name), '');
$$;


ALTER FUNCTION "public"."request_header"("header_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."require_admin"("token" "text") RETURNS "public"."app_users"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare result public.app_users;
begin
  result := public.require_app_user(token);
  if result.role <> 'admin' then raise exception 'Permiso exclusivo de administrador.'; end if;
  return result;
end;
$$;


ALTER FUNCTION "public"."require_admin"("token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."require_app_user"("token" "text") RETURNS "public"."app_users"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare result public.app_users;
begin
  result := public.app_user_for_token(token);
  if result.id is null then raise exception 'Sesion vencida o autenticacion requerida.'; end if;
  return result;
end;
$$;


ALTER FUNCTION "public"."require_app_user"("token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_bill"("request_id" "uuid", "table_id" "uuid", "table_access_code" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare saved public.service_requests;
begin
  if not public.valid_table_access(table_id, table_access_code) then raise exception 'QR de mesa invalido.'; end if;
  update public.service_requests set status = 'resolved', resolved_at = now()
  where id = request_id and service_requests.table_id = resolve_bill.table_id and request_type = 'bill'
  returning * into saved;
  if saved.id is null then raise exception 'Cuenta no encontrada para esta mesa.'; end if;
  return to_jsonb(saved);
end;
$$;


ALTER FUNCTION "public"."resolve_bill"("request_id" "uuid", "table_id" "uuid", "table_access_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_user"("auth_token" "text", "id" "uuid", "full_name" "text", "username" "text", "pin" "text" DEFAULT ''::"text", "role" "text" DEFAULT 'waiter'::"text", "is_active" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $_$
declare
  saved public.app_users;
  current_row public.app_users;
begin
  perform public.require_admin($1);

  if trim($3) = '' or lower(trim($4)) !~ '^[a-z0-9._-]{3,40}$' then
    raise exception 'Nombre o usuario invalido.';
  end if;
  if $5 <> '' and $5 !~ '^[0-9]{4,12}$' then
    raise exception 'El PIN debe tener entre 4 y 12 digitos.';
  end if;

  select u.* into current_row
  from public.app_users u
  where u.id = $2;

  if current_row.id is null and $5 = '' then
    raise exception 'El PIN es obligatorio para un usuario nuevo.';
  end if;
  if current_row.role = 'admin' and ($6 <> 'admin' or not $7)
     and not exists (
       select 1 from public.app_users u
       where u.id <> current_row.id and u.role = 'admin' and u.is_active
     ) then
    raise exception 'No puedes desactivar o cambiar el rol del ultimo administrador.';
  end if;

  insert into public.app_users(id, full_name, username, pin_hash, role, is_active)
  values (
    $2,
    trim($3),
    lower(trim($4)),
    crypt($5, gen_salt('bf', 10)),
    case when $6 = 'admin' then 'admin' else 'waiter' end,
    $7
  )
  on conflict on constraint app_users_pkey do update set
    full_name = excluded.full_name,
    username = excluded.username,
    role = excluded.role,
    is_active = excluded.is_active,
    pin_hash = case when $5 <> '' then crypt($5, gen_salt('bf', 10)) else app_users.pin_hash end
  returning * into saved;

  return public.public_user(saved);
exception
  when unique_violation then
    raise exception 'Ese nombre de usuario ya esta en uso.';
end;
$_$;


ALTER FUNCTION "public"."save_user"("auth_token" "text", "id" "uuid", "full_name" "text", "username" "text", "pin" "text", "role" "text", "is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."send_chat_message"("p_message_id" "uuid", "p_session_id" "uuid", "p_table_id" "uuid" DEFAULT NULL::"uuid", "p_sender_type" "text" DEFAULT 'client'::"text", "p_body" "text" DEFAULT ''::"text", "p_table_access_code" "text" DEFAULT ''::"text", "p_auth_token" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  staff jsonb;
  saved public.chat_messages;
  effective_sender text;
begin
  staff := public.chat_staff_user(p_auth_token);
  effective_sender := lower(coalesce(p_sender_type, 'client'));
  if effective_sender in ('staff', 'system') then
    if staff is null then raise exception 'Usuario administrativo no autorizado'; end if;
  elsif effective_sender = 'client' then
    if not public.chat_client_can_access(p_table_id, p_session_id, p_table_access_code) then raise exception 'Mesa no autorizada'; end if;
  else
    raise exception 'Remitente invalido';
  end if;
  insert into public.chat_messages(id, session_id, table_id, sender_type, sender_user_id, sender_name, body)
  values (
    coalesce(p_message_id, gen_random_uuid()), p_session_id, p_table_id, effective_sender,
    case when staff is null then null else nullif(staff->>'id', '')::uuid end,
    case when effective_sender = 'client' then 'Cliente' when effective_sender = 'system' then 'Sistema' else coalesce(staff->>'full_name', staff->>'username', 'Equipo') end,
    left(trim(p_body), 600)
  )
  on conflict (id) do update set body = excluded.body
  returning * into saved;
  return jsonb_build_object('message', to_jsonb(saved));
end;
$$;


ALTER FUNCTION "public"."send_chat_message"("p_message_id" "uuid", "p_session_id" "uuid", "p_table_id" "uuid", "p_sender_type" "text", "p_body" "text", "p_table_access_code" "text", "p_auth_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."valid_table_access"("table_value" "uuid", "code_value" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists(
    select 1 from public.restaurant_tables t
    where t.id = table_value and t.qr_code = code_value and t.is_active
  );
$$;


ALTER FUNCTION "public"."valid_table_access"("table_value" "uuid", "code_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."valid_table_header"("table_value" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select table_value::text = public.request_header('x-table-id')
     and public.valid_table_access(table_value, public.request_header('x-table-code'));
$$;


ALTER FUNCTION "public"."valid_table_header"("table_value" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."auth_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."auth_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."business_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "is_primary" boolean DEFAULT true NOT NULL,
    "business_name" "text" DEFAULT 'Tu restaurante'::"text" NOT NULL,
    "subtitle" "text" DEFAULT 'Servicio a la mesa rapido y claro'::"text",
    "logo_url" "text",
    "cover_url" "text",
    "accent_color" "text" DEFAULT '#f05a28'::"text" NOT NULL,
    "currency" "text" DEFAULT 'COP'::"text" NOT NULL,
    "tax_rate" numeric(8,4) DEFAULT 0 NOT NULL,
    "service_fee" numeric(8,4) DEFAULT 0 NOT NULL,
    "tips_enabled" boolean DEFAULT false NOT NULL,
    "tip_percentage" integer DEFAULT 10 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "business_settings_tip_percentage_check" CHECK (("tip_percentage" >= 1) AND ("tip_percentage" <= 100))
);


ALTER TABLE "public"."business_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "table_id" "uuid",
    "sender_type" "text" NOT NULL,
    "sender_user_id" "uuid",
    "sender_name" "text" DEFAULT ''::"text" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chat_messages_body_check" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 600))),
    CONSTRAINT "chat_messages_sender_type_check" CHECK (("sender_type" = ANY (ARRAY['client'::"text", 'staff'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."chat_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."login_attempts" (
    "username" "text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "blocked_until" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."login_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."menu_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."menu_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."menu_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "price" numeric(12,2) DEFAULT 0 NOT NULL,
    "image_url" "text",
    "is_available" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "menu_items_price_check" CHECK (("price" >= (0)::numeric))
);


ALTER TABLE "public"."menu_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."restaurant_tables" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "table_number" integer NOT NULL,
    "table_name" "text",
    "qr_code" "text" NOT NULL,
    "qr_image_url" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "is_outdoor" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "restaurant_tables_table_number_check" CHECK (("table_number" > 0))
);


ALTER TABLE "public"."restaurant_tables" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."service_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "table_id" "uuid" NOT NULL,
    "session_id" "uuid" NOT NULL,
    "request_type" "text" DEFAULT 'waiter'::"text" NOT NULL,
    "message" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "acknowledged_by_user_id" "uuid",
    "acknowledged_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "service_requests_message_check" CHECK (("char_length"(COALESCE("message", ''::"text")) <= 1000)),
    CONSTRAINT "service_requests_request_type_check" CHECK (("request_type" = ANY (ARRAY['waiter'::"text", 'bill'::"text", 'other'::"text"]))),
    CONSTRAINT "service_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'acknowledged'::"text", 'resolved'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."service_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."session_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "table_id" "uuid",
    "menu_item_id" "uuid",
    "item_name" "text" NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "unit_price" numeric(12,2) DEFAULT 0 NOT NULL,
    "notes" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "session_items_item_name_check" CHECK (("char_length"("item_name") <= 160)),
    CONSTRAINT "session_items_notes_check" CHECK (("char_length"(COALESCE("notes", ''::"text")) <= 500)),
    CONSTRAINT "session_items_quantity_check" CHECK ((("quantity" >= 1) AND ("quantity" <= 100))),
    CONSTRAINT "session_items_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'served'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "session_items_unit_price_check" CHECK ((("unit_price" >= (0)::numeric) AND ("unit_price" <= (10000000)::numeric)))
);


ALTER TABLE "public"."session_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."table_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "table_id" "uuid",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "payer_name" "text",
    "assigned_waiter_id" "uuid",
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "subtotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "discount" numeric(12,2) DEFAULT 0 NOT NULL,
    "tax" numeric(12,2) DEFAULT 0 NOT NULL,
    "service_fee" numeric(12,2) DEFAULT 0 NOT NULL,
    "total" numeric(12,2) DEFAULT 0 NOT NULL,
    "payment_method" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sale_channel" "text" DEFAULT 'table'::"text" NOT NULL,
    CONSTRAINT "table_sessions_sale_channel_check" CHECK (("sale_channel" = ANY (ARRAY['table'::"text", 'walk_in'::"text"]))),
    CONSTRAINT "table_sessions_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."table_sessions" OWNER TO "postgres";


ALTER TABLE ONLY "public"."app_users"
    ADD CONSTRAINT "app_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_users"
    ADD CONSTRAINT "app_users_username_key" UNIQUE ("username");



ALTER TABLE ONLY "public"."auth_sessions"
    ADD CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."auth_sessions"
    ADD CONSTRAINT "auth_sessions_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."business_settings"
    ADD CONSTRAINT "business_settings_is_primary_key" UNIQUE ("is_primary");



ALTER TABLE ONLY "public"."business_settings"
    ADD CONSTRAINT "business_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."login_attempts"
    ADD CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("username");



ALTER TABLE ONLY "public"."menu_categories"
    ADD CONSTRAINT "menu_categories_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."menu_categories"
    ADD CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."restaurant_tables"
    ADD CONSTRAINT "restaurant_tables_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."restaurant_tables"
    ADD CONSTRAINT "restaurant_tables_qr_code_key" UNIQUE ("qr_code");



ALTER TABLE ONLY "public"."restaurant_tables"
    ADD CONSTRAINT "restaurant_tables_table_number_key" UNIQUE ("table_number");



ALTER TABLE ONLY "public"."service_requests"
    ADD CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."session_items"
    ADD CONSTRAINT "session_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."table_sessions"
    ADD CONSTRAINT "table_sessions_pkey" PRIMARY KEY ("id");



CREATE INDEX "chat_messages_session_created_idx" ON "public"."chat_messages" USING "btree" ("session_id", "created_at");



CREATE INDEX "idx_auth_token" ON "public"."auth_sessions" USING "btree" ("token_hash", "expires_at");



CREATE INDEX "idx_items_session" ON "public"."session_items" USING "btree" ("session_id", "created_at" DESC);



CREATE INDEX "idx_requests_session" ON "public"."service_requests" USING "btree" ("session_id", "created_at" DESC);



CREATE INDEX "idx_requests_status" ON "public"."service_requests" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_sessions_table_status" ON "public"."table_sessions" USING "btree" ("table_id", "status");



CREATE UNIQUE INDEX "one_open_session_per_table" ON "public"."table_sessions" USING "btree" ("table_id") WHERE ("status" = 'open'::"text");



CREATE OR REPLACE TRIGGER "broadcast_items" AFTER INSERT OR DELETE OR UPDATE ON "public"."session_items" FOR EACH ROW EXECUTE FUNCTION "public"."broadcast_table_refresh"();



CREATE OR REPLACE TRIGGER "broadcast_requests" AFTER INSERT OR DELETE OR UPDATE ON "public"."service_requests" FOR EACH ROW EXECUTE FUNCTION "public"."broadcast_table_refresh"();



CREATE OR REPLACE TRIGGER "broadcast_sessions" AFTER INSERT OR DELETE OR UPDATE ON "public"."table_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."broadcast_table_refresh"();



CREATE OR REPLACE TRIGGER "normalize_client_item" BEFORE INSERT ON "public"."session_items" FOR EACH ROW EXECUTE FUNCTION "public"."normalize_client_item"();



CREATE OR REPLACE TRIGGER "normalize_client_session" BEFORE INSERT ON "public"."table_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."normalize_client_session"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."app_users" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."auth_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."business_settings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."login_attempts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."menu_categories" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."menu_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."restaurant_tables" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."service_requests" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."session_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."table_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."auth_sessions"
    ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."table_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."menu_categories"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."service_requests"
    ADD CONSTRAINT "service_requests_acknowledged_by_user_id_fkey" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."service_requests"
    ADD CONSTRAINT "service_requests_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."table_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."service_requests"
    ADD CONSTRAINT "service_requests_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."session_items"
    ADD CONSTRAINT "session_items_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."session_items"
    ADD CONSTRAINT "session_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."session_items"
    ADD CONSTRAINT "session_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."table_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."session_items"
    ADD CONSTRAINT "session_items_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."session_items"
    ADD CONSTRAINT "session_items_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."table_sessions"
    ADD CONSTRAINT "table_sessions_assigned_waiter_id_fkey" FOREIGN KEY ("assigned_waiter_id") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."table_sessions"
    ADD CONSTRAINT "table_sessions_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE CASCADE;



CREATE POLICY "admin_business_all" ON "public"."business_settings" TO "anon" USING ("public"."app_is_admin"()) WITH CHECK ("public"."app_is_admin"());



CREATE POLICY "admin_categories_all" ON "public"."menu_categories" TO "anon" USING ("public"."app_is_admin"()) WITH CHECK ("public"."app_is_admin"());



CREATE POLICY "admin_items_all" ON "public"."menu_items" TO "anon" USING ("public"."app_is_admin"()) WITH CHECK ("public"."app_is_admin"());



CREATE POLICY "admin_tables_all" ON "public"."restaurant_tables" TO "anon" USING ("public"."app_is_admin"()) WITH CHECK ("public"."app_is_admin"());



ALTER TABLE "public"."app_users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."auth_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."business_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chat_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."login_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."menu_categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."menu_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public_business_read" ON "public"."business_settings" FOR SELECT TO "anon" USING (true);



CREATE POLICY "public_categories_read" ON "public"."menu_categories" FOR SELECT TO "anon" USING (("is_active" OR "public"."app_is_authenticated"()));



CREATE POLICY "public_items_read" ON "public"."menu_items" FOR SELECT TO "anon" USING (("is_available" OR "public"."app_is_authenticated"()));



ALTER TABLE "public"."restaurant_tables" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scoped_items_insert" ON "public"."session_items" FOR INSERT TO "anon" WITH CHECK (("public"."app_is_authenticated"() OR ("public"."valid_table_header"("table_id") AND (EXISTS ( SELECT 1
   FROM "public"."table_sessions" "s"
  WHERE (("s"."id" = "session_items"."session_id") AND ("s"."table_id" = "session_items"."table_id") AND ("s"."status" = 'open'::"text")))))));



CREATE POLICY "scoped_items_read" ON "public"."session_items" FOR SELECT TO "anon" USING (("public"."app_is_authenticated"() OR "public"."valid_table_header"("table_id")));



CREATE POLICY "scoped_requests_read" ON "public"."service_requests" FOR SELECT TO "anon" USING (("public"."app_is_authenticated"() OR "public"."valid_table_header"("table_id")));



CREATE POLICY "scoped_sessions_insert" ON "public"."table_sessions" FOR INSERT TO "anon" WITH CHECK (("public"."app_is_authenticated"() OR ("public"."valid_table_header"("table_id") AND ("status" = 'open'::"text"))));



CREATE POLICY "scoped_sessions_read" ON "public"."table_sessions" FOR SELECT TO "anon" USING (("public"."app_is_authenticated"() OR ("public"."valid_table_header"("table_id") AND ("status" = 'open'::"text"))));



CREATE POLICY "scoped_tables_read" ON "public"."restaurant_tables" FOR SELECT TO "anon" USING (("public"."app_is_authenticated"() OR "public"."valid_table_header"("id")));



ALTER TABLE "public"."service_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."session_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "staff_items_delete" ON "public"."session_items" FOR DELETE TO "anon" USING ("public"."app_is_authenticated"());



CREATE POLICY "staff_items_update" ON "public"."session_items" FOR UPDATE TO "anon" USING ("public"."app_is_authenticated"()) WITH CHECK ("public"."app_is_authenticated"());



CREATE POLICY "staff_requests_delete" ON "public"."service_requests" FOR DELETE TO "anon" USING ("public"."app_is_authenticated"());



CREATE POLICY "staff_requests_update" ON "public"."service_requests" FOR UPDATE TO "anon" USING ("public"."app_is_authenticated"()) WITH CHECK ("public"."app_is_authenticated"());



CREATE POLICY "staff_sessions_delete" ON "public"."table_sessions" FOR DELETE TO "anon" USING ("public"."app_is_authenticated"());



CREATE POLICY "staff_sessions_update" ON "public"."table_sessions" FOR UPDATE TO "anon" USING ("public"."app_is_authenticated"()) WITH CHECK ("public"."app_is_authenticated"());



ALTER TABLE "public"."table_sessions" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."acknowledge_service_requests"("auth_token" "text", "ids" "uuid"[], "acknowledged_at" timestamp with time zone, "message" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."acknowledge_service_requests"("auth_token" "text", "ids" "uuid"[], "acknowledged_at" timestamp with time zone, "message" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."acknowledge_service_requests"("auth_token" "text", "ids" "uuid"[], "acknowledged_at" timestamp with time zone, "message" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."app_is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."app_is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."app_is_authenticated"() TO "anon";
GRANT ALL ON FUNCTION "public"."app_is_authenticated"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_is_authenticated"() TO "service_role";



GRANT ALL ON TABLE "public"."app_users" TO "service_role";



REVOKE ALL ON FUNCTION "public"."app_user_for_token"("token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."app_user_for_token"("token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."app_user_for_token"("token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_user_for_token"("token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."broadcast_table_refresh"() TO "anon";
GRANT ALL ON FUNCTION "public"."broadcast_table_refresh"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."broadcast_table_refresh"() TO "service_role";



GRANT ALL ON FUNCTION "public"."chat_client_can_access"("p_table_id" "uuid", "p_session_id" "uuid", "p_table_access_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."chat_client_can_access"("p_table_id" "uuid", "p_session_id" "uuid", "p_table_access_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."chat_client_can_access"("p_table_id" "uuid", "p_session_id" "uuid", "p_table_access_code" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."chat_staff_user"("p_auth_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."chat_staff_user"("p_auth_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."chat_staff_user"("p_auth_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."cleanup_old_data"("auth_token" "text", "retention_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."cleanup_old_data"("auth_token" "text", "retention_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_old_data"("auth_token" "text", "retention_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."close_chat_session"("p_session_id" "uuid", "p_auth_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."close_chat_session"("p_session_id" "uuid", "p_auth_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."close_chat_session"("p_session_id" "uuid", "p_auth_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_service_request"("request_id" "uuid", "table_id" "uuid", "table_access_code" "text", "request_type" "text", "message" "text", "session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."create_service_request"("request_id" "uuid", "table_id" "uuid", "table_access_code" "text", "request_type" "text", "message" "text", "session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_service_request"("request_id" "uuid", "table_id" "uuid", "table_access_code" "text", "request_type" "text", "message" "text", "session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_service_requests_batch"("requests" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."create_service_requests_batch"("requests" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_service_requests_batch"("requests" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_user"("auth_token" "text", "user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_user"("auth_token" "text", "user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_user"("auth_token" "text", "user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_admin_snapshot"("auth_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_admin_snapshot"("auth_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_admin_snapshot"("auth_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_bootstrap_data"("auth_token" "text", "table_access_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_bootstrap_data"("auth_token" "text", "table_access_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_bootstrap_data"("auth_token" "text", "table_access_code" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."save_table_zones"("auth_token" "text", "outdoor_table_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."save_table_zones"("auth_token" "text", "outdoor_table_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_table_zones"("auth_token" "text", "outdoor_table_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_client_snapshot"("session_id" "uuid", "table_id" "uuid", "table_access_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_client_snapshot"("session_id" "uuid", "table_id" "uuid", "table_access_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_client_snapshot"("session_id" "uuid", "table_id" "uuid", "table_access_code" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_client_table_state"("table_id" "uuid", "table_access_code" "text", "ensure_session" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."get_client_table_state"("table_id" "uuid", "table_access_code" "text", "ensure_session" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_client_table_state"("table_id" "uuid", "table_access_code" "text", "ensure_session" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_current_user"("auth_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_current_user"("auth_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_current_user"("auth_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."list_chat_messages"("p_session_id" "uuid", "p_table_id" "uuid", "p_table_access_code" "text", "p_auth_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."list_chat_messages"("p_session_id" "uuid", "p_table_id" "uuid", "p_table_access_code" "text", "p_auth_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_chat_messages"("p_session_id" "uuid", "p_table_id" "uuid", "p_table_access_code" "text", "p_auth_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."list_users"("auth_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."list_users"("auth_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_users"("auth_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."login"("username" "text", "pin" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."login"("username" "text", "pin" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."login"("username" "text", "pin" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."logout"("auth_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."logout"("auth_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."logout"("auth_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_client_item"() TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_client_item"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_client_item"() TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_client_session"() TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_client_session"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_client_session"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."public_user"("user_value" "public"."app_users") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_user"("user_value" "public"."app_users") TO "anon";
GRANT ALL ON FUNCTION "public"."public_user"("user_value" "public"."app_users") TO "authenticated";
GRANT ALL ON FUNCTION "public"."public_user"("user_value" "public"."app_users") TO "service_role";



GRANT ALL ON FUNCTION "public"."request_header"("header_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."request_header"("header_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."request_header"("header_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."require_admin"("token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."require_admin"("token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."require_admin"("token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."require_admin"("token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."require_app_user"("token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."require_app_user"("token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."require_app_user"("token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."require_app_user"("token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_bill"("request_id" "uuid", "table_id" "uuid", "table_access_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_bill"("request_id" "uuid", "table_id" "uuid", "table_access_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_bill"("request_id" "uuid", "table_id" "uuid", "table_access_code" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."save_user"("auth_token" "text", "id" "uuid", "full_name" "text", "username" "text", "pin" "text", "role" "text", "is_active" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."save_user"("auth_token" "text", "id" "uuid", "full_name" "text", "username" "text", "pin" "text", "role" "text", "is_active" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_user"("auth_token" "text", "id" "uuid", "full_name" "text", "username" "text", "pin" "text", "role" "text", "is_active" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."send_chat_message"("p_message_id" "uuid", "p_session_id" "uuid", "p_table_id" "uuid", "p_sender_type" "text", "p_body" "text", "p_table_access_code" "text", "p_auth_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."send_chat_message"("p_message_id" "uuid", "p_session_id" "uuid", "p_table_id" "uuid", "p_sender_type" "text", "p_body" "text", "p_table_access_code" "text", "p_auth_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."send_chat_message"("p_message_id" "uuid", "p_session_id" "uuid", "p_table_id" "uuid", "p_sender_type" "text", "p_body" "text", "p_table_access_code" "text", "p_auth_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."valid_table_access"("table_value" "uuid", "code_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."valid_table_access"("table_value" "uuid", "code_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."valid_table_access"("table_value" "uuid", "code_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."valid_table_header"("table_value" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."valid_table_header"("table_value" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."valid_table_header"("table_value" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."auth_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."business_settings" TO "anon";
GRANT ALL ON TABLE "public"."business_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."business_settings" TO "service_role";



GRANT ALL ON TABLE "public"."chat_messages" TO "service_role";



GRANT ALL ON TABLE "public"."login_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."menu_categories" TO "anon";
GRANT ALL ON TABLE "public"."menu_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_categories" TO "service_role";



GRANT ALL ON TABLE "public"."menu_items" TO "anon";
GRANT ALL ON TABLE "public"."menu_items" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_items" TO "service_role";



GRANT ALL ON TABLE "public"."restaurant_tables" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_tables" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_tables" TO "service_role";



GRANT ALL ON TABLE "public"."service_requests" TO "anon";
GRANT ALL ON TABLE "public"."service_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."service_requests" TO "service_role";



GRANT ALL ON TABLE "public"."session_items" TO "anon";
GRANT ALL ON TABLE "public"."session_items" TO "authenticated";
GRANT ALL ON TABLE "public"."session_items" TO "service_role";



GRANT ALL ON TABLE "public"."table_sessions" TO "anon";
GRANT ALL ON TABLE "public"."table_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."table_sessions" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";









-- Actualizaciones operativas incluidas en la instalacion inicial.
-- Los aÃ±os Maravillosos - migracion operativa 2026-09-03
-- Archivo aditivo e idempotente. Ejecutar en el SQL Editor del proyecto actual.

begin;

alter table public.table_sessions add column if not exists sale_channel text not null default 'table';
alter table public.table_sessions alter column table_id drop not null;
alter table public.session_items alter column table_id drop not null;
alter table public.session_items add column if not exists created_by_user_id uuid;
alter table public.session_items add column if not exists updated_by_user_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'table_sessions_sale_channel_check') then
    alter table public.table_sessions add constraint table_sessions_sale_channel_check check (sale_channel in ('table', 'walk_in'));
  end if;
end $$;

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.table_sessions(id) on delete cascade,
  table_id uuid references public.restaurant_tables(id) on delete cascade,
  sender_type text not null check (sender_type in ('client', 'staff', 'system')),
  sender_user_id uuid,
  sender_name text not null default '',
  body text not null check (char_length(body) between 1 and 600),
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_session_created_idx on public.chat_messages(session_id, created_at);
alter table public.chat_messages enable row level security;
revoke all on public.chat_messages from anon, authenticated;

create or replace function public.chat_staff_user(p_auth_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  staff jsonb;
begin
  if coalesce(p_auth_token, '') = '' then return null; end if;
  select to_jsonb(public.get_current_user(p_auth_token)) into staff;
  if coalesce((staff->>'is_active')::boolean, false) is not true then return null; end if;
  return staff;
exception when others then
  return null;
end;
$$;

create or replace function public.chat_client_can_access(p_table_id uuid, p_session_id uuid, p_table_access_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.valid_table_access(p_table_id, p_table_access_code) and exists (
    select 1
    from public.restaurant_tables rt
    join public.table_sessions ts on ts.table_id = rt.id
    where rt.id = p_table_id
      and ts.id = p_session_id
      and ts.status = 'open'
  );
$$;

create or replace function public.list_chat_messages(p_session_id uuid, p_table_id uuid default null, p_table_access_code text default '', p_auth_token text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  staff jsonb;
  result jsonb;
begin
  staff := public.chat_staff_user(p_auth_token);
  if staff is null and not public.chat_client_can_access(p_table_id, p_session_id, p_table_access_code) then
    raise exception 'Acceso al chat no autorizado';
  end if;
  select jsonb_build_object('messages', coalesce(jsonb_agg(to_jsonb(cm) order by cm.created_at), '[]'::jsonb))
    into result
  from public.chat_messages cm
  where cm.session_id = p_session_id;
  return result;
end;
$$;

create or replace function public.send_chat_message(p_message_id uuid, p_session_id uuid, p_table_id uuid default null, p_sender_type text default 'client', p_body text default '', p_table_access_code text default '', p_auth_token text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  staff jsonb;
  saved public.chat_messages;
  effective_sender text;
begin
  staff := public.chat_staff_user(p_auth_token);
  effective_sender := lower(coalesce(p_sender_type, 'client'));
  if effective_sender in ('staff', 'system') then
    if staff is null then raise exception 'Usuario administrativo no autorizado'; end if;
  elsif effective_sender = 'client' then
    if not public.chat_client_can_access(p_table_id, p_session_id, p_table_access_code) then raise exception 'Mesa no autorizada'; end if;
  else
    raise exception 'Remitente invalido';
  end if;
  insert into public.chat_messages(id, session_id, table_id, sender_type, sender_user_id, sender_name, body)
  values (
    coalesce(p_message_id, gen_random_uuid()), p_session_id, p_table_id, effective_sender,
    case when staff is null then null else nullif(staff->>'id', '')::uuid end,
    case when effective_sender = 'client' then 'Cliente' when effective_sender = 'system' then 'Sistema' else coalesce(staff->>'full_name', staff->>'username', 'Equipo') end,
    left(trim(p_body), 600)
  )
  on conflict (id) do update set body = excluded.body
  returning * into saved;
  return jsonb_build_object('message', to_jsonb(saved));
end;
$$;

create or replace function public.close_chat_session(p_session_id uuid, p_auth_token text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  staff jsonb;
  deleted_count integer;
begin
  staff := public.chat_staff_user(p_auth_token);
  if staff is null then raise exception 'Usuario administrativo no autorizado'; end if;
  delete from public.chat_messages cm where cm.session_id = p_session_id;
  get diagnostics deleted_count = row_count;
  return jsonb_build_object('closed', true, 'deleted', deleted_count);
end;
$$;

grant execute on function public.list_chat_messages(uuid, uuid, text, text) to anon, authenticated;
grant execute on function public.send_chat_message(uuid, uuid, uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.close_chat_session(uuid, text) to anon, authenticated;

create or replace function public.get_admin_snapshot(auth_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_app_user(auth_token);
  return jsonb_build_object(
    'requests', (
      select coalesce(jsonb_agg(
        to_jsonb(r) || jsonb_build_object(
          'restaurant_tables', jsonb_build_object('table_number', t.table_number, 'table_name', t.table_name),
          'acknowledged_by_user', case when u.id is null then null else public.public_user(u) end
        ) order by r.created_at desc), '[]'::jsonb)
      from public.service_requests r
      join public.restaurant_tables t on t.id = r.table_id
      left join public.app_users u on u.id = r.acknowledged_by_user_id
      where r.status in ('pending', 'acknowledged')
    ),
    'sessions', (
      select coalesce(jsonb_agg(
        to_jsonb(s) || jsonb_build_object(
          'restaurant_tables', case when t.id is null then null else jsonb_build_object('table_number', t.table_number, 'table_name', t.table_name) end,
          'assigned_waiter', case when u.id is null then null else public.public_user(u) end,
          'session_items', (
            select coalesce(jsonb_agg(
              to_jsonb(i) || jsonb_build_object('created_by_user', case when cu.id is null then null else public.public_user(cu) end)
              order by i.created_at
            ), '[]'::jsonb)
            from public.session_items i
            left join public.app_users cu on cu.id = i.created_by_user_id
            where i.session_id = s.id
          )
        ) order by s.opened_at desc), '[]'::jsonb)
      from public.table_sessions s
      left join public.restaurant_tables t on t.id = s.table_id
      left join public.app_users u on u.id = s.assigned_waiter_id
      where s.status = 'open'
    )
  );
end;
$$;

grant execute on function public.get_admin_snapshot(text) to anon, authenticated;

do $$
declare
  category_name text;
  category_order integer := 100;
begin
  foreach category_name in array array['Snack', 'Bebidas', 'Medicina', 'Otros'] loop
    if not exists (select 1 from public.menu_categories mc where lower(mc.name) = lower(category_name)) then
      insert into public.menu_categories(name, sort_order, is_active) values (category_name, category_order, true);
    end if;
    category_order := category_order + 1;
  end loop;
end $$;

do $$
begin
  begin alter publication supabase_realtime add table public.service_requests; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.table_sessions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.session_items; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.chat_messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.business_settings; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.restaurant_tables; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.menu_categories; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.menu_items; exception when duplicate_object then null; end;
end $$;

commit;

-- Administracion segura de usuarios. Las relaciones operativas usan ON DELETE
-- SET NULL y el historico de Apps Script conserva el nombre del responsable.
create or replace function public.delete_user(auth_token text, user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor public.app_users;
  target public.app_users;
begin
  actor := public.require_admin(auth_token);
  select * into target from public.app_users where id = user_id;
  if target.id is null then return jsonb_build_object('deleted', false, 'reason', 'not_found'); end if;
  if target.id = actor.id then raise exception 'No puedes eliminar tu propio usuario mientras tienes la sesion abierta.'; end if;
  if target.role = 'admin' and target.is_active
     and not exists(select 1 from public.app_users u where u.id <> target.id and u.role = 'admin' and u.is_active) then
    raise exception 'No puedes eliminar el ultimo administrador activo.';
  end if;
  delete from public.app_users where id = target.id;
  return jsonb_build_object('deleted', true, 'id', target.id, 'full_name', target.full_name);
end;
$$;

grant execute on function public.delete_user(text, uuid) to anon, authenticated;

-- Correccion de administracion de usuarios: usa parametros posicionales para
-- evitar ambiguedades entre el parametro id y la columna app_users.id.
create or replace function public.save_user(
  auth_token text,
  id uuid,
  full_name text,
  username text,
  pin text default '',
  role text default 'waiter',
  is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  saved public.app_users;
  current_row public.app_users;
begin
  perform public.require_admin($1);
  if trim($3) = '' or lower(trim($4)) !~ '^[a-z0-9._-]{3,40}$' then raise exception 'Nombre o usuario invalido.'; end if;
  if $5 <> '' and $5 !~ '^[0-9]{4,12}$' then raise exception 'El PIN debe tener entre 4 y 12 digitos.'; end if;
  select u.* into current_row from public.app_users u where u.id = $2;
  if current_row.id is null and $5 = '' then raise exception 'El PIN es obligatorio para un usuario nuevo.'; end if;
  if current_row.role = 'admin' and ($6 <> 'admin' or not $7)
     and not exists(select 1 from public.app_users u where u.id <> current_row.id and u.role = 'admin' and u.is_active) then
    raise exception 'No puedes desactivar o cambiar el rol del ultimo administrador.';
  end if;
  insert into public.app_users(id, full_name, username, pin_hash, role, is_active)
  values ($2, trim($3), lower(trim($4)), crypt($5, gen_salt('bf', 10)), case when $6 = 'admin' then 'admin' else 'waiter' end, $7)
  on conflict on constraint app_users_pkey do update set
    full_name = excluded.full_name, username = excluded.username, role = excluded.role, is_active = excluded.is_active,
    pin_hash = case when $5 <> '' then crypt($5, gen_salt('bf', 10)) else app_users.pin_hash end
  returning * into saved;
  return public.public_user(saved);
exception when unique_violation then
  raise exception 'Ese nombre de usuario ya esta en uso.';
end;
$$;

grant execute on function public.save_user(text, uuid, text, text, text, text, boolean) to anon, authenticated;

create or replace function public.login(username text, pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  normalized text := lower(trim($1));
  found_user public.app_users;
  attempt public.login_attempts;
  raw_token text;
  expiry timestamptz := now() + interval '12 hours';
begin
  select a.* into attempt from public.login_attempts a where a.username = normalized;
  if attempt.blocked_until > now() then return null; end if;
  select u.* into found_user from public.app_users u where u.username = normalized and u.is_active limit 1;
  if found_user.id is null or crypt($2, found_user.pin_hash) <> found_user.pin_hash then
    insert into public.login_attempts(username, attempts, blocked_until)
    values (normalized, 1, null)
    on conflict on constraint login_attempts_pkey do update set
      attempts = case when login_attempts.blocked_until <= now() then 1 else login_attempts.attempts + 1 end,
      blocked_until = case when login_attempts.attempts + 1 >= 8 then now() + interval '5 minutes' else login_attempts.blocked_until end,
      updated_at = now();
    return null;
  end if;
  delete from public.login_attempts a where a.username = normalized;
  delete from public.auth_sessions s where s.expires_at <= now();
  raw_token := encode(gen_random_bytes(32), 'hex');
  insert into public.auth_sessions(user_id, token_hash, expires_at)
  values (found_user.id, encode(digest(raw_token, 'sha256'), 'hex'), expiry);
  update public.app_users u set last_login_at = now() where u.id = found_user.id returning u.* into found_user;
  return jsonb_build_object('token', raw_token, 'expires_at', expiry, 'user', public.public_user(found_user));
end;
$$;

grant execute on function public.login(text, text) to anon, authenticated;

-- Instalacion inicial reutilizable: no inserta datos del negocio anterior.
-- La primera persona crea su administrador desde la pantalla de acceso.
create extension if not exists pgcrypto with schema extensions;

create or replace function public.get_initial_setup_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'needs_initial_admin', not exists (select 1 from public.app_users)
  );
$$;

grant execute on function public.get_initial_setup_status() to anon, authenticated;

create or replace function public.bootstrap_first_admin(
  full_name text,
  username text,
  pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  saved public.app_users;
  normalized_username text := lower(trim(coalesce(username, '')));
begin
  lock table public.app_users in access exclusive mode;
  if exists (select 1 from public.app_users) then
    raise exception 'La instalación ya tiene usuarios. Inicia sesión con un administrador existente.';
  end if;
  if trim(coalesce(full_name, '')) = '' then
    raise exception 'El nombre completo es obligatorio.';
  end if;
  if normalized_username !~ '^[a-z0-9._-]{3,40}$' then
    raise exception 'El usuario debe tener entre 3 y 40 caracteres: letras, números, punto, guion o guion bajo.';
  end if;
  if coalesce(pin, '') !~ '^[0-9]{4,12}$' then
    raise exception 'El PIN debe tener entre 4 y 12 dígitos.';
  end if;
  insert into public.app_users(full_name, username, pin_hash, role, is_active)
  values (trim(full_name), normalized_username, crypt(pin, gen_salt('bf', 10)), 'admin', true)
  returning * into saved;
  return public.public_user(saved);
end;
$$;

grant execute on function public.bootstrap_first_admin(text, text, text) to anon, authenticated;

-- Activos de marca: el bucket y los permisos se crean junto con el esquema.
insert into storage.buckets (id, name, public)
values ('brand-assets', 'brand-assets', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "brand_assets_read" on storage.objects;
drop policy if exists "brand_assets_insert_admin" on storage.objects;
drop policy if exists "brand_assets_update_admin" on storage.objects;
drop policy if exists "brand_assets_delete_admin" on storage.objects;

create policy "brand_assets_read"
on storage.objects for select
using (bucket_id = 'brand-assets');

create policy "brand_assets_insert_admin"
on storage.objects for insert to anon, authenticated
with check (bucket_id = 'brand-assets' and public.app_is_admin());

create policy "brand_assets_update_admin"
on storage.objects for update to anon, authenticated
using (bucket_id = 'brand-assets' and public.app_is_admin())
with check (bucket_id = 'brand-assets' and public.app_is_admin());

create policy "brand_assets_delete_admin"
on storage.objects for delete to anon, authenticated
using (bucket_id = 'brand-assets' and public.app_is_admin());

+-- Roles Jefe / Administrador / Mesero y permisos por sección.
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
