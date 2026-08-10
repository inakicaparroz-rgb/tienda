const https = require("https");

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

  const { items, payer, back_urls, metadata } = payload;
  if (!Array.isArray(items) || items.length === 0) {
    return { statusCode: 400, body: "Missing items" };
  }

  try {
    const { status, body } = await httpPost(
      "https://api.mercadopago.com/checkout/preferences",
      process.env.MP_ACCESS_TOKEN,
      {
        items,
        payer,
        back_urls,
        auto_return: "approved",
        statement_descriptor: "COP OR DROP",
        notification_url: "https://lively-pavlova-251852.netlify.app/.netlify/functions/mp-webhook",
        metadata,
      }
    );
    return { statusCode: status, headers: { "Content-Type": "application/json" }, body };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
