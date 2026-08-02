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

- ✅ Stock: alta de productos (con fit y estado New/VNDS/Used), unidades con código de barra autogenerado (con costo por unidad: compra + envío, y fecha de ingreso editable + días en stock calculados), listado plano de unidades por producto, búsqueda/filtro (compatible con lector de código de barra USB).
- ⏳ Ventas, Flujo de caja, Reportes, Deudas y deudores: pendientes.
- ⏳ Conexión con la web pública (para que index.html lea `productos_publicos` / `stock_publico` en vez del CSV de Google Sheets): pendiente.

## Pendientes puntuales de Stock

Ninguno por ahora — la subida de foto directa (Supabase Storage) ya está hecha, y el campo Descripción se sacó por obsoleto.
