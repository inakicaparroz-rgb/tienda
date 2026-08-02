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
