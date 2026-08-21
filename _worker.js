const SUPABASE_URL = "https://anaonrcaxhwxvuqcsyfg.supabase.co";
const BLUE = 1530;
const MARGIN = 1.225;
const effectiveARS = (p) => Math.round(p * BLUE * MARGIN / 1000) * 1000;

function supabase(env) {
  return async (path, opts = {}) => {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "return=representation",
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  };
}

async function handleCreatePreference(request, env) {
  const sb = supabase(env);

  const liberarUnidad = (id) => sb("/rest/v1/rpc/liberar_unidad", {
    method: "POST", body: JSON.stringify({ p_unidad_id: id }),
  });

  const reservarUnidad = async (productoId, talle) => {
    const { ok, data } = await sb("/rest/v1/rpc/reservar_unidad", {
      method: "POST", body: JSON.stringify({ p_producto_id: productoId, p_talle: talle }),
    });
    if (!ok || !Array.isArray(data) || !data.length) return null;
    return data[0];
  };

  let payload;
  try { payload = await request.json(); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  const { items, payer, customer_phone, back_urls, delivery_method, delivery_details } = payload;
  if (!Array.isArray(items) || !items.length) return new Response("Missing items", { status: 400 });

  const reservados = [];
  for (const item of items) {
    const { data: producto } = await sb(`/rest/v1/productos?id=eq.${item.producto_id}&select=id,nombre,nombre_web,precio_venta_usd`);
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
    reservados.push({ producto: p, unidad, talle: item.talle || null, precioArs: effectiveARS(Number(p.precio_venta_usd) || 0) });
  }

  const mpItems = reservados.map(r => ({
    title: `${r.producto.nombre_web || r.producto.nombre}${r.talle ? ` (Talle ${r.talle})` : ""}`,
    quantity: 1, unit_price: r.precioArs, currency_id: "ARS",
  }));
  const itemsMeta = reservados.map(r => ({
    unidad_id: r.unidad.id, precio_venta: r.precioArs,
    costo_usd_snapshot: Number(r.unidad.costo_usd) || 0,
    precio_lista_usd_snapshot: Number(r.producto.precio_venta_usd) || 0,
  }));
  const orderSummary = mpItems.map(it => `• ${it.title} — ARS ${it.unit_price}`).join("\n")
    + `\n\nTOTAL: ARS ${mpItems.reduce((s, it) => s + it.unit_price, 0)}`;

  try {
    const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.MP_ACCESS_TOKEN}` },
      body: JSON.stringify({
        items: mpItems, payer, back_urls, auto_return: "approved",
        statement_descriptor: "COP OR DROP",
        notification_url: "https://copordropstore.com/functions/mp-webhook",
        metadata: {
          customer_name: payer?.name || "", customer_phone: customer_phone || "",
          customer_email: payer?.email || "", delivery_method: delivery_method || "",
          delivery_details: delivery_details || "", order_summary: orderSummary,
          cotizacion_usada: BLUE, items_json: JSON.stringify(itemsMeta),
        },
      }),
    });
    const body = await mpRes.text();
    if (!mpRes.ok) for (const r of reservados) await liberarUnidad(r.unidad.id);
    return new Response(body, { status: mpRes.status, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    for (const r of reservados) await liberarUnidad(r.unidad.id);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

async function handleMpWebhook(request, env) {
  if (request.method !== "POST") return new Response("OK", { status: 200 });
  const sb = supabase(env);

  const liberarUnidad = (id) => sb("/rest/v1/rpc/liberar_unidad", {
    method: "POST", body: JSON.stringify({ p_unidad_id: id }),
  });

  try {
    const payload = await request.json();
    if (payload.type !== "payment" && payload.topic !== "payment") return new Response("ignored", { status: 200 });
    const paymentId = payload.data?.id || payload.id;
    if (!paymentId) return new Response("no payment id", { status: 200 });

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` },
    });
    const payment = await mpRes.json();
    const metadata = payment.metadata || {};
    const items = JSON.parse(metadata.items_json || "[]");

    if (payment.status === "rejected" || payment.status === "cancelled") {
      for (const item of items) await liberarUnidad(item.unidad_id);
      return new Response("liberada", { status: 200 });
    }
    if (payment.status !== "approved") return new Response("pending", { status: 200 });

    const { data: yaExiste } = await sb(`/rest/v1/ventas?mp_payment_id=eq.${paymentId}&select=id&limit=1`);
    if (Array.isArray(yaExiste) && yaExiste.length) return new Response("ya procesado", { status: 200 });
    if (payment.transaction_amount <= 0) return new Response("skipped", { status: 200 });

    // Registrar venta
    let clienteId;
    if (metadata.customer_phone) {
      const { data: ex } = await sb(`/rest/v1/clientes?telefono=eq.${encodeURIComponent(metadata.customer_phone)}&select=id&limit=1`);
      if (Array.isArray(ex) && ex.length) clienteId = ex[0].id;
    }
    if (!clienteId) {
      const { data: nuevo } = await sb("/rest/v1/clientes", {
        method: "POST",
        body: JSON.stringify({ nombre: metadata.customer_name || "Cliente web", telefono: metadata.customer_phone || null, email: metadata.customer_email || null }),
      });
      clienteId = Array.isArray(nuevo) ? nuevo[0].id : null;
    }
    const { data: ventaData } = await sb("/rest/v1/ventas", {
      method: "POST",
      body: JSON.stringify({ cliente_id: clienteId, canal: "web", mp_payment_id: String(paymentId) }),
    });
    const venta = Array.isArray(ventaData) ? ventaData[0] : null;
    const cotizacion = Number(metadata.cotizacion_usada) || null;
    for (const item of items) {
      await sb("/rest/v1/venta_items", {
        method: "POST",
        body: JSON.stringify({ venta_id: venta.id, unidad_id: item.unidad_id, precio_venta: item.precio_venta, moneda: "ARS", cotizacion_usada: cotizacion, costo_usd_snapshot: item.costo_usd_snapshot || 0, precio_lista_usd_snapshot: item.precio_lista_usd_snapshot || 0 }),
      });
    }
    await sb("/rest/v1/caja_movimientos", {
      method: "POST",
      body: JSON.stringify({ tipo: "ingreso", categoria: "venta", motivo: metadata.customer_name || "Cliente web", monto: payment.transaction_amount, moneda: "ARS", cotizacion_usada: cotizacion, venta_id: venta.id }),
    });

    // Emails
    const html = `<div style="font-family:monospace;max-width:560px;margin:0 auto;background:#000;color:#fff;padding:2rem"><h2 style="color:#57BEA1">Cop or Drop</h2><p>Hola <strong>${metadata.customer_name || "Cliente"}</strong>,</p><p>Tu pedido fue confirmado.</p><div style="border:1px solid #333;padding:1rem;margin:1.5rem 0;white-space:pre-line">${metadata.order_summary || ""}<br><br><strong>TOTAL: ${payment.currency_id} ${payment.transaction_amount}</strong></div><p><strong>Entrega:</strong> ${metadata.delivery_method || "-"}</p><div style="border:1px solid #333;padding:1rem;margin:1rem 0;white-space:pre-line">${metadata.delivery_details || "-"}</div></div>`;
    const sendEmail = (to, subject) => fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: "Cop or Drop <noreply@copordropstore.com>", to, subject, html }),
    });
    await sendEmail(env.STORE_EMAIL, `[NUEVO PEDIDO] ${metadata.customer_name || "Cliente"} — ${payment.currency_id} ${payment.transaction_amount}`);
    const customerEmail = payment.payer?.email || "";
    if (customerEmail && customerEmail !== env.STORE_EMAIL) {
      await sendEmail(customerEmail, "Cop or Drop — Confirmación de pedido");
    }
    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/functions/create-preference" && request.method === "POST") {
      return handleCreatePreference(request, env);
    }
    if (url.pathname === "/functions/mp-webhook") {
      return handleMpWebhook(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
