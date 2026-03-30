const mongoose = require("mongoose");
const User = require("./models/User");

mongoose.connect("mongodb://127.0.0.1:27017/wilkshop");

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

require("dotenv").config();
const SECRET = process.env.JWT_SECRET;
const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

app.post("/api/create-payment-intent", async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "Carrito vacío" });
    }

    // Calculamos el total
    const amount = items.reduce((total, item) => {
      return total + item.price * item.quantity;
    }, 0);

    // Creamos el PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe usa céntimos
      currency: "eur",
      automatic_payment_methods: {
        enabled: true, // habilita tarjeta, Apple Pay, Google Pay automáticamente
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error("Error creando PaymentIntent:", error);
    res.status(500).json({ error: "Error creando el pago" });
  }
});

app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;

  const existingUser = await User.findOne({ email });

  if (existingUser) {
    return res.status(400).json({ error: "El usuario ya existe" });
  }

  const hashed = await bcrypt.hash(password, 10);

  const user = new User({
    email,
    password: hashed,
    cart: [],
  });

  await user.save();

  res.json({ message: "Usuario creado" });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });

  if (!user) return res.status(400).json({ error: "No existe" });

  const valid = await bcrypt.compare(password, user.password);

  if (!valid) return res.status(400).json({ error: "Contraseña incorrecta" });

  const token = jwt.sign({ id: user._id }, SECRET);

  res.json({ token });
});

function auth(req, res, next) {
  const token = req.headers.authorization;

  if (!token) return res.status(401).json({ error: "No autorizado" });

  try {
    const decoded = jwt.verify(token, SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
}

app.post("/api/cart", auth, async (req, res) => {
  const user = await User.findById(req.userId);

  user.cart = req.body.cart;
  await user.save();

  res.json({ message: "Carrito guardado" });
});

app.get("/api/cart", auth, async (req, res) => {
  const user = await User.findById(req.userId);

  res.json(user.cart);
});

const PORT = 50589;

app.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
});
