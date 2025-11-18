import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';

const app = express();

/* ----------------------------------------------------
   🟦 SISTEMA DE MODOS: TEST vs LIVE  (definido en .env)
---------------------------------------------------- */

const STRIPE_MODE = process.env.STRIPE_MODE || "test";

console.log(`\n========================================`);
console.log(`🔵 Stripe Mode: ${STRIPE_MODE.toUpperCase()}`);
console.log(`========================================\n`);

/* ----------------------------------------------------
   🟦 SELECCIÓN DE CLAVES SEGÚN EL MODO
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
  console.error("❌ Falta STRIPE_SECRET_KEY en .env");
  process.exit(1);
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.error("❌ Falta STRIPE_WEBHOOK_SECRET en .env");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

/* ----------------------------------------------------
   🟦 CONFIG EXPRESS
---------------------------------------------------- */

app.use(cors());
const DATA_FILE = path.join(process.cwd(), 'pagos.json');

/* ----------------------------------------------------
   🟦 UTILIDADES: leer / guardar pagos
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
   🟦 MAPEO DE PRECIOS (TEST / LIVE)
---------------------------------------------------- */

const PRICE_MAP = {
  mini: STRIPE_MODE === "live" ? process.env.PRICE_MINI_LIVE : process.env.PRICE_MINI_TEST,
  base: STRIPE_MODE === "live" ? process.env.PRICE_BASE_LIVE : process.env.PRICE_BASE_TEST,
  pro:  STRIPE_MODE === "live" ? process.env.PRICE_PRO_LIVE  : process.env.PRICE_PRO_TEST,
};

console.log("📦 PRICE_MAP:");
console.log(PRICE_MAP);

/* ----------------------------------------------------
   🟥 WEBHOOK (antes de express.json)
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

    /* ----------------------------------------------------
       🟦 checkout.session.completed → ACTIVAR PLAN
    ---------------------------------------------------- */
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { userId, plan } = session.metadata || {};

      console.log(`\n🎉 Pago completado (modo: ${STRIPE_MODE})`);
      console.log(`   → Usuario: ${userId}`);
      console.log(`   → Plan: ${plan}`);

      // 🟢 IMPORTANTE: añadir metadata a la suscripción real
      try {
        await stripe.subscriptions.update(session.subscription, {
          metadata: { userId, plan }
        });
        console.log("📝 Metadata añadida a la suscripción.");
      } catch (e) {
        console.error("❌ Error añadiendo metadata a la suscripción:", e);
      }

      if (userId && plan) {
        const pagos = leerPagos();

        pagos[userId] = {
          plan,
          activo: true,
          fecha: new Date().toISOString(),
        };

        guardarPagos(pagos);
      }
    }

    /* ----------------------------------------------------
       🟡 customer.subscription.deleted → CANCELACIÓN
    ---------------------------------------------------- */
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;

      console.log(`\n🟡 Suscripción cancelada → Usuario: ${userId}`);

      if (userId) {
        const pagos = leerPagos();

        pagos[userId] = {
          plan: 'freemium',
          activo: false,
          fecha: new Date().toISOString(),
        };

        guardarPagos(pagos);
      }
    }

    /* ----------------------------------------------------
       🔴 invoice.payment_failed → RENOVACIÓN FALLIDA
    ---------------------------------------------------- */
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const userId = invoice.metadata?.userId;

      console.log(`\n🔴 Fallo de pago → Usuario: ${userId}`);

      if (userId) {
        const pagos = leerPagos();

        pagos[userId] = {
          plan: 'freemium',
          activo: false,
          fecha: new Date().toISOString(),
        };

        guardarPagos(pagos);
      }
    }

    // Stripe siempre debe recibir confirmación
    res.sendStatus(200);
  }
);

/* ----------------------------------------------------
   🟦 ACTIVAR express.json DESPUÉS DEL WEBHOOK
---------------------------------------------------- */
app.use(express.json());

/* ----------------------------------------------------
   🟦 CREAR SESIÓN DE CHECKOUT
---------------------------------------------------- */

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, userId } = req.body;

    console.log(`\n📦 Crear sesión Stripe → plan: ${plan}, userId: ${userId}`);

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

    console.log(`🧾 Sesión creada → ${session.id}`);

    res.json({ url: session.url });
  } catch (e) {
    console.error('❌ Error creando sesión:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ----------------------------------------------------
   🟦 ENDPOINT ESTADO DEL USUARIO
---------------------------------------------------- */

app.get('/estado-usuario', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Falta userId' });

  const pagos = leerPagos();
  return res.json(pagos[userId] || { activo: false });
});

/* ----------------------------------------------------
   🟦 LANZAR SERVIDOR
---------------------------------------------------- */

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`🚀 Stripe Server (${STRIPE_MODE}) activo en puerto ${PORT}`);
  console.log(`📂 pagos.json en: ${DATA_FILE}`);
});

