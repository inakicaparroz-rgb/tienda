const SUPABASE_URL = "https://anaonrcaxhwxvuqcsyfg.supabase.co";

const BLUE = 1530;
const MARGIN = 1.225;
const effectiveARS = (precioUsd) => Math.round(precioUsd * BLUE * MARGIN / 1000) * 1000;

function supabaseFetcher(env) {
  return async function(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "return=representation",
        ...(options.headers || {}),
      },
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  };
}

export async function onRequestPost({ request, env }) {
  const supabaseFetch = supabaseFetcher(env);

  async function reservarUnidad(productoId, talle) {
    const { ok, data } = await supabaseFetch("/rest/v1/rpc/reservar_unidad", {
      method: "POST",
      body: JSON.stringify({ p_producto_id: productoId, p_talle: talle }),
    });
    if (!ok || !Array.isArray(data) || data.length === 0) return null;
    return data[0];
  }

  async function liberarUnidad(unidadId) {
    await supabaseFetch("/rest/v1/rpc/liberar_unidad", {
      method: "POST",
      body: JSON.stringify({ p_unidad_id: unidadId }),
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { items, payer, customer_phone, back_urls, delivery_method, delivery_details } = payload;
  if (!Array.isArray(items) || items.length === 0) {
    return new Response("Missing items", { status: 400 });
  }

  const reservados = [];
  for (const item of items) {
    const { data: producto } = await supabaseFetch(
      `/rest/v1/productos?id=eq.${item.producto_id}&select=id,nombre,nombre_web,precio_venta_usd`
    );
    const p = Array.isArray(producto) ? producto[0] : null;
    if (!p) {
      for (const r of reservados) await liberarUnidad(r.unidad.id);
      return new Response(JSON.stringify({ error: "producto_no_encontrado", producto_id: item.producto_id }), { status: 409, headers: { "Content-Type": "application/json" } });
    }

    const unidad = await reservarUnidad(item.producto_id, item.talle || null);
    if (!unidad) {
      for (const r of reservados) await liberarUnidad(r.unidad.id);
      return new Response(JSON.stringify({ error: "sin_stock", producto_id: item.producto_id, talle: item.talle || null, nombre: p.nombre_web || p.nombre }), { status: 409, headers: { "Content-Type": "application/json" } });
    }

    reservados.push({
      producto: p,
      unidad,
      talle: item.talle || null,
      precioArs: effectiveARS(Number(p.precio_venta_usd) || 0),
    });
  }

  const mpItems = reservados.map(r => ({
    title: `${r.producto.nombre_web || r.producto.nombre}${r.talle ? ` (Talle ${r.talle})` : ""}`,
    quantity: 1,
    unit_price: r.precioArs,
    currency_id: "ARS",
  }));

  const itemsMeta = reservados.map(r => ({
    unidad_id: r.unidad.id,
    precio_venta: r.precioArs,
    costo_usd_snapshot: Number(r.unidad.costo_usd) || 0,
    precio_lista_usd_snapshot: Number(r.producto.precio_venta_usd) || 0,
  }));

  const orderSummary = mpItems.map(it => `• ${it.title} — ARS ${it.unit_price}`).join("\n")
    + `\n\nTOTAL: ARS ${mpItems.reduce((s, it) => s + it.unit_price, 0)}`;

  try {
    const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        items: mpItems,
        payer,
        back_urls,
        auto_return: "approved",
        statement_descriptor: "COP OR DROP",
        notification_url: "https://copordropstore.com/functions/mp-webhook",
        metadata: {
          customer_name: payer?.name || "",
          customer_phone: customer_phone || "",
          customer_email: payer?.email || "",
          delivery_method: delivery_method || "",
          delivery_details: delivery_details || "",
          order_summary: orderSummary,
          cotizacion_usada: BLUE,
          items_json: JSON.stringify(itemsMeta),
        },
      }),
    });

    const body = await mpRes.text();

    if (!mpRes.ok) {
      for (const r of reservados) await liberarUnidad(r.unidad.id);
    }

    return new Response(body, {
      status: mpRes.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    for (const r of reservados) await liberarUnidad(r.unidad.id);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
