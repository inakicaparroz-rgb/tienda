-- Cop or Drop — Sistema interno
-- Esquema inicial: módulo STOCK (productos + unidades físicas con código de barra único)
--
-- Cómo aplicar esto: Supabase → SQL Editor → pegar todo este archivo → Run.
-- Se puede correr de nuevo sin problema (usa IF NOT EXISTS / OR REPLACE donde aplica).

-- ─── PRODUCTOS (modelo, sin diferenciar por talle) ──────────────────────────

create table if not exists productos (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  nombre text not null,
  marca text,
  categoria text,
  imagen_url text,
  precio_venta_usd numeric(10,2) not null default 0,
  precio_promocional_usd numeric(10,2),
  tiene_talles boolean not null default true,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- El costo vive en la unidad, no en el producto: cada prenda física puede
-- haber costado distinto según cuándo/cómo se compró.
alter table productos drop column if exists costo_usd;

alter table productos add column if not exists fit text
  check (fit in ('Regular', 'Oversize', 'Small', 'Boxy'));
alter table productos add column if not exists estado text
  check (estado in ('New', 'VNDS', 'Used'));

-- La descripción libre quedó obsoleta (reemplazada por fit/estado/imagen).
-- cascade porque productos_publicos depende de esta columna; se recrea más abajo.
alter table productos drop column if exists descripcion cascade;

-- ─── UNIDADES (cada prenda física, con su propio código de barra y costo) ──

create table if not exists unidades (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references productos(id) on delete cascade,
  talle text,
  codigo_barra text unique not null,
  costo_compra_usd numeric(10,2) not null default 0,
  costo_envio_usd numeric(10,2) not null default 0,
  estado text not null default 'disponible'
    check (estado in ('disponible', 'reservado', 'vendido')),
  created_at timestamptz not null default now(),
  vendido_at timestamptz
);

alter table unidades add column if not exists costo_compra_usd numeric(10,2) not null default 0;
alter table unidades add column if not exists costo_envio_usd numeric(10,2) not null default 0;
alter table unidades drop column if exists costo_usd;
alter table unidades add column costo_usd numeric(10,2)
  generated always as (costo_compra_usd + costo_envio_usd) stored;

-- Fecha real en que la prenda entró a stock (editable — no siempre coincide
-- con el día que se carga en el sistema).
alter table unidades add column if not exists fecha_ingreso date not null default current_date;

create index if not exists idx_unidades_producto on unidades(producto_id);
create index if not exists idx_unidades_codigo on unidades(codigo_barra);
create index if not exists idx_unidades_estado on unidades(estado);

-- ─── Generador de código de barra interno ──────────────────────────────────
-- Formato: COD-000001, COD-000002, ... (secuencial, sin ambigüedad).

create sequence if not exists unidades_codigo_seq;

create or replace function generar_codigo_barra()
returns text
language sql
as $$
  select 'COD-' || lpad(nextval('unidades_codigo_seq')::text, 6, '0');
$$;

-- ─── Seguridad: las tablas base solo son accesibles autenticado (panel) ────

alter table productos enable row level security;
alter table unidades enable row level security;

drop policy if exists "productos_authenticated_all" on productos;
create policy "productos_authenticated_all" on productos
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "unidades_authenticated_all" on unidades;
create policy "unidades_authenticated_all" on unidades
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Las políticas de RLS no alcanzan solas: además hace falta el permiso de
-- base sobre la tabla, si no Postgres rechaza todo con "permission denied".
grant select, insert, update, delete on productos to authenticated;
grant select, insert, update, delete on unidades to authenticated;
grant usage, select on sequence unidades_codigo_seq to authenticated;

-- ─── Vistas públicas (lo único que la web puede leer) ──────────────────────
-- Nunca exponen costo_usd ni el código de barra individual.

create or replace view productos_publicos as
select
  id,
  slug,
  nombre,
  marca,
  categoria,
  imagen_url,
  precio_venta_usd,
  precio_promocional_usd,
  tiene_talles,
  fit
from productos
where activo = true;

create or replace view stock_publico as
select
  producto_id,
  talle,
  count(*) filter (where estado = 'disponible') as cantidad_disponible
from unidades
group by producto_id, talle;

grant select on productos_publicos to anon;
grant select on stock_publico to anon;

-- ─── Storage: fotos de producto ─────────────────────────────────────────────
-- Bucket público de lectura (para que se vean en la web/panel), solo el
-- panel logueado puede subir/editar/borrar fotos.

insert into storage.buckets (id, name, public)
values ('productos', 'productos', true)
on conflict (id) do nothing;

drop policy if exists "productos_bucket_lectura_publica" on storage.objects;
create policy "productos_bucket_lectura_publica" on storage.objects
  for select using (bucket_id = 'productos');

drop policy if exists "productos_bucket_escritura_autenticada" on storage.objects;
create policy "productos_bucket_escritura_autenticada" on storage.objects
  for insert with check (bucket_id = 'productos' and auth.role() = 'authenticated');

drop policy if exists "productos_bucket_actualizacion_autenticada" on storage.objects;
create policy "productos_bucket_actualizacion_autenticada" on storage.objects
  for update using (bucket_id = 'productos' and auth.role() = 'authenticated');

drop policy if exists "productos_bucket_borrado_autenticado" on storage.objects;
create policy "productos_bucket_borrado_autenticado" on storage.objects
  for delete using (bucket_id = 'productos' and auth.role() = 'authenticated');

-- ─── Historial de modificaciones (automático, no editable a mano) ──────────
-- Cada UPDATE en productos/unidades queda registrado solo, sin que el panel
-- tenga que acordarse de llamarlo. No visible salvo que se pida (botón
-- "Historial de modificaciones" en el menú de cada fila).

create table if not exists historial (
  id uuid primary key default gen_random_uuid(),
  tabla text not null,
  registro_id uuid not null,
  datos_anteriores jsonb,
  datos_nuevos jsonb,
  modificado_at timestamptz not null default now()
);

create index if not exists idx_historial_registro on historial(tabla, registro_id);

alter table historial enable row level security;

drop policy if exists "historial_authenticated_select" on historial;
create policy "historial_authenticated_select" on historial
  for select using (auth.role() = 'authenticated');

grant select on historial to authenticated;
-- Sin insert/update/delete para authenticated a propósito: solo el trigger
-- (que corre con privilegios de su dueño) puede escribir acá.

create or replace function registrar_historial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into historial (tabla, registro_id, datos_anteriores, datos_nuevos)
  values (TG_TABLE_NAME, OLD.id, to_jsonb(OLD), to_jsonb(NEW));
  return NEW;
end;
$$;

drop trigger if exists trg_historial_productos on productos;
create trigger trg_historial_productos
  after update on productos
  for each row execute function registrar_historial();

drop trigger if exists trg_historial_unidades on unidades;
create trigger trg_historial_unidades
  after update on unidades
  for each row execute function registrar_historial();

-- ═══ MÓDULO VENTAS ══════════════════════════════════════════════════════

-- ─── Configuración general (fila única) — cotización del dólar ────────────
-- Se autoactualiza desde una API pública, pero es editable a mano si hace
-- falta forzar un valor.

create table if not exists configuracion (
  id boolean primary key default true check (id = true), -- fuerza una sola fila
  cotizacion_usd_ars numeric(10,2) not null default 0,
  cotizacion_actualizada_at timestamptz
);

insert into configuracion (id) values (true) on conflict (id) do nothing;

alter table configuracion enable row level security;
drop policy if exists "configuracion_authenticated_all" on configuracion;
create policy "configuracion_authenticated_all" on configuracion
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
grant select, update on configuracion to authenticated;

-- ─── Clientes ───────────────────────────────────────────────────────────

create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  telefono text,
  email text,
  created_at timestamptz not null default now()
);

create index if not exists idx_clientes_nombre on clientes(lower(nombre));

alter table clientes enable row level security;
drop policy if exists "clientes_authenticated_all" on clientes;
create policy "clientes_authenticated_all" on clientes
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
grant select, insert, update, delete on clientes to authenticated;

drop trigger if exists trg_historial_clientes on clientes;
create trigger trg_historial_clientes
  after update on clientes
  for each row execute function registrar_historial();

-- ─── Caja: movimientos ──────────────────────────────────────────────────
-- Tabla base para Flujo de Caja. La pestaña Caja todavía no existe, pero
-- Ventas ya necesita poder generar sus ingresos acá.

create table if not exists caja_movimientos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('ingreso', 'gasto')),
  fecha date not null default current_date,
  motivo text not null,
  categoria text not null
    check (categoria in ('venta', 'inversion', 'retiro', 'gasto_operativo', 'gasto_comercial', 'pago_inversor')),
  monto numeric(12,2) not null,
  moneda text not null check (moneda in ('USD', 'ARS')),
  venta_id uuid, -- referencia informativa, sin FK dura (una venta puede generar varios movimientos)
  created_at timestamptz not null default now()
);

create index if not exists idx_caja_venta on caja_movimientos(venta_id);

alter table caja_movimientos enable row level security;
drop policy if exists "caja_movimientos_authenticated_all" on caja_movimientos;
create policy "caja_movimientos_authenticated_all" on caja_movimientos
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
grant select, insert, update, delete on caja_movimientos to authenticated;

-- ─── Ventas (el "ticket") y sus ítems (una prenda cada uno) ────────────────

create table if not exists ventas (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id),
  canal text not null default 'local' check (canal in ('local', 'web')),
  fecha date not null default current_date,
  created_at timestamptz not null default now()
);

alter table ventas enable row level security;
drop policy if exists "ventas_authenticated_all" on ventas;
create policy "ventas_authenticated_all" on ventas
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
grant select, insert, update, delete on ventas to authenticated;

create table if not exists venta_items (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid not null references ventas(id) on delete cascade,
  unidad_id uuid not null references unidades(id),
  precio_venta numeric(10,2) not null,
  moneda text not null check (moneda in ('USD', 'ARS')),
  cotizacion_usada numeric(10,2),
  costo_usd_snapshot numeric(10,2) not null default 0,
  precio_lista_usd_snapshot numeric(10,2) not null default 0,
  precio_venta_usd numeric(10,2) generated always as (
    case when moneda = 'USD' then precio_venta
         else round(precio_venta / nullif(cotizacion_usada, 0), 2)
    end
  ) stored,
  created_at timestamptz not null default now()
);

create index if not exists idx_venta_items_venta on venta_items(venta_id);

alter table venta_items enable row level security;
drop policy if exists "venta_items_authenticated_all" on venta_items;
create policy "venta_items_authenticated_all" on venta_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
grant select, insert, update, delete on venta_items to authenticated;

-- Al cargar un ítem de venta, la unidad correspondiente pasa a vendida sola
-- (no depende de que el panel se acuerde de actualizarla aparte).

create or replace function marcar_unidad_vendida()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update unidades set estado = 'vendido', vendido_at = now() where id = NEW.unidad_id;
  return NEW;
end;
$$;

drop trigger if exists trg_marcar_unidad_vendida on venta_items;
create trigger trg_marcar_unidad_vendida
  after insert on venta_items
  for each row execute function marcar_unidad_vendida();

drop trigger if exists trg_historial_ventas on ventas;
create trigger trg_historial_ventas
  after update on ventas
  for each row execute function registrar_historial();
