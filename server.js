import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';

const app = express();

/* ----------------------------------------------------
   🟦 SISTEMA DE MODOS: TEST vs LIVE  (del .env)
---------------------------------------------------- */

const STRIPE_MODE = process.env.STRIPE_MODE || "test";

console.log(`\n========================================`);
console.log(`🔵 Modo Stripe activo: ${STRIPE_MODE.toUpperCase()}`);
console.log(`========================================\n`);

/* ----------------------------------------------------
   🟦 SELECCIÓN DINÁMICA DE CLAVES SEGÚN EL MODO
---------------------------------------------------- */

const STRIPE_SECRET_KEY =
  STRIPE_MODE === "live"
    ? process.env.STRIPE_SECRET_KEY_LIVE
    : process.env.STRIPE_SECRET_KEY_TEST;

const STRIPE_WEBHOOK_SECRET =
  STRIPE_MODE === "live"
    ? process.env.STRIPE_WEBHOOK_SECRET_LIVE
    : process.env.STRIPE_WEBHOOK_SECRET_TEST;

if (!STRIPE_SECRET_KEY) {
  console.error("❌ ERROR: No se ha definido STRIPE_SECRET_KEY_TEST/LIVE en .env");
  process.exit(1);
}

if (!STRIPE_WEBHOOK_SECRET) {
  console.error("❌ ERROR: No se ha definido STRIPE_WEBHOOK_SECRET_TEST/LIVE en .env");
  process.exit(1);
}

/* ----------------------------------------------------
   🟦 CONFIGURACIÓN STRIPE (TEST / LIVE)
---------------------------------------------------- */

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

/* ----------------------------------------------------
   🟦 CONFIGURACIÓN GENERAL EXPRESS
---------------------------------------------------- */
app.use(cors());

// Archivo local donde guardaremos los planes pagados
const DATA_FILE = path.join(process.cwd(), 'pagos.json');

/* ----------------------------------------------------
   🟦 FUNCIONES UTILITARIAS
---------------------------------------------------- */

function leerPagos() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('⚠️ Error leyendo pagos.json:', e);
    return {};
  }
}

function guardarPagos(pagos) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(pagos, null, 2), 'utf8');
    console.log('💾 pagos.json actualizado.');
  } catch (e) {
    console.error('⚠️ Error escribiendo pagos.json:', e);
  }
}

/* ----------------------------------------------------
   🟦 MAPEO DE PRECIOS SEGÚN EL MODO
---------------------------------------------------- */

const PRICE_MAP = {
  mini:
    STRIPE_MODE === "live"
      ? process.env.PRICE_MINI_LIVE
      : process.env.PRICE_MINI_TEST,

  base:
    STRIPE_MODE === "live"
      ? process.env.PRICE_BASE_LIVE
      : process.env.PRICE_BASE_TEST,

  pro:
    STRIPE_MODE === "live"
      ? process.env.PRICE_PRO_LIVE
      : process.env.PRICE_PRO_TEST,
};

console.log("📦 PRICE_MAP cargado:");
console.log(PRICE_MAP);

/* ----------------------------------------------------
   🟥  WEBHOOK (antes de express.json()!!)
---------------------------------------------------- */

app.post(
  '/webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('❌ Firma inválida del webhook:', err.message);
      return res.sendStatus(400);
    }

    // Evento principal de suscripción completada
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { userId, plan } = session.metadata || {};

      console.log(`\n🎉 Pago confirmado (modo: ${STRIPE_MODE})`);
      console.log(`   → Usuario: ${userId}`);
      console.log(`   → Plan: ${plan}`);

      if (userId && plan) {
        const pagos = leerPagos();

        pagos[userId] = {
          plan,
          activo: true,
          fecha: new Date().toISOString(),
        };

        guardarPagos(pagos);
      } else {
        console.warn('⚠️ Webhook sin metadata userId/plan.');
      }
    }

    res.sendStatus(200);
  }
);

/* ----------------------------------------------------
   🟦 ACTIVAR JSON DESPUÉS DEL WEBHOOK
---------------------------------------------------- */
app.use(express.json());

/* ----------------------------------------------------
   🟦 CREAR SESIÓN DE CHECKOUT
---------------------------------------------------- */

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, userId } = req.body;
    console.log(`\n📦 Crear sesión → plan: ${plan}, userId: ${userId}`);

    const priceId = PRICE_MAP[plan?.toLowerCase()];

    if (!priceId) {
      return res.status(400).json({ error: '❌ Plan inválido' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.SUCCESS_BASE_URL}?plan=${plan}&success=true`,
      cancel_url: process.env.CANCEL_URL,
      metadata: { userId, plan },
    });

    console.log(`🧾 Sesión Stripe creada → ${session.id}`);

    res.json({ url: session.url });
  } catch (e) {
    console.error('❌ Error creando sesión:', e);
    res.status(500).json({
      error: e.message || 'Error creando sesión',
    });
  }
});

/* ----------------------------------------------------
   🟦 ENDPOINT: CONSULTAR ESTADO DEL USUARIO
---------------------------------------------------- */

app.get('/estado-usuario', (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'Falta userId' });
  }

  const pagos = leerPagos();

  if (!pagos[userId]) {
    return res.json({ activo: false });
  }

  return res.json(pagos[userId]);
});

/* ----------------------------------------------------
   🟦 LANZAR SERVIDOR
---------------------------------------------------- */

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Stripe (${STRIPE_MODE}) en puerto ${PORT}`);
  console.log(`📂 Archivo de pagos: ${DATA_FILE}`);
});
