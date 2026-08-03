# Panel interno — Cop or Drop

Sistema de stock/ventas/caja de uso interno. Separado de la web pública (`/index.html` en la raíz del repo).

## Puesta en marcha (una sola vez)

1. **Base de datos:** en el proyecto de Supabase, abrir `SQL Editor` y correr todo el contenido de `/supabase/schema.sql`.
2. **Usuario de acceso:** en Supabase → `Authentication` → `Users` → `Add user`, crear el usuario (email + contraseña) con el que vas a entrar al panel. Este panel no tiene registro público a propósito — es de uso interno, así que el único acceso es el que se crea manualmente acá.
3. **Conectar el panel a la base:** en `panel/index.html`, reemplazar:
   - `SUPABASE_URL` por la Project URL (Supabase → Project Settings → API)
   - `SUPABASE_ANON_KEY` por la `anon public` key (la misma pantalla)

   Estos dos valores son seguros de tener en el código — no son secretos, están pensados para viajar al navegador. Lo único que nunca va acá es la `service_role key`.

4. **Deploy:** el panel se despliega en Vercel (proyecto `copordrop-panel`), separado de la web pública que sigue en Netlify. Root Directory configurado en `panel`.

## Estado actual

- ✅ Stock: alta de productos (con fit y estado New/VNDS/Used), unidades con código de barra autogenerado (con costo por unidad: compra + envío, y fecha de ingreso editable + días en stock calculados), listado plano de unidades por producto, búsqueda/filtro (compatible con lector de código de barra USB). Editar y eliminar tanto productos como unidades desde el menú "⋮" de cada fila, con historial automático de modificaciones (no visible salvo que se pida).
- ✅ Login con botón para mostrar/ocultar la contraseña.
- ✅ Contador "Mostrando X/Y" y botón de orden por fecha (asc/desc) en Stock y Ventas, para poder corroborar cantidades después de una carga masiva.
- ✅ Importar stock desde CSV (carga masiva del Excel viejo): botón "Importar stock (CSV)" en Stock. Columnas esperadas: `MODELO, TALLE, PRECIO COMPRA, FECHA COMPRA, PRECIO VENTA, FECHA VENTA` (fechas DD/MM/AAAA). Solo trae las filas **sin** FECHA VENTA (lo que sigue en stock).
- ✅ Importar historial de ventas desde CSV: botón "Importar historial (CSV)" en Ventas, mismo archivo/columnas, pero solo las filas **con** FECHA VENTA. Crea la unidad y la venta juntas (evita ambigüedad si hay filas repetidas), cliente placeholder `XXX` (no hay forma de saber quién compró cada una en el Excel viejo), precio de venta siempre en USD, cada fila como una venta separada.
- ✅ Ventas: cliente con autocompletado (o alta nueva), carga de venta con una o varias prendas por código de barra escaneado, precio y moneda por prenda, cotización del dólar auto-sugerida (dolarapi.com) pero editable y fijada por venta, cálculo automático de ganancia y % de descuento por ítem, descuenta stock solo (la unidad pasa a "vendido"), genera ingreso(s) en caja (uno por moneda usada). Listado con buscador libre y detalle expandible por venta. Editar (agregar/sacar/modificar prendas de la venta, recalcula caja sola) y eliminar (revierte las unidades a disponible) desde el menú "⋮" de cada fila.
- ⏳ Flujo de caja, Reportes, Deudas y deudores: pendientes. Ya existe la tabla base `caja_movimientos` (Ventas ya escribe ahí) — falta la pestaña visual.
- ⏳ Conexión con la web pública (para que index.html lea `productos_publicos` / `stock_publico` en vez del CSV de Google Sheets): pendiente.

## Pendientes puntuales de Stock

Ninguno por ahora.
