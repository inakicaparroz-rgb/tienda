const SUPABASE_URL = "https://anaonrcaxhwxvuqcsyfg.supabase.co";

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

function buildEmailHtml({ customerName, orderSummary, deliveryMethod, deliveryDetails, total }) {
  return `
    <div style="font-family:monospace;max-width:560px;margin:0 auto;background:#000;color:#fff;padding:2rem">
      <h2 style="color:#57BEA1;margin-bottom:1.5rem">Cop or Drop</h2>
      <p>Hola <strong>${customerName}</strong>,</p>
      <p>Tu pedido fue confirmado. Acá está el detalle:</p>
      <div style="border:1px solid #333;padding:1rem;margin:1.5rem 0;white-space:pre-line">${orderSummary}<br><br><strong>TOTAL PAGADO: ${total}</strong></div>
      <p><strong>Método de entrega:</strong> ${deliveryMethod}</p>
      <div style="border:1px solid #333;padding:1rem;margin:1rem 0;white-space:pre-line">${deliveryDetails}</div>
      <p style="color:#888;font-size:12px;margin-top:2rem">Nos contactamos a la brevedad para coordinar. Cualquier consulta respondé este mail.</p>
    </div>
  `;
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return new Response("OK", { status: 200 });

  const supabaseFetch = supabaseFetcher(env);

  async function liberarUnidad(unidadId) {
    await supabaseFetch("/rest/v1/rpc/liberar_unidad", {
      method: "POST",
      body: JSON.stringify({ p_unidad_id: unidadId }),
    });
  }

  async function registrarVentaWeb({ paymentId, metadata, totalArs }) {
    const items = JSON.parse(metadata.items_json || "[]");
    if (items.length === 0) return;

    let clienteId;
    if (metadata.customer_phone) {
      const { data: existentes } = await supabaseFetch(
        `/rest/v1/clientes?telefono=eq.${encodeURIComponent(metadata.customer_phone)}&select=id&limit=1`
      );
      if (Array.isArray(existentes) && existentes.length > 0) clienteId = existentes[0].id;
    }
    if (!clienteId) {
      const { data: nuevo } = await supabaseFetch("/rest/v1/clientes", {
        method: "POST",
        body: JSON.stringify({
          nombre: metadata.customer_name || "Cliente web",
          telefono: metadata.customer_phone || null,
          email: metadata.customer_email || null,
        }),
      });
      clienteId = Array.isArray(nuevo) ? nuevo[0].id : null;
    }
    if (!clienteId) throw new Error("No se pudo crear/encontrar el cliente");

    const { data: ventaData } = await supabaseFetch("/rest/v1/ventas", {
      method: "POST",
      body: JSON.stringify({
        cliente_id: clienteId,
        canal: "web",
        mp_payment_id: String(paymentId),
      }),
    });
    const venta = Array.isArray(ventaData) ? ventaData[0] : null;
    if (!venta) throw new Error("No se pudo crear la venta");

    const cotizacion = Number(metadata.cotizacion_usada) || null;
    for (const item of items) {
      await supabaseFetch("/rest/v1/venta_items", {
        method: "POST",
        body: JSON.stringify({
          venta_id: venta.id,
          unidad_id: item.unidad_id,
          precio_venta: item.precio_venta,
          moneda: "ARS",
          cotizacion_usada: cotizacion,
          costo_usd_snapshot: item.costo_usd_snapshot || 0,
          precio_lista_usd_snapshot: item.precio_lista_usd_snapshot || 0,
        }),
      });
    }

    await supabaseFetch("/rest/v1/caja_movimientos", {
      method: "POST",
      body: JSON.stringify({
        tipo: "ingreso",
        categoria: "venta",
        motivo: metadata.customer_name || "Cliente web",
        monto: totalArs,
        moneda: "ARS",
        cotizacion_usada: cotizacion,
        venta_id: venta.id,
      }),
    });
  }

  try {
    const payload = await request.json();

    if (payload.type !== "payment" && payload.topic !== "payment") {
      return new Response("ignored", { status: 200 });
    }

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
      return new Response("payment rejected/cancelled, reserva liberada", { status: 200 });
    }

    if (payment.status !== "approved") {
      return new Response("payment not approved yet", { status: 200 });
    }

    const { data: yaExiste } = await supabaseFetch(
      `/rest/v1/ventas?mp_payment_id=eq.${paymentId}&select=id&limit=1`
    );
    if (Array.isArray(yaExiste) && yaExiste.length > 0) {
      return new Response("ya procesado", { status: 200 });
    }

    if (payment.transaction_amount <= 0) {
      return new Response("skipped: zero amount", { status: 200 });
    }

    await registrarVentaWeb({ paymentId, metadata, totalArs: payment.transaction_amount });

    const customerEmail  = payment.payer?.email || "";
    const customerName   = metadata.customer_name || payment.payer?.first_name || "Cliente";
    const total          = `${payment.currency_id} ${payment.transaction_amount}`;
    const orderSummary   = metadata.order_summary   || "Ver detalle en MP";
    const deliveryMethod = metadata.delivery_method || "-";
    const deliveryDetails= metadata.delivery_details|| "-";

    const html = buildEmailHtml({ customerName, orderSummary, deliveryMethod, deliveryDetails, total });

    async function sendEmail({ to, subject, html }) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: "Cop or Drop <noreply@copordropstore.com>",
          to,
          subject,
          html,
        }),
      });
    }

    await sendEmail({ to: env.STORE_EMAIL, subject: `[NUEVO PEDIDO] ${customerName} — ${total}`, html });

    if (customerEmail && customerEmail !== env.STORE_EMAIL) {
      await sendEmail({ to: customerEmail, subject: "Cop or Drop — Confirmación de pedido", html });
    }

    return new Response("venta registrada y mails enviados", { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
