require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const path = require("path");
const fs = require("fs");
const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const {
  PORT = 50589,
  HOST = "127.0.0.1",
  JWT_SECRET,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  DISCORD_WEBHOOK_URL,
  SMTP_HOST,
  SMTP_PORT = 587,
  SMTP_USER,
  SMTP_PASS,
  MAIL_FROM,
  SHOP_EMAIL = "contact@wilkcraft.work",
  SHOP_URL = "https://shop.wilkcraft.work",
} = process.env;

if (!JWT_SECRET || !STRIPE_SECRET_KEY) {
  console.error("JWT_SECRET or STRIPE_SECRET_KEY is missing in the .env file");
  process.exit(1);
}
if (!DISCORD_WEBHOOK_URL)
  console.warn(
    "DISCORD_WEBHOOK_URL no configurado: no habrá avisos en Discord",
  );

const stripe = require("stripe")(STRIPE_SECRET_KEY);

const mailer =
  SMTP_HOST && SMTP_USER && SMTP_PASS
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT),
        secure: Number(SMTP_PORT) === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      })
    : null;
if (!mailer)
  console.warn("SMTP no configurado: no se enviarán emails de confirmación");

const CATALOG = JSON.parse(
  fs.readFileSync(path.join(__dirname, "products.json"), "utf8"),
);
const SHOP = CATALOG.config;
const PRODUCT_MAP = new Map(CATALOG.products.map((p) => [p.id, p]));

const unitPrice = (p, materialId) =>
  p.price + (p.materials.find((m) => m.id === materialId)?.extra || 0);

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "shop.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS carts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    items TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_intent TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    customer TEXT NOT NULL,
    items TEXT NOT NULL,
    subtotal INTEGER NOT NULL,
    shipping INTEGER NOT NULL,
    total INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT
  );
`);

if (
  !db
    .prepare("PRAGMA table_info(users)")
    .all()
    .some((c) => c.name === "is_admin")
)
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");

db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
  );
`);
const addCol = (table, col, def) => {
  if (
    !db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === col)
  )
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
addCol("orders", "tracking", "TEXT");
addCol("orders", "carrier", "TEXT");
addCol("orders", "shipped_at", "TEXT");
addCol("orders", "user_id", "INTEGER");

const app = express();
app.set("trust proxy", 1);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const eur = (cents) =>
  (cents / 100).toLocaleString("es-ES", { style: "currency", currency: "EUR" });
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const orderNumber = (id) => `CAP-${String(id).padStart(5, "0")}`;

function addBusinessDays(n) {
  const d = new Date();
  let c = 0;
  while (c < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() % 6) c++;
  }
  return d;
}

function sanitizeItems(raw) {
  if (!Array.isArray(raw)) return [];
  const merged = new Map();
  for (const it of raw) {
    const p = PRODUCT_MAP.get(Number(it?.id));
    const qty = Math.floor(Number(it?.quantity));
    if (
      !p ||
      p.visible === false ||
      p.soldOut ||
      !Number.isFinite(qty) ||
      qty < 1
    )
      continue;
    const material = p.materials.some((m) => m.id === it.material)
      ? it.material
      : p.materials[0].id;
    const color = p.colors.some((c) => c.name === it.color)
      ? it.color
      : p.colors[0].name;
    const key = `${p.id}|${material}|${color}`;
    const prev = merged.get(key);
    merged.set(key, {
      id: p.id,
      material,
      color,
      quantity: Math.min((prev?.quantity || 0) + qty, 99),
    });
  }
  return [...merged.values()];
}

function describeItems(items) {
  return items.map((it) => {
    const p = PRODUCT_MAP.get(it.id);
    const unit = Math.round(unitPrice(p, it.material) * 100);
    return {
      name: p.name,
      material: p.materials.find((m) => m.id === it.material).label,
      color: it.color,
      qty: it.quantity,
      unit,
      line: unit * it.quantity,
    };
  });
}

function orderTotals(lines) {
  const subtotal = lines.reduce((s, l) => s + l.line, 0);
  const shipping =
    subtotal >= SHOP.freeShippingFrom * 100
      ? 0
      : Math.round(SHOP.shippingCost * 100);
  return { subtotal, shipping, total: subtotal + shipping };
}

function validateCustomer(c) {
  const clean = (v, n) =>
    String(v ?? "")
      .trim()
      .slice(0, n);
  const out = {
    name: clean(c?.name, 100),
    email: clean(c?.email, 150).toLowerCase(),
    phone: clean(c?.phone, 25),
    address: clean(c?.address, 200),
    postal: clean(c?.postal, 5),
    city: clean(c?.city, 80),
    province: clean(c?.province, 80),
  };
  if (out.name.length < 2) return { error: "Escribe tu nombre y apellidos" };
  if (!EMAIL_RE.test(out.email)) return { error: "Email no válido" };
  if (out.phone && !/^[+\d][\d\s().-]{7,}$/.test(out.phone))
    return { error: "Teléfono no válido" };
  if (out.address.length < 5) return { error: "Escribe tu dirección completa" };
  if (!/^\d{5}$/.test(out.postal))
    return { error: "El código postal debe tener 5 dígitos" };
  if (out.city.length < 2) return { error: "Escribe tu localidad" };
  if (out.province.length < 2) return { error: "Escribe tu provincia" };
  return { value: out };
}

async function sendDiscord(payload) {
  if (!DISCORD_WEBHOOK_URL) return;
  const r = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Capalab",
      allowed_mentions: { parse: [] },
      ...payload,
    }),
  });
  if (!r.ok) throw new Error(`Discord respondió ${r.status}`);
}

function notifyDiscordOrder(o) {
  const c = o.customer;
  const num = orderNumber(o.id);
  const units = o.items.reduce((s, l) => s + l.qty, 0);
  const isTest = STRIPE_SECRET_KEY.startsWith("sk_test");
  const stripeUrl = `https://dashboard.stripe.com/${isTest ? "test/" : ""}payments/${o.payment_intent}`;
  const day = (d) =>
    d.toLocaleDateString("es-ES", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  const eta = `${day(addBusinessDays(SHOP.leadDaysMin))} – ${day(addBusinessDays(SHOP.leadDaysMax))}`;

  const products = o.items
    .map(
      (l) =>
        `**${l.qty}×** ${l.name}\n┗ ${l.material} · ${l.color} — **${eur(l.line)}**`,
    )
    .join("\n\n");

  return sendDiscord({
    embeds: [
      {
        title: `🛒  Nuevo pedido ${num}`,
        url: stripeUrl,
        description: `✅ **Pago confirmado** · ${units} ${units === 1 ? "artículo" : "artículos"} · **${eur(o.total)}**`,
        color: 0xf97316,
        fields: [
          {
            name: "👤 Cliente",
            value: cut(
              `${c.name}\n${c.email}${c.phone ? "\n" + c.phone : ""}`,
              1024,
            ),
            inline: true,
          },
          {
            name: "📍 Enviar a",
            value: cut(
              `${c.address}\n${c.postal} ${c.city}\n${c.province}, España`,
              1024,
            ),
            inline: true,
          },
          { name: "🗓️ Entrega estimada", value: eta, inline: true },
          { name: "📦 Productos", value: cut(products, 1024) },
          {
            name: "💶 Resumen",
            value: `Subtotal: ${eur(o.subtotal)}\nEnvío: ${o.shipping ? eur(o.shipping) : "Gratis"}\n**Total: ${eur(o.total)}**`,
            inline: true,
          },
          {
            name: "💳 Pago",
            value: `[Ver en Stripe](${stripeUrl})\n\`${o.payment_intent}\``,
            inline: true,
          },
        ],
        footer: { text: `${SHOP.brand} · Pedidos` },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

async function emailOrderConfirmation(o) {
  if (!mailer) return;
  const c = o.customer;
  const num = orderNumber(o.id);
  const fmt = (d) =>
    d.toLocaleDateString("es-ES", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  const from = fmt(addBusinessDays(SHOP.leadDaysMin));
  const to = fmt(addBusinessDays(SHOP.leadDaysMax));
  const first = c.name.split(" ")[0];

  const rows = o.items
    .map(
      (l) => `<tr>
      <td style="padding:14px 0;border-bottom:1px solid #EEEBE3;font-size:15px;color:#16181D">
        <strong>${l.qty} × ${esc(l.name)}</strong><br>
        <span style="color:#5F646C;font-size:13px">${esc(l.material)} · ${esc(l.color)}</span>
      </td>
      <td align="right" style="padding:14px 0;border-bottom:1px solid #EEEBE3;font-size:15px;white-space:nowrap;color:#16181D">${eur(l.line)}</td>
    </tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  @media (max-width:520px){
    .col{display:block!important;width:100%!important;box-sizing:border-box}
    .gap{display:none!important}
    .pad{padding:24px 20px!important}
  }
</style></head>
<body style="margin:0;padding:0;background:#F1EFE9">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Hemos recibido tu pago. Pedido ${num} · ${eur(o.total)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1EFE9;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#16181D">

  <tr><td style="background:#1B1F27;padding:22px 32px" class="pad">
    <span style="font-size:24px;font-weight:bold;color:#ffffff;letter-spacing:-0.5px">${esc(SHOP.brand)}</span>
    <span style="color:#F97316;font-size:24px;font-weight:bold">.</span>
    <div style="color:#9AA0A8;font-size:13px;margin-top:2px">Impresión 3D hecha en taller</div>
  </td></tr>
  <tr><td style="background:#C2410C;height:4px;line-height:4px;font-size:0">&nbsp;</td></tr>

  <tr><td align="center" style="padding:36px 32px 8px" class="pad">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td align="center" width="60" height="60" style="width:60px;height:60px;border-radius:30px;background:#1F9D55;color:#ffffff;font-size:30px;line-height:60px;font-weight:bold">&#10003;</td>
    </tr></table>
    <h1 style="margin:18px 0 6px;font-size:26px;line-height:1.2;color:#16181D">¡Gracias por tu pedido, ${esc(first)}!</h1>
    <p style="margin:0;color:#5F646C;font-size:15px;line-height:1.5">Hemos recibido tu pago y tu pedido ya está en cola de impresión.</p>
    <p style="margin:16px 0 0"><span style="display:inline-block;background:#FDEEE3;color:#C2410C;font-weight:bold;font-size:14px;padding:7px 16px;border-radius:999px;letter-spacing:.5px">Pedido ${num}</span></p>
  </td></tr>

  <tr><td style="padding:24px 32px 4px" class="pad">
    <p style="margin:0 0 4px;font-size:13px;font-weight:bold;color:#5F646C;text-transform:uppercase;letter-spacing:1px">Tu pedido</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">
      <tr><td style="padding:5px 0;color:#5F646C;font-size:14px">Subtotal</td><td align="right" style="font-size:14px">${eur(o.subtotal)}</td></tr>
      <tr><td style="padding:5px 0;color:#5F646C;font-size:14px">Envío</td><td align="right" style="font-size:14px">${o.shipping ? eur(o.shipping) : "Gratis"}</td></tr>
      <tr><td style="padding:12px 0 0;border-top:2px solid #16181D;font-size:17px;font-weight:bold">Total <span style="font-size:12px;font-weight:normal;color:#5F646C">(IVA incluido)</span></td>
          <td align="right" style="padding:12px 0 0;border-top:2px solid #16181D;font-size:20px;font-weight:bold;color:#C2410C">${eur(o.total)}</td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:24px 32px 8px" class="pad">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td class="col" valign="top" width="50%" style="background:#FAFAF7;border:1px solid #EEEBE3;border-radius:12px;padding:16px">
        <p style="margin:0 0 6px;font-size:12px;font-weight:bold;color:#C2410C;text-transform:uppercase;letter-spacing:1px">&#128205; Dirección de envío</p>
        <p style="margin:0;font-size:14px;line-height:1.55;color:#3b4049">${esc(c.name)}<br>${esc(c.address)}<br>${esc(c.postal)} ${esc(c.city)}<br>${esc(c.province)}, España</p>
      </td>
      <td class="gap" width="12" style="width:12px;font-size:0">&nbsp;</td>
      <td class="col" valign="top" width="50%" style="background:#FAFAF7;border:1px solid #EEEBE3;border-radius:12px;padding:16px">
        <p style="margin:0 0 6px;font-size:12px;font-weight:bold;color:#C2410C;text-transform:uppercase;letter-spacing:1px">&#128666; Plazo estimado</p>
        <p style="margin:0;font-size:14px;line-height:1.55;color:#3b4049">Entre el <strong>${from}</strong> y el <strong>${to}</strong>.<br>Te avisaremos cuando salga con seguimiento.</p>
      </td>
    </tr></table>
  </td></tr>

  <tr><td align="center" style="padding:24px 32px 8px" class="pad">
    <p style="margin:0 0 14px;font-size:14px;color:#5F646C;line-height:1.5">¿Algo no encaja? Si la pieza llega defectuosa, la reimprimimos.</p>
    <a href="mailto:${esc(SHOP_EMAIL)}" style="display:inline-block;background:#C2410C;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 28px;border-radius:12px">Escríbenos</a>
  </td></tr>

  <tr><td style="padding:28px 32px 30px" class="pad">
    <p style="margin:0;border-top:1px solid #EEEBE3;padding-top:18px;font-size:12px;line-height:1.6;color:#8A8F97;text-align:center">
      Tienes 14 días naturales desde la recepción para desistir de la compra de productos de catálogo.
      Más detalles en nuestras <a href="${SHOP_URL}/conditions.html" style="color:#C2410C">Condiciones de compra</a>.<br>
      © ${new Date().getFullYear()} ${esc(SHOP.brand)} · ${esc(SHOP_EMAIL)}
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

  const text = [
    `${SHOP.brand} — Confirmación de pedido ${num}`,
    "",
    `Hola ${first}, hemos recibido tu pago y tu pedido ya está en cola de impresión.`,
    "",
    ...o.items.map(
      (l) =>
        `${l.qty} x ${l.name} (${l.material}, ${l.color}) - ${eur(l.line)}`,
    ),
    "",
    `Subtotal: ${eur(o.subtotal)}`,
    `Envío: ${o.shipping ? eur(o.shipping) : "Gratis"}`,
    `Total (IVA incluido): ${eur(o.total)}`,
    "",
    `Envío a: ${c.name}, ${c.address}, ${c.postal} ${c.city} (${c.province}), España`,
    `Plazo estimado: entre el ${from} y el ${to}.`,
    "",
    `¿Dudas? Responde a este email o escribe a ${SHOP_EMAIL}.`,
    `Condiciones de compra: ${SHOP_URL}/conditions.html`,
  ].join("\n");

  await mailer.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to: c.email,
    replyTo: SHOP_EMAIL,
    subject: `Confirmación de tu pedido ${num} – ${SHOP.brand}`,
    text,
    html,
  });
}

async function emailOrderShipped(o) {
  if (!mailer) return false;
  const c = o.customer;
  const num = orderNumber(o.id);
  const first = c.name.split(" ")[0];

  const box = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;background:#FAFAF7;border:1px solid #EEEBE3;border-radius:12px"><tr><td style="padding:16px;font-size:14px;line-height:1.8;color:#3b4049">
    <strong>Pedido:</strong> ${num}<br>
    ${o.carrier ? `<strong>Transportista:</strong> ${esc(o.carrier)}<br>` : ""}
    <strong>Seguimiento:</strong> ${o.tracking ? esc(o.tracking) : "no disponible"}<br>
    <strong>Entrega en:</strong> ${esc(c.address)}, ${esc(c.postal)} ${esc(c.city)}
  </td></tr></table>`;

  await mailer.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to: c.email,
    replyTo: SHOP_EMAIL,
    subject: `Tu pedido ${num} ha salido – ${SHOP.brand}`,
    text: [
      `¡Tu pedido ${num} ha salido, ${first}!`,
      o.carrier ? `Transportista: ${o.carrier}` : "",
      `Seguimiento: ${o.tracking || "no disponible"}`,
      `Entrega en: ${c.address}, ${c.postal} ${c.city}`,
      `¿Dudas? Escribe a ${SHOP_EMAIL}.`,
    ]
      .filter(Boolean)
      .join("\n"),
    html: emailLayout({
      preheader: `Tu pedido ${num} ya está en camino`,
      title: `¡Tu pedido ha salido, ${esc(first)}!`,
      intro: "Hemos terminado de imprimirlo y revisarlo. Ya está en camino.",
      bodyHtml: box,
      button: { label: "Ver mis pedidos", url: SHOP_URL },
    }),
  });
  return true;
}

function emailLayout({ preheader = "", title, intro, bodyHtml = "", button }) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1EFE9">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1EFE9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#16181D">
  <tr><td style="background:#1B1F27;padding:22px 32px"><span style="font-size:24px;font-weight:bold;color:#ffffff">${esc(SHOP.brand)}</span><span style="color:#F97316;font-size:24px;font-weight:bold">.</span></td></tr>
  <tr><td style="background:#C2410C;height:4px;line-height:4px;font-size:0">&nbsp;</td></tr>
  <tr><td style="padding:32px">
    <h1 style="margin:0 0 10px;font-size:24px;line-height:1.25">${title}</h1>
    <p style="margin:0;color:#5F646C;font-size:15px;line-height:1.6">${intro}</p>
    ${bodyHtml}
    ${button ? `<p style="margin:24px 0 0"><a href="${button.url}" style="display:inline-block;background:#C2410C;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 28px;border-radius:12px">${esc(button.label)}</a></p>` : ""}
  </td></tr>
  <tr><td style="padding:0 32px 28px"><p style="margin:0;border-top:1px solid #EEEBE3;padding-top:18px;font-size:12px;color:#8A8F97;text-align:center">© ${new Date().getFullYear()} ${esc(SHOP.brand)} · ${esc(SHOP_EMAIL)}</p></td></tr>
</table></td></tr></table></body></html>`;
}

async function emailPasswordReset(to, link) {
  await mailer.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to,
    subject: `Restablece tu contraseña – ${SHOP.brand}`,
    text: `Has pedido restablecer tu contraseña de ${SHOP.brand}.\nCrea una nueva aquí (caduca en 1 hora):\n${link}\n\nSi no has sido tú, ignora este email.`,
    html: emailLayout({
      preheader: "Enlace para crear una contraseña nueva",
      title: "Restablece tu contraseña",
      intro:
        "Hemos recibido una solicitud para cambiar la contraseña de tu cuenta.",
      bodyHtml: `<p style="margin:16px 0 0;color:#5F646C;font-size:13px;line-height:1.6">El enlace caduca en 1 hora. Si no has sido tú, ignora este email y tu contraseña seguirá igual.</p>`,
      button: { label: "Crear contraseña nueva", url: link },
    }),
  });
}

async function markPaid(paymentIntentId) {
  const order = db
    .prepare("SELECT * FROM orders WHERE payment_intent = ?")
    .get(paymentIntentId);
  if (!order) return null;

  const flipped = db
    .prepare(
      "UPDATE orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'",
    )
    .run(order.id).changes;

  if (flipped) {
    const o = {
      ...order,
      customer: JSON.parse(order.customer),
      items: JSON.parse(order.items),
    };
    Promise.allSettled([notifyDiscordOrder(o), emailOrderConfirmation(o)]).then(
      (results) =>
        results.forEach((r) => {
          if (r.status === "rejected")
            console.error(
              `Aviso del pedido ${orderNumber(order.id)} fallido:`,
              r.reason?.message || r.reason,
            );
        }),
    );
  }
  return order;
}

app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!STRIPE_WEBHOOK_SECRET)
      return res.status(404).json({ error: "No encontrado" });
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      return res.status(400).send("Invalid signature");
    }
    if (event.type === "payment_intent.succeeded") {
      try {
        await markPaid(event.data.object.id);
      } catch (err) {
        console.error("Webhook error:", err.message);
        return res.status(500).end();
      }
    }
    res.json({ received: true });
  },
);

app.use(express.json({ limit: "100kb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos, inténtalo más tarde" },
});

function optionalUid(req) {
  const h = req.headers.authorization || "";
  try {
    return jwt.verify(h.startsWith("Bearer ") ? h.slice(7) : h, JWT_SECRET).uid;
  } catch {
    return null;
  }
}

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos, inténtalo más tarde" },
});

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "No autorizado" });
  }
}

app.get("/api/products", (req, res) =>
  res.json({
    config: CATALOG.config,
    products: CATALOG.products.filter((p) => p.visible !== false),
  }),
);

app.post("/api/register", authLimiter, async (req, res) => {
  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();
  const password = String(req.body?.password || "");

  if (!EMAIL_RE.test(email))
    return res.status(400).json({ error: "Email no válido" });
  if (password.length < 8)
    return res
      .status(400)
      .json({ error: "La contraseña debe tener al menos 8 caracteres" });

  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email))
    return res.status(409).json({ error: "Ese email ya está registrado" });

  const hash = await bcrypt.hash(password, 12);
  const { lastInsertRowid } = db
    .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
    .run(email, hash);
  db.prepare("INSERT INTO carts (user_id, items) VALUES (?, '[]')").run(
    lastInsertRowid,
  );

  res.status(201).json({ ok: true });
});

app.post("/api/login", authLimiter, async (req, res) => {
  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();
  const password = String(req.body?.password || "");

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok)
    return res.status(401).json({ error: "Email o contraseña incorrectos" });

  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, isAdmin: !!user.is_admin });
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos, inténtalo más tarde" },
});

app.post("/api/forgot-password", forgotLimiter, async (req, res) => {
  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();
  if (!EMAIL_RE.test(email))
    return res.status(400).json({ error: "Email no válido" });
  res.json({ ok: true });

  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!user || !mailer) return;
  try {
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("DELETE FROM password_resets WHERE user_id = ?").run(user.id);
    db.prepare(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    ).run(user.id, sha256(token), Date.now() + 60 * 60 * 1000);
    await emailPasswordReset(email, `${SHOP_URL}/?reset=${token}`);
  } catch (err) {
    console.error("forgot-password error:", err.message);
  }
});

app.post("/api/reset-password", authLimiter, async (req, res) => {
  const token = String(req.body?.token || "");
  const password = String(req.body?.password || "");
  if (password.length < 8)
    return res
      .status(400)
      .json({ error: "La contraseña debe tener al menos 8 caracteres" });

  const row = /^[a-f0-9]{64}$/.test(token)
    ? db
        .prepare("SELECT * FROM password_resets WHERE token_hash = ?")
        .get(sha256(token))
    : null;
  if (!row || row.expires_at < Date.now())
    return res
      .status(400)
      .json({ error: "El enlace no es válido o ha caducado. Pide uno nuevo." });

  const hash = await bcrypt.hash(password, 12);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    hash,
    row.user_id,
  );
  db.prepare("DELETE FROM password_resets WHERE user_id = ?").run(row.user_id);
  res.json({ ok: true });
});

app.delete("/api/delete-account", auth, (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ?").run(req.user.uid);
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => {
  const u = db
    .prepare("SELECT email, is_admin FROM users WHERE id = ?")
    .get(req.user.uid);
  if (!u) return res.status(401).json({ error: "No autorizado" });
  res.json({ email: u.email, isAdmin: !!u.is_admin });
});

app.get("/api/cart", auth, (req, res) => {
  const row = db
    .prepare("SELECT items FROM carts WHERE user_id = ?")
    .get(req.user.uid);
  res.json(sanitizeItems(row ? JSON.parse(row.items) : []));
});

app.post("/api/cart", auth, (req, res) => {
  const items = sanitizeItems(req.body?.cart);
  db.prepare(
    `INSERT INTO carts (user_id, items, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET items = excluded.items, updated_at = CURRENT_TIMESTAMP`,
  ).run(req.user.uid, JSON.stringify(items));
  res.json({ ok: true });
});

app.post("/api/create-payment-intent", checkoutLimiter, async (req, res) => {
  const items = sanitizeItems(req.body?.items);
  if (items.length === 0)
    return res.status(400).json({ error: "El carrito está vacío" });
  if (req.body?.accepted !== true)
    return res.status(400).json({
      error:
        "Debes aceptar las condiciones de compra y la política de privacidad",
    });

  const { value: customer, error } = validateCustomer(req.body?.customer);
  if (error) return res.status(400).json({ error });

  const lines = describeItems(items);
  const totals = orderTotals(lines);

  try {
    const intent = await stripe.paymentIntents.create({
      amount: totals.total,
      currency: "eur",
      automatic_payment_methods: { enabled: true },
      description: `Pedido ${SHOP.brand}`,
      shipping: {
        name: customer.name,
        phone: customer.phone || undefined,
        address: {
          line1: customer.address,
          postal_code: customer.postal,
          city: customer.city,
          state: customer.province,
          country: "ES",
        },
      },
    });

    db.prepare(
      `INSERT INTO orders (payment_intent, email, customer, items, subtotal, shipping, total, user_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      intent.id,
      customer.email,
      JSON.stringify(customer),
      JSON.stringify(lines),
      totals.subtotal,
      totals.shipping,
      totals.total,
      optionalUid(req),
    );

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error("Stripe error:", err.message);
    res.status(500).json({ error: "Error al crear el pago" });
  }
});

app.get("/api/my-orders", auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, status, items, subtotal, shipping, total, created_at, tracking, carrier
       FROM orders WHERE user_id = ? AND status != 'pending' ORDER BY id DESC LIMIT 50`,
    )
    .all(req.user.uid);
  res.json(
    rows.map((o) => ({
      ...o,
      number: orderNumber(o.id),
      items: JSON.parse(o.items),
    })),
  );
});

app.post("/api/order-complete", checkoutLimiter, async (req, res) => {
  const id = String(req.body?.paymentIntentId || "");
  if (!/^pi_\w+$/.test(id))
    return res.status(400).json({ error: "Pago no válido" });
  try {
    const pi = await stripe.paymentIntents.retrieve(id);
    if (pi.status !== "succeeded")
      return res.status(409).json({ error: "El pago aún no está confirmado" });
    const order = await markPaid(id);
    if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
    res.json({ ok: true, orderNumber: orderNumber(order.id) });
  } catch (err) {
    console.error("order-complete error:", err.message);
    res.status(500).json({ error: "Error al confirmar el pedido" });
  }
});

const uploadsDir = path.join(dataDir, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    cb(null, /\.(stl|3mf|obj)$/i.test(file.originalname)),
}).single("file");

const quoteLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

app.post("/api/custom-request", quoteLimiter, (req, res) => {
  upload(req, res, (err) => {
    if (err)
      return res
        .status(400)
        .json({ error: "No se pudo subir el archivo (máx. 50 MB)" });

    const b = req.body || {};
    const email = String(b.email || "")
      .trim()
      .toLowerCase();
    const description = String(b.description || "")
      .trim()
      .slice(0, 2000);
    if (!EMAIL_RE.test(email))
      return res.status(400).json({ error: "Email no válido" });
    if (!req.file && description.length < 10)
      return res
        .status(400)
        .json({ error: "Sube un archivo STL o describe tu idea" });

    const entry = {
      date: new Date().toISOString(),
      email,
      name: String(b.name || "").slice(0, 100),
      material: String(b.material || "").slice(0, 20),
      color: String(b.color || "").slice(0, 40),
      quantity: Math.min(Math.max(parseInt(b.quantity) || 1, 1), 999),
      description,
      file: req.file ? req.file.filename : null,
      originalName: req.file ? req.file.originalname : null,
    };
    fs.appendFileSync(
      path.join(dataDir, "requests.jsonl"),
      JSON.stringify(entry) + "\n",
    );

    sendDiscord({
      embeds: [
        {
          title: "Nueva solicitud a medida",
          color: 0xf97316,
          fields: [
            {
              name: "Contacto",
              value: cut(
                `${entry.name || "(sin nombre)"}\n${entry.email}`,
                1024,
              ),
            },
            {
              name: "Detalles",
              value: cut(
                `Material: ${entry.material || "-"}\nColor: ${entry.color || "-"}\nCantidad: ${entry.quantity}`,
                1024,
              ),
            },
            {
              name: "Descripción",
              value: cut(entry.description || "(sin descripción)", 1024),
            },
            {
              name: "Archivo",
              value: entry.file
                ? cut(
                    `${entry.originalName}\nGuardado en data/uploads/${entry.file}`,
                    1024,
                  )
                : "Sin archivo",
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    }).catch((e) => console.error("Aviso a medida fallido:", e.message));

    res.status(201).json({ ok: true });
  });
});

const catalogClients = new Set();

app.get("/api/catalog-events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  catalogClients.add(res);
  req.on("close", () => catalogClients.delete(res));
});

setInterval(() => {
  for (const r of catalogClients) r.write(": ping\n\n");
}, 25000);

function broadcastCatalog() {
  for (const r of catalogClients)
    r.write(`event: catalog\ndata: ${Date.now()}\n\n`);
}

app.use(
  "/api/admin",
  require("./admin")({
    db,
    auth,
    CATALOG,
    PRODUCT_MAP,
    dataDir,
    orderNumber,
    sendShippedEmail: emailOrderShipped,
    onCatalogChange: broadcastCatalog,
  }),
);

app.use("/api", (req, res) => res.status(404).json({ error: "No encontrado" }));

app.listen(PORT, HOST, () =>
  console.log(`${SHOP.brand} API running at http://${HOST}:${PORT}`),
);
