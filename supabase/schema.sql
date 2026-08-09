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

-- Para poder distinguir con seguridad qué se cargó por importación masiva
-- vs. a mano, y poder deshacer una importación sin arriesgar datos reales.
alter table productos add column if not exists origen text not null default 'manual'
  check (origen in ('manual', 'importado'));

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

alter table unidades add column if not exists origen text not null default 'manual'
  check (origen in ('manual', 'importado'));

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

drop trigger if exists trg_historial_caja_movimientos on caja_movimientos;
create trigger trg_historial_caja_movimientos
  after update on caja_movimientos
  for each row execute function registrar_historial();

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

-- ═══ MÓDULO DEUDAS Y DEUDORES ═══════════════════════════════════════════

-- ─── Caja: nueva categoría "pago_deuda" + vínculos informativos ───────────
-- cliente_id se completa solo cuando categoria = 'pago_deuda'; inversor_id
-- solo cuando categoria es 'inversion' o 'pago_inversor'. Sin FK dura,
-- mismo criterio que venta_id (referencia informativa).

alter table caja_movimientos drop constraint if exists caja_movimientos_categoria_check;
alter table caja_movimientos add constraint caja_movimientos_categoria_check
  check (categoria in ('venta', 'inversion', 'retiro', 'gasto_operativo', 'gasto_comercial', 'pago_inversor', 'pago_deuda'));

alter table caja_movimientos add column if not exists cliente_id uuid;
alter table caja_movimientos add column if not exists inversor_id uuid;

-- ─── Ventas: cuenta corriente (venta con pago parcial) ─────────────────────
-- Si cuenta_corriente = true, monto_abonado (en la moneda de abonado_moneda,
-- USD o ARS — se guarda tal cual se cobró, sin convertir, para que coincida
-- con el ingreso real en Flujo de Caja) es lo que se cobró en el momento; la
-- diferencia contra el total de la venta (convertida a USD) queda como deuda
-- del cliente (se registra en deudas_movimientos al guardar la venta).

alter table ventas add column if not exists cuenta_corriente boolean not null default false;

do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'ventas' and column_name = 'monto_abonado_usd') then
    alter table ventas rename column monto_abonado_usd to monto_abonado;
  end if;
end $$;
alter table ventas add column if not exists monto_abonado numeric(12,2);
alter table ventas add column if not exists abonado_moneda text check (abonado_moneda in ('USD', 'ARS'));

-- ─── Inversores ─────────────────────────────────────────────────────────

create table if not exists inversores (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  created_at timestamptz not null default now()
);

insert into inversores (nombre)
  select 'Damián' where not exists (select 1 from inversores where nombre = 'Damián');
insert into inversores (nombre)
  select 'Eugenia' where not exists (select 1 from inversores where nombre = 'Eugenia');

alter table inversores enable row level security;
drop policy if exists "inversores_authenticated_all" on inversores;
create policy "inversores_authenticated_all" on inversores
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
grant select, insert, update, delete on inversores to authenticated;

-- ─── Deudas: ledger único para clientes e inversores ───────────────────────
-- tipo 'debe' aumenta el saldo pendiente, tipo 'pago' lo reduce. Para
-- clientes, "debe" es lo que nos deben; para inversores, "debe" es lo que
-- nosotros les debemos (pusieron plata), y "pago" es cuando se la devolvemos.
-- monto siempre en USD (moneda de referencia para el saldo, sin importar en
-- qué moneda se haya cobrado/pagado el movimiento de caja de origen).

create table if not exists deudas_movimientos (
  id uuid primary key default gen_random_uuid(),
  entidad_tipo text not null check (entidad_tipo in ('cliente', 'inversor')),
  entidad_id uuid not null,
  tipo text not null check (tipo in ('debe', 'pago')),
  motivo text not null,
  monto numeric(12,2) not null,
  fecha date not null default current_date,
  venta_id uuid,
  caja_movimiento_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_deudas_entidad on deudas_movimientos(entidad_tipo, entidad_id);

alter table deudas_movimientos enable row level security;
drop policy if exists "deudas_movimientos_authenticated_all" on deudas_movimientos;
create policy "deudas_movimientos_authenticated_all" on deudas_movimientos
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
grant select, insert, update, delete on deudas_movimientos to authenticated;

drop trigger if exists trg_historial_deudas_movimientos on deudas_movimientos;
create trigger trg_historial_deudas_movimientos
  after update on deudas_movimientos
  for each row execute function registrar_historial();

-- ═══ MÓDULO REPORTES ═══════════════════════════════════════════════════

-- ─── Caja: cotización histórica ─────────────────────────────────────────
-- Antes, cualquier movimiento en ARS se convertía a USD con la cotización
-- ACTUAL (la de hoy), sin importar de qué mes fuera — se perdía precisión
-- histórica. Ahora cada movimiento en ARS guarda la cotización del momento
-- en que se cargó, y Reportes usa esa en vez de la de hoy.

alter table caja_movimientos add column if not exists cotizacion_usada numeric(10,2);

-- Backfill: para movimientos ya cargados que vienen de una venta, se puede
-- recuperar la cotización real que se usó en esa venta (venta_items ya la
-- guarda). Para movimientos manuales o importados del Excel viejo no hay
-- forma de saber la cotización histórica real, quedan sin este dato (los
-- reportes de esos meses van a usar la cotización actual como aproximación).
update caja_movimientos cm
set cotizacion_usada = sub.cotizacion
from (
  select distinct on (vi.venta_id) vi.venta_id, vi.cotizacion_usada as cotizacion
  from venta_items vi
  where vi.moneda = 'ARS' and vi.cotizacion_usada is not null
) sub
where cm.venta_id = sub.venta_id and cm.moneda = 'ARS' and cm.cotizacion_usada is null;

-- ─── Caja: a qué socio corresponde un retiro ────────────────────────────
-- Estructurado (en vez de adivinar el nombre dentro del texto del motivo):
-- 'emi' o 'ina' si es de uno solo, 'ambos' si se retiran los dos juntos.

alter table caja_movimientos add column if not exists retiro_socio text
  check (retiro_socio in ('emi', 'ina', 'ambos'));

-- Backfill de retiros ya cargados, a partir del motivo (mismo criterio que
-- ya venía usando Reportes antes de tener este campo estructurado).
update caja_movimientos set retiro_socio = 'ambos'
  where categoria = 'retiro' and retiro_socio is null and motivo ~* 'ambos';
update caja_movimientos set retiro_socio = 'emi'
  where categoria = 'retiro' and retiro_socio is null and motivo ~* 'emi';
update caja_movimientos set retiro_socio = 'ina'
  where categoria = 'retiro' and retiro_socio is null and motivo ~* 'i[ñn]a';

-- ═══ MÓDULO WEB (conexión con copordropstore.com) ═══════════════════════

-- nombre_web: nombre a mostrar al cliente (si está vacío, la web usa el
-- nombre interno como respaldo). slug_web: el slug que tenía el producto
-- en el catálogo viejo (Google Sheets) — solo sirve para que la
-- herramienta de vinculación sepa cuáles ya están vinculados y no los
-- vuelva a preguntar.

alter table productos add column if not exists nombre_web text;
alter table productos add column if not exists slug_web text;

create unique index if not exists idx_productos_slug_web on productos(slug_web) where slug_web is not null;

-- producto_fotos: fotos adicionales de un producto (además de la principal
-- en productos.imagen_url), para el carrusel de la web. Se cargan desde el
-- panel al crear/editar un producto.

create table if not exists producto_fotos (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references productos(id) on delete cascade,
  url text not null,
  orden int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_producto_fotos_producto on producto_fotos(producto_id);

alter table producto_fotos enable row level security;

drop policy if exists "producto_fotos_authenticated_all" on producto_fotos;
create policy "producto_fotos_authenticated_all" on producto_fotos
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "producto_fotos_anon_select" on producto_fotos;
create policy "producto_fotos_anon_select" on producto_fotos
  for select using (true);

grant select, insert, update, delete on producto_fotos to authenticated;
grant select on producto_fotos to anon;

-- alguna_vez_en_stock: se pone en true la primera vez que un producto recibe
-- una unidad, y nunca se vuelve a apagar. Así, un producto recién creado (sin
-- unidades todavía) no aparece en la web hasta que se le carga stock, pero
-- una vez que apareció, si con el tiempo se vende todo, queda visible como
-- "sin stock" en vez de desaparecer.

alter table productos add column if not exists alguna_vez_en_stock boolean not null default false;

update productos set alguna_vez_en_stock = true
where id in (select distinct producto_id from unidades);

create or replace function marcar_producto_en_stock()
returns trigger
language plpgsql
as $$
begin
  update productos set alguna_vez_en_stock = true
  where id = new.producto_id and alguna_vez_en_stock = false;
  return new;
end;
$$;

drop trigger if exists trg_marcar_producto_en_stock on unidades;
create trigger trg_marcar_producto_en_stock
after insert on unidades
for each row execute function marcar_producto_en_stock();

-- productos_publicos (la vista que lee la web) necesita nombre_web y stock
-- total además de lo que ya exponía.
create or replace view productos_publicos as
select
  id,
  slug,
  coalesce(nullif(nombre_web, ''), nombre) as nombre,
  marca,
  categoria,
  imagen_url,
  precio_venta_usd,
  precio_promocional_usd,
  tiene_talles,
  fit
from productos
where activo = true and alguna_vez_en_stock = true;
