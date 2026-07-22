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

function sendEmail(params) {
  const body = JSON.stringify({
    service_id: process.env.EMAILJS_SERVICE,
    template_id: process.env.EMAILJS_TEMPLATE,
    user_id: process.env.EMAILJS_PUBKEY,
    template_params: params,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.emailjs.com",
      path: "/api/v1.0/email/send",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 200, body: "OK" };

  try {
    const payload = JSON.parse(event.body || "{}");

    // MP manda topic=payment cuando se aprueba un pago
    if (payload.type !== "payment" && payload.topic !== "payment") {
      return { statusCode: 200, body: "ignored" };
    }

    const paymentId = payload.data?.id || payload.id;
    if (!paymentId) return { statusCode: 200, body: "no payment id" };

    // Obtenemos los detalles del pago
    const payment = await httpGet(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      process.env.MP_ACCESS_TOKEN
    );

    if (payment.status !== "approved") {
      return { statusCode: 200, body: "payment not approved" };
    }

    const customerEmail = payment.payer?.email || "";
    const customerName  = payment.payer?.first_name || "Cliente";
    const total         = `${payment.currency_id} ${payment.transaction_amount}`;

    // Recuperamos los datos del pedido guardados en metadata
    const metadata = payment.metadata || {};
    const orderSummary   = metadata.order_summary   || "Ver detalle en MP";
    const deliveryMethod = metadata.delivery_method || "-";
    const deliveryDetails= metadata.delivery_details|| "-";

    const templateParams = {
      customer_name:    customerName,
      order_summary:    orderSummary + `\n\nTOTAL PAGADO: ${total}`,
      delivery_method:  deliveryMethod,
      delivery_details: deliveryDetails,
    };

    // Email a la tienda
    await sendEmail({ ...templateParams, to_email: process.env.STORE_EMAIL });

    // Email al cliente si tiene email
    if (customerEmail && customerEmail !== process.env.STORE_EMAIL) {
      await sendEmail({ ...templateParams, to_email: customerEmail });
    }

    return { statusCode: 200, body: "emails sent" };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "error" };
  }
};
