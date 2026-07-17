const https = require("https");

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
    console.log("payer:", JSON.stringify(payment.payer));

    if (payment.status !== "approved") {
      return { statusCode: 200, body: "payment not approved" };
    }

    const customerEmail = payment.payer?.email || "";
    const customerName  = payment.payer?.first_name || "Cliente";
    const total         = `${payment.currency_id} ${payment.transaction_amount}`;
    const metadata      = payment.metadata || {};
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

    return { statusCode: 200, body: "emails sent" };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify(err.message) };
  }
};
