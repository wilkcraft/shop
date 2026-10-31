// backend/admin.js — rutas del panel de administración (/api/admin/*)
const express = require("express");
const fs = require("fs");
const path = require("path");

module.exports = function adminRouter({
  db,
  auth,
  CATALOG,
  PRODUCT_MAP,
  dataDir,
  orderNumber,
}) {
  const router = express.Router();
  const uploadsDir = path.join(dataDir, "uploads");
  const PRODUCTS_FILE = path.join(__dirname, "products.json");
  const STATUSES = [
    "pending",
    "paid",
    "printing",
    "shipped",
    "delivered",
    "cancelled",
  ];

  // Solo usuarios logueados Y con is_admin = 1 (se comprueba en la BD en cada petición)
  router.use(auth, (req, res, next) => {
    const u = db
      .prepare("SELECT is_admin FROM users WHERE id = ?")
      .get(req.user.uid);
    if (!u || !u.is_admin)
      return res.status(403).json({ error: "Acceso denegado" });
    next();
  });

  // ---------- Pedidos ----------
  router.get("/orders", (req, res) => {
    const rows = db
      .prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 500")
      .all();
    res.json(
      rows.map((o) => ({
        ...o,
        number: orderNumber(o.id),
        customer: JSON.parse(o.customer),
        items: JSON.parse(o.items),
      })),
    );
  });

  router.patch("/orders/:id", (req, res) => {
    const status = req.body?.status;
    if (!STATUSES.includes(status))
      return res.status(400).json({ error: "Estado no válido" });
    const r = db
      .prepare("UPDATE orders SET status = ? WHERE id = ?")
      .run(status, Number(req.params.id));
    if (!r.changes)
      return res.status(404).json({ error: "Pedido no encontrado" });
    res.json({ ok: true });
  });

  // ---------- Solicitudes a medida ----------
  function readRequests() {
    const f = path.join(dataDir, "requests.jsonl");
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  }

  router.get("/requests", (req, res) => res.json(readRequests()));

  router.get("/requests/:file/download", (req, res) => {
    const file = path.basename(req.params.file);
    const entry = readRequests().find((r) => r.file === file);
    const full = path.join(uploadsDir, file);
    if (!entry || !fs.existsSync(full))
      return res.status(404).json({ error: "Archivo no encontrado" });
    res.download(full, entry.originalName || file);
  });

  // ---------- Usuarios ----------
  router.get("/users", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT id, email, is_admin, created_at FROM users ORDER BY id DESC",
        )
        .all(),
    ),
  );

  router.patch("/users/:id", (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.uid)
      return res.status(400).json({ error: "No puedes cambiar tu propio rol" });
    const r = db
      .prepare("UPDATE users SET is_admin = ? WHERE id = ?")
      .run(req.body?.isAdmin === true ? 1 : 0, id);
    if (!r.changes)
      return res.status(404).json({ error: "Usuario no encontrado" });
    res.json({ ok: true });
  });

  // ---------- Productos (products.json) ----------
  const txt = (v, n) =>
    String(v ?? "")
      .replace(/[<>"]/g, "")
      .trim()
      .slice(0, n);
  const money = (v) => Math.round(Number(v) * 100) / 100;

  function cleanProduct(b) {
    const p = {
      name: txt(b?.name, 100),
      category: txt(b?.category, 30),
      price: money(b?.price),
      tag: txt(b?.tag, 20),
      img: String(b?.img ?? "")
        .trim()
        .slice(0, 300),
      benefit: txt(b?.benefit, 200),
      materials: (Array.isArray(b?.materials) ? b.materials : [])
        .slice(0, 6)
        .map((m) => ({
          id: txt(m?.id, 20)
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, ""),
          label: txt(m?.label, 30),
          extra: money(m?.extra || 0),
        }))
        .filter(
          (m) => m.id && m.label && Number.isFinite(m.extra) && m.extra >= 0,
        ),
      colors: (Array.isArray(b?.colors) ? b.colors : [])
        .slice(0, 12)
        .map((c) => ({
          name: txt(c?.name, 30),
          hex: String(c?.hex || "").trim(),
        }))
        .filter((c) => c.name && /^#[0-9a-fA-F]{6}$/.test(c.hex)),
      specs: Object.fromEntries(
        Object.entries(b?.specs && typeof b.specs === "object" ? b.specs : {})
          .slice(0, 10)
          .map(([k, v]) => [txt(k, 30), txt(v, 100)])
          .filter(([k, v]) => k && v),
      ),
    };
    if (p.name.length < 2) return { error: "Escribe el nombre del producto" };
    if (!CATALOG.config.categories.some((c) => c.id === p.category))
      return { error: "Categoría no válida" };
    if (!Number.isFinite(p.price) || p.price <= 0)
      return { error: "Precio no válido" };
    if (p.img && !/^(\/|https:\/\/)[^\s"'<>]*$/.test(p.img))
      return {
        error: "La imagen debe ser una ruta (/img/...) o una URL https",
      };
    if (!p.materials.length) return { error: "Añade al menos un material" };
    if (new Set(p.materials.map((m) => m.id)).size !== p.materials.length)
      return { error: "Hay materiales con el mismo id" };
    if (!p.colors.length)
      return { error: "Añade al menos un color con formato Nombre | #RRGGBB" };
    if (new Set(p.colors.map((c) => c.name)).size !== p.colors.length)
      return { error: "Hay colores con el mismo nombre" };
    return { value: p };
  }

  function saveCatalog() {
    fs.writeFileSync(PRODUCTS_FILE + ".tmp", JSON.stringify(CATALOG, null, 2));
    fs.renameSync(PRODUCTS_FILE + ".tmp", PRODUCTS_FILE);
    PRODUCT_MAP.clear();
    CATALOG.products.forEach((p) => PRODUCT_MAP.set(p.id, p));
  }

  router.post("/products", (req, res) => {
    const { value, error } = cleanProduct(req.body);
    if (error) return res.status(400).json({ error });
    const id = Math.max(0, ...CATALOG.products.map((p) => p.id)) + 1;
    CATALOG.products.push({ id, ...value });
    saveCatalog();
    res.status(201).json({ id });
  });

  router.put("/products/:id", (req, res) => {
    const id = Number(req.params.id);
    const i = CATALOG.products.findIndex((p) => p.id === id);
    if (i < 0) return res.status(404).json({ error: "Producto no encontrado" });
    const { value, error } = cleanProduct(req.body);
    if (error) return res.status(400).json({ error });
    CATALOG.products[i] = { id, ...value };
    saveCatalog();
    res.json({ ok: true });
  });

  router.delete("/products/:id", (req, res) => {
    const id = Number(req.params.id);
    const i = CATALOG.products.findIndex((p) => p.id === id);
    if (i < 0) return res.status(404).json({ error: "Producto no encontrado" });
    CATALOG.products.splice(i, 1);
    saveCatalog();
    res.json({ ok: true });
  });

  return router;
};
