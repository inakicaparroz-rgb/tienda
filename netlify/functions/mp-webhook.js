const https = require("https");

const SUPABASE_URL = "https://anaonrcaxhwxvuqcsyfg.supabase.co";

function httpGet(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
  });
}

function sendEmail({ to, subject, html }) {
  const body = JSON.stringify({
    from: "Cop or Drop <noreply@copordropstore.com>",
    to,
    subject,
    html,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.resend.com",
      path: "/emails",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      }
    }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
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

async function liberarUnidad(unidadId) {
  await supabaseFetch("/rest/v1/rpc/liberar_unidad", {
    method: "POST",
    body: JSON.stringify({ p_unidad_id: unidadId }),
  });
}

// Crea la venta completa en el sistema: cliente (buscado por teléfono o
// creado nuevo), venta, venta_items (esto marca las unidades vendidas solo,
// vía trigger) y el ingreso correspondiente en Flujo de caja.
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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 200, body: "OK" };

  try {
    const payload = JSON.parse(event.body || "{}");

    if (payload.type !== "payment" && payload.topic !== "payment") {
      return { statusCode: 200, body: "ignored" };
    }

    const paymentId = payload.data?.id || payload.id;
    if (!paymentId) return { statusCode: 200, body: "no payment id" };

    const payment = await httpGet(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      process.env.MP_ACCESS_TOKEN
    );

    console.log("payment status:", payment.status, "id:", paymentId);

    const metadata = payment.metadata || {};
    const items = JSON.parse(metadata.items_json || "[]");

    if (payment.status === "rejected" || payment.status === "cancelled") {
      for (const item of items) await liberarUnidad(item.unidad_id);
      return { statusCode: 200, body: "payment rejected/cancelled, reserva liberada" };
    }

    if (payment.status !== "approved") {
      return { statusCode: 200, body: "payment not approved yet" };
    }

    // Idempotencia: Mercado Pago puede reenviar el mismo aviso más de una vez.
    const { data: yaExiste } = await supabaseFetch(
      `/rest/v1/ventas?mp_payment_id=eq.${paymentId}&select=id&limit=1`
    );
    if (Array.isArray(yaExiste) && yaExiste.length > 0) {
      return { statusCode: 200, body: "ya procesado" };
    }

    // Ignorar pagos con monto cero (pings de prueba de MP)
    if (payment.transaction_amount <= 0) {
      return { statusCode: 200, body: "skipped: zero amount" };
    }

    await registrarVentaWeb({ paymentId, metadata, totalArs: payment.transaction_amount });

    const customerEmail = payment.payer?.email || "";
    const customerName  = metadata.customer_name || payment.payer?.first_name || "Cliente";
    const total         = `${payment.currency_id} ${payment.transaction_amount}`;
    const orderSummary   = metadata.order_summary   || "Ver detalle en MP";
    const deliveryMethod = metadata.delivery_method || "-";
    const deliveryDetails= metadata.delivery_details|| "-";

    const emailData = { customerName, orderSummary, deliveryMethod, deliveryDetails, total };
    const html = buildEmailHtml(emailData);

    // Email a la tienda
    const r1 = await sendEmail({
      to: process.env.STORE_EMAIL,
      subject: `[NUEVO PEDIDO] ${customerName} — ${total}`,
      html,
    });
    console.log("store email result:", r1);

    // Email al cliente
    if (customerEmail && customerEmail !== process.env.STORE_EMAIL) {
      const r2 = await sendEmail({
        to: customerEmail,
        subject: "Cop or Drop — Confirmación de pedido",
        html,
      });
      console.log("customer email result:", r2);
    }

    return { statusCode: 200, body: "venta registrada y mails enviados" };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify(err.message) };
  }
};
