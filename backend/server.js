require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const path = require("path");
const fs = require("fs");
const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");

const {
  PORT = 50589,
  HOST = "127.0.0.1",
  JWT_SECRET,
  STRIPE_SECRET_KEY,
} = process.env;

if (!JWT_SECRET || !STRIPE_SECRET_KEY) {
  console.error("JWT_SECRET or STRIPE_SECRET_KEY is missing in the .env file");
  process.exit(1);
}

const stripe = require("stripe")(STRIPE_SECRET_KEY);

const PRODUCTS = [
  {
    id: 1,
    name: "Gaming Laptop RTX 4060",
    price: 1299,
    img: "https://images.unsplash.com/photo-1630794180018-433d915c34ac",
  },
  {
    id: 2,
    name: "RGB Mechanical Keyboard Pro",
    price: 89,
    img: "https://images.unsplash.com/photo-1756694938681-23f28a08fdde",
  },
  {
    id: 3,
    name: "Gaming Mouse 16000 DPI",
    price: 49,
    img: "https://images.unsplash.com/photo-1629429408209-1f912961dbd8",
  },
  {
    id: 4,
    name: "27'' 144Hz Full HD Monitor",
    price: 249,
    img: "https://images.unsplash.com/photo-1674505921901-e54fe119f0a4",
  },
  {
    id: 5,
    name: "UltraSpeed 1TB NVMe SSD",
    price: 119,
    img: "https://images.unsplash.com/photo-1686705562930-4f3e46f620d8",
  },
  {
    id: 6,
    name: "7.1 Gaming Headset",
    price: 69,
    img: "https://images.unsplash.com/photo-1660391532247-4a8ad1060817",
  },
];
const PRODUCT_MAP = new Map(PRODUCTS.map((p) => [p.id, p]));

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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS carts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    items TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later" },
});

function sanitizeItems(raw) {
  if (!Array.isArray(raw)) return [];
  const merged = new Map();
  for (const it of raw) {
    const id = Number(it?.id);
    const qty = Math.floor(Number(it?.quantity));
    if (!PRODUCT_MAP.has(id) || !Number.isFinite(qty) || qty < 1) continue;
    merged.set(id, Math.min((merged.get(id) || 0) + qty, 99));
  }
  return [...merged].map(([id, quantity]) => ({ id, quantity }));
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

app.post("/api/register", authLimiter, async (req, res) => {
  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();
  const password = String(req.body?.password || "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Invalid email" });
  if (password.length < 8)
    return res
      .status(400)
      .json({ error: "Password must be at least 8 characters long" });

  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email))
    return res.status(409).json({ error: "That email is already registered" });

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
    return res.status(401).json({ error: "Incorrect email or password" });

  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token });
});

app.delete("/api/delete-account", auth, (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ?").run(req.user.uid);
  res.json({ ok: true });
});

app.get("/api/cart", auth, (req, res) => {
  const row = db
    .prepare("SELECT items FROM carts WHERE user_id = ?")
    .get(req.user.uid);
  const items = sanitizeItems(row ? JSON.parse(row.items) : []);
  res.json(
    items.map(({ id, quantity }) => ({ ...PRODUCT_MAP.get(id), quantity })),
  );
});

app.post("/api/cart", auth, (req, res) => {
  const items = sanitizeItems(req.body?.cart);
  db.prepare(
    `INSERT INTO carts (user_id, items, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET items = excluded.items, updated_at = CURRENT_TIMESTAMP`,
  ).run(req.user.uid, JSON.stringify(items));
  res.json({ ok: true });
});

app.post("/api/create-payment-intent", async (req, res) => {
  const items = sanitizeItems(req.body?.items);
  if (items.length === 0)
    return res.status(400).json({ error: "Cart is empty" });

  const amount = items.reduce(
    (sum, { id, quantity }) =>
      sum + Math.round(PRODUCT_MAP.get(id).price * 100) * quantity,
    0,
  );

  try {
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: "eur",
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error("Stripe error:", err.message);
    res.status(500).json({ error: "Error creating the payment" });
  }
});

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, HOST, () =>
  console.log(`WilkShop API running at http://${HOST}:${PORT}`),
);
