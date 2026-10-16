import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('cartas: permisos reales de PostgreSQL, asignaciones y máximo de cinco', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema storage; create schema extensions;
      create table public.business_settings(is_primary boolean primary key, business_name text);
      insert into public.business_settings values (true, 'Prueba');
      create table public.app_users(id uuid primary key, role text, permissions jsonb, token text);
      insert into public.app_users values
        ('00000000-0000-4000-8000-000000000001', 'boss', '[]', 'boss-token'),
        ('00000000-0000-4000-8000-000000000002', 'waiter', '[]', 'waiter-token'),
        ('00000000-0000-4000-8000-000000000003', 'admin', '[]', 'restricted-admin');
      create table public.restaurant_tables(id uuid primary key, qr_code text, is_active boolean);
      insert into public.restaurant_tables values
        ('10000000-0000-4000-8000-000000000001','inside-secret',true),
        ('10000000-0000-4000-8000-000000000002','outside-secret',true);
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects(bucket_id text, name text);
      alter table storage.objects enable row level security;
      grant usage on schema storage to anon, authenticated;
      grant select, insert, update, delete on storage.objects to anon, authenticated;
      create function public.request_header(key text) returns text language sql stable as $$ select coalesce(current_setting('request.headers', true), '{}')::jsonb ->> key $$;
      create function public.require_app_user(p_token text) returns public.app_users language plpgsql stable security definer as $$
      declare actor public.app_users;
      begin select * into actor from public.app_users where token = p_token;
        if actor.id is null then raise exception 'No autorizado'; end if; return actor; end; $$;
      create function public.app_is_admin() returns boolean language sql stable security definer as $$
        select exists(select 1 from public.app_users where token = public.request_header('x-app-token') and role in ('boss','admin')) $$;
      create function public.app_can_access_section(section_name text) returns boolean language sql stable security definer as $$
        select exists(select 1 from public.app_users where token = public.request_header('x-app-token') and (role = 'boss' or role = 'admin' and permissions ? section_name)) $$;
      create function public.valid_table_access(p_id uuid, p_code text) returns boolean language sql stable security definer as $$
        select exists(select 1 from public.restaurant_tables where id = p_id and qr_code = p_code and is_active) $$;
      create function public.valid_table_header(p_id uuid) returns boolean language sql stable security definer as $$
        select p_id::text = public.request_header('x-table-id') and public.valid_table_access(p_id, public.request_header('x-table-code')) $$;
    `);
    const sql = await readFile(new URL('../supabase/migrations/20261016000000_table_menu_cards.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    const billSql = await readFile(new URL('../supabase/migrations/20261016010000_client_bill_toggle.sql', import.meta.url), 'utf8');
    await db.exec('alter table public.business_settings drop column client_bill_enabled');
    await db.exec(billSql);
    await db.exec(billSql);
    assert.equal((await db.query('select client_bill_enabled from public.business_settings')).rows[0].client_bill_enabled, true);
    await db.exec('update public.business_settings set client_bill_enabled=false');
    assert.equal((await db.query('select client_bill_enabled from public.business_settings')).rows[0].client_bill_enabled, false);
    await db.exec('update public.business_settings set client_bill_enabled=true');
    // Reaplicar la migración debe ser seguro.
    await db.exec(sql);
    const inside = '10000000-0000-4000-8000-000000000001';
    const outside = '10000000-0000-4000-8000-000000000002';
    const ids = Array.from({length: 6}, (_, i) => `20000000-0000-4000-8000-00000000000${i+1}`);
    const paths = ids.map((id) => `cards/${id}/image.png`);
    for (const p of paths) await db.query('insert into storage.objects values ($1,$2)', ['menu-cards', p]);
    const save = (i, name, tables, token = 'boss-token') => db.query(
      'select public.save_business_menu_card($1,$2,$3,$4,$5::uuid[],$6) as card',
      [ids[i], name, paths[i], ['blue','violet','green','amber','rose','cyan'][i], tables, token]);
    await save(0, 'Carta adentro', [inside]);
    await save(1, 'Carta afuera', [outside]);
    await save(2, 'Carta comidas', [inside, outside]);
    const clientList = async (id, code) => (await db.query('select public.get_table_menu_cards($1,$2) cards', [id, code])).rows[0].cards;
    await t.test('cada mesa recibe solo su carta de precios y la compartida', async () => {
      assert.deepEqual((await clientList(inside, 'inside-secret')).map(c => c.name), ['Carta adentro', 'Carta comidas']);
      assert.deepEqual((await clientList(outside, 'outside-secret')).map(c => c.name), ['Carta afuera', 'Carta comidas']);
      await assert.rejects(clientList(inside, 'outside-secret'), /Mesa no autorizada/);
    });
    await t.test('sin permiso de Marca no se puede listar ni modificar cartas', async () => {
      await assert.rejects(save(0, 'Cambio', [outside], 'waiter-token'), /permiso/);
      await assert.rejects(save(0, 'Cambio', [outside], 'restricted-admin'), /permiso/);
      await assert.rejects(db.query("select public.list_business_menu_cards('waiter-token')"), /permiso/);
    });
    await t.test('el bucket privado impide leer la imagen asignada a otra mesa', async () => {
      await db.query("select set_config('request.headers', $1, false)", [JSON.stringify({'x-table-id': inside, 'x-table-code': 'inside-secret'})]);
      await db.exec('set role anon');
      const visible = (await db.query("select name from storage.objects where bucket_id='menu-cards' order by name")).rows.map(r => r.name);
      assert.deepEqual(visible, [paths[0], paths[2]]);
      await assert.rejects(db.query('select * from public.business_menu_cards'), /permission denied/);
      await assert.rejects(db.query("insert into storage.objects values ('menu-cards','forbidden.png')"), /row-level security/);
      await db.exec('reset role');
    });
    await t.test('reasignar o desactivar retira el acceso también en el servidor', async () => {
      await save(2, 'Carta comidas', [outside]);
      assert.deepEqual((await clientList(inside, 'inside-secret')).map(c => c.name), ['Carta adentro']);
      await db.exec('update public.business_settings set client_menu_enabled=false');
      assert.deepEqual(await clientList(inside, 'inside-secret'), []);
      assert.equal((await db.query('select public.can_read_menu_card_image($1) allowed', [paths[0]])).rows[0].allowed, false);
      await db.exec('update public.business_settings set client_menu_enabled=true');
      await save(2, 'Carta comidas', [inside, outside]);
    });
    await t.test('cinco imágenes como máximo; actualizar y borrar siguen disponibles', async () => {
      await save(3, 'Carta cuatro', []); await save(4, 'Carta cinco', []);
      await assert.rejects(save(5, 'Carta seis', []), /hasta 5/);
      await save(0, 'Carta adentro actualizada', [inside]);
      await db.query('select public.delete_business_menu_card($1,$2)', [ids[4], 'boss-token']);
      await save(5, 'Carta nueva', [inside]);
      assert.equal((await db.query('select count(*)::int n from public.business_menu_cards')).rows[0].n, 5);
      assert.equal((await db.query('select public from storage.buckets where id=$1', ['menu-cards'])).rows[0].public, false);
    });
  } finally { await db.close(); }
});
