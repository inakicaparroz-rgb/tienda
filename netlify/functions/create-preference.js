const https = require("https");

const SUPABASE_URL = "https://anaonrcaxhwxvuqcsyfg.supabase.co";

// Misma fórmula que index.html (BLUE/MARGIN) — el precio nunca se confía
// del navegador, se recalcula acá con el precio real del producto en el
// sistema. Si se actualiza el dólar blue en index.html, hay que actualizarlo
// acá también, si no la web muestra un precio y cobra otro.
const BLUE = 1530; // dólar blue 26/06/2026
const MARGIN = 1.225;
const effectiveARS = (precioUsd) => Math.round(precioUsd * BLUE * MARGIN / 1000) * 1000;

function httpPost(url, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "Content-Length": Buffer.byteLength(data),
      },
    }, res => {
      let chunks = "";
      res.on("data", c => chunks += c);
      res.on("end", () => resolve({ status: res.statusCode, body: chunks }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Prefer": "return=representation",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const { items, payer, customer_phone, back_urls, delivery_method, delivery_details } = payload;
  if (!Array.isArray(items) || items.length === 0) {
    return { statusCode: 400, body: "Missing items" };
  }

  // 1) Reservar cada unidad de forma atómica, con el precio real del sistema.
  const reservados = [];
  for (const item of items) {
    const { ok: lookupOk, status: lookupStatus, data: producto } = await supabaseFetch(
      `/rest/v1/productos?id=eq.${item.producto_id}&select=id,nombre,nombre_web,precio_venta_usd`
    );
    const p = Array.isArray(producto) ? producto[0] : null;
    if (!p) {
      for (const r of reservados) await liberarUnidad(r.unidad.id);
      return {
        statusCode: 409,
        body: JSON.stringify({
          error: "producto_no_encontrado",
          producto_id: item.producto_id,
          diag_lookup_ok: lookupOk,
          diag_lookup_status: lookupStatus,
          diag_lookup_body: producto,
          diag_has_service_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        }),
      };
    }

    const unidad = await reservarUnidad(item.producto_id, item.talle || null);
    if (!unidad) {
      for (const r of reservados) await liberarUnidad(r.unidad.id);
      return { statusCode: 409, body: JSON.stringify({ error: "sin_stock", producto_id: item.producto_id, talle: item.talle || null, nombre: p.nombre_web || p.nombre }) };
    }

    reservados.push({
      producto: p,
      unidad,
      talle: item.talle || null,
      precioArs: effectiveARS(Number(p.precio_venta_usd) || 0),
    });
  }

  // 2) Armar la preferencia de Mercado Pago con los precios recién calculados.
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
    const { status, body } = await httpPost(
      "https://api.mercadopago.com/checkout/preferences",
      process.env.MP_ACCESS_TOKEN,
      {
        items: mpItems,
        payer,
        back_urls,
        auto_return: "approved",
        statement_descriptor: "COP OR DROP",
        notification_url: "https://lively-pavlova-251852.netlify.app/.netlify/functions/mp-webhook",
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
      }
    );

    if (status < 200 || status >= 300) {
      for (const r of reservados) await liberarUnidad(r.unidad.id);
    }

    return { statusCode: status, headers: { "Content-Type": "application/json" }, body };
  } catch (err) {
    for (const r of reservados) await liberarUnidad(r.unidad.id);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
