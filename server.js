import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import bodyParser from 'body-parser';

/* ----------------------------------------------------
   🟦 FIREBASE ADMIN
---------------------------------------------------- */
import admin from 'firebase-admin';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const pagosRef = db.collection("pagos");

/* ----------------------------------------------------
   🟦 FUNCIONES FIRESTORE (Reemplazan pagos.json)
---------------------------------------------------- */
async function leerPago(userId) {
  try {
    const doc = await pagosRef.doc(userId).get();
    return doc.exists ? doc.data() : null;
  } catch (e) {
    console.error("❌ Error leyendo Firestore:", e);
    return null;
  }
}

async function guardarPago(userId, data) {
  try {
    await pagosRef.doc(userId).set(data, { merge: true });
    console.log("💾 Firestore actualizado:", data);
  } catch (e) {
    console.error("❌ Error escribiendo en Firestore:", e);
  }
}

/* ----------------------------------------------------
   🟦 SISTEMA DE MODOS
---------------------------------------------------- */
const app = express();
const STRIPE_MODE = process.env.STRIPE_MODE || "test";

console.log(`\n========================================`);
console.log(`🔵 Stripe Mode: ${STRIPE_MODE.toUpperCase()}`);
console.log(`========================================\n`);

const STRIPE_SECRET_KEY =
  STRIPE_MODE === "live"
    ? process.env.STRIPE_SECRET_KEY_LIVE
    : process.env.STRIPE_SECRET_KEY_TEST;

const STRIPE_WEBHOOK_SECRET =
  STRIPE_MODE === "live"
    ? process.env.STRIPE_WEBHOOK_SECRET_LIVE
    : process.env.STRIPE_WEBHOOK_SECRET_TEST;

if (!STRIPE_SECRET_KEY) { console.error("❌ Falta STRIPE_SECRET_KEY"); process.exit(1); }
if (!STRIPE_WEBHOOK_SECRET) { console.error("❌ Falta STRIPE_WEBHOOK_SECRET"); process.exit(1); }

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

app.use(cors());

/* ----------------------------------------------------
   🟦 PRICE MAP
---------------------------------------------------- */
const PRICE_MAP = {
  mini: STRIPE_MODE === "live" ? process.env.PRICE_MINI_LIVE : process.env.PRICE_MINI_TEST,
  base: STRIPE_MODE === "live" ? process.env.PRICE_BASE_LIVE : process.env.PRICE_BASE_TEST,
  pro:  STRIPE_MODE === "live" ? process.env.PRICE_PRO_LIVE  : process.env.PRICE_PRO_TEST,
};

console.log("📦 PRICE_MAP:", PRICE_MAP);

/* ----------------------------------------------------
   🟥  WEBHOOK (antes de express.json)
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
      console.error("❌ Webhook signature error:", err.message);
      return res.sendStatus(400);
    }

    /* ----------------------------------------------------
       🟦 checkout.session.completed → ACTIVAR PLAN
    ---------------------------------------------------- */
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('\n🧾 [WEBHOOK] checkout.session.completed recibido:');
      console.log('   id sesión:', session.id);
      console.log('   metadata:', session.metadata);
      console.log('   customer:', session.customer);
      console.log('   subscription:', session.subscription);

      const { userId, plan } = session.metadata || {};
      let customerId = session.customer || null;

      if (!customerId && session.subscription) {
        try {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          customerId = sub.customer;
          console.log('   ✅ customerId obtenido desde subscription:', customerId);
        } catch (e) {
          console.error('   ❌ Error recuperando subscription para customerId:', e.message);
        }
      }

      console.log(`\n🎉 Pago completado (modo: ${STRIPE_MODE})`);
      console.log(`   → userId: ${userId}`);
      console.log(`   → plan: ${plan}`);
      console.log(`   → customerId final: ${customerId}`);

      if (session.subscription && (userId || plan)) {
        try {
          await stripe.subscriptions.update(session.subscription, {
            metadata: { userId, plan },
          });
          console.log('   📝 Metadata añadida a la suscripción.');
        } catch (e) {
          console.error('   ❌ Error añadiendo metadata a la suscripción:', e.message);
        }
      }

      if (userId && plan) {
        await guardarPago(userId, {
          plan: plan,
          activo: true,
          customerId: customerId || null,
          fecha: new Date().toISOString(),
        });
        console.log('   💾 Pago registrado en Firestore');
      }
    }

    /* ----------------------------------------------------
       🟡 customer.subscription.deleted → CANCELADA AL FINAL DEL PERIODO
    ---------------------------------------------------- */
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      const customerId = subscription.customer;

      console.log(`\n🟡 Suscripción eliminada definitivamente:`);
      console.log(`   → Usuario: ${userId}`);
      console.log(`   → Customer: ${customerId}`);
      console.log(`   → Status: ${subscription.status}`);
      console.log(`   → Ended at: ${subscription.ended_at}`);
      console.log(`   → Current period end: ${subscription.current_period_end}`);

      // ✅ SOLO revertir a freemium cuando la suscripción REALMENTE ha terminado
      if (userId && subscription.status === 'canceled' && subscription.ended_at) {
        await guardarPago(userId, {
          plan: "freemium",
          activo: false,
          customerId: null,
          fecha: new Date().toISOString(),
        });
        console.log('   💾 Usuario revertido a freemium - Suscripción terminada');
      } else {
        console.log('   ⏰ Suscripción marcada para cancelar - Usuario mantiene acceso');
      }
    }

    /* ----------------------------------------------------
       🔄 NUEVO: customer.subscription.updated → MONITOREAR CAMBIOS
    ---------------------------------------------------- */
    if (event.type === 'customer.subscription.updated') {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      const customerId = subscription.customer;

      console.log(`\n🔄 Suscripción actualizada:`);
      console.log(`   → Usuario: ${userId}`);
      console.log(`   → Status: ${subscription.status}`);
      console.log(`   → Cancel at period end: ${subscription.cancel_at_period_end}`);
      console.log(`   → Current period end: ${subscription.current_period_end}`);

      // ✅ DETECTAR cancelación programada (cancel_at_period_end = true)
      if (userId && subscription.cancel_at_period_end) {
        // Suscripción cancelada pero activa hasta fin de periodo
        const datosPago = await leerPago(userId);
        if (datosPago) {
          await guardarPago(userId, {
            ...datosPago,
            cancelacion_programada: true,
            fecha_expiracion: new Date(subscription.current_period_end * 1000).toISOString(),
            fecha_cancelacion_solicitada: new Date().toISOString(),
          });
          console.log('   📅 Cancelación programada registrada - Plan sigue activo');
        }
      }
      
      // ✅ DETECTAR cuando la suscripción se vuelve inactiva
      if (userId && subscription.status === 'canceled') {
        await guardarPago(userId, {
          plan: "freemium",
          activo: false,
          customerId: null,
          fecha: new Date().toISOString(),
        });
        console.log('   💾 Usuario revertido a freemium - Suscripción cancelada definitivamente');
      }
    }

    return res.sendStatus(200);
  }
);

/* ----------------------------------------------------
   🟦 express.json()
---------------------------------------------------- */
app.use(express.json());

/* ----------------------------------------------------
   🟦 CREAR SESIÓN CHECKOUT
---------------------------------------------------- */
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, userId } = req.body;

    console.log(`\n💳 [CHECKOUT] Creando sesión:`);
    console.log(`   → Plan: ${plan}`);
    console.log(`   → UserID: ${userId}`);

    const priceId = PRICE_MAP[plan];
    if (!priceId) {
      console.error(`❌ Plan inválido: ${plan}`);
      return res.status(400).json({ error: "Plan inválido" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.SUCCESS_BASE_URL}?plan=${plan}&success=true`,
      cancel_url: process.env.CANCEL_URL,
      metadata: { userId, plan },
      subscription_data: {
        metadata: { userId, plan }
      }
    });

    console.log(`✅ [CHECKOUT] Sesión creada: ${session.id}`);
    res.json({ url: session.url });

  } catch (e) {
    console.error(`❌ [CHECKOUT] Error:`, e.message);
    return res.status(500).json({ error: e.message });
  }
});

/* ----------------------------------------------------
   🟦 PORTAL FACTURACIÓN
---------------------------------------------------- */
app.post('/stripe-portal', async (req, res) => {
  try {
    const { customerId } = req.body;

    console.log(`\n🏛️ [PORTAL] Generando portal para: ${customerId}`);

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.SUCCESS_BASE_URL,
    });

    console.log(`✅ [PORTAL] Portal generado: ${portalSession.url}`);
    res.json({ url: portalSession.url });

  } catch (e) {
    console.error(`❌ [PORTAL] Error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ----------------------------------------------------
   🟦 ESTADO DEL USUARIO – Firestore
---------------------------------------------------- */
app.get('/user/:userId/status', async (req, res) => {
  const { userId } = req.params;

  console.log(`\n📋 [STATUS] Consultando estado para userId: ${userId}`);

  const data = await leerPago(userId);

  if (!data) {
    const fallback = {
      plan: 'freemium',
      activo: false,
      customerId: null,
      fecha: new Date().toISOString(),
    };
    console.log(`📊 [STATUS] Respuesta para ${userId}:`, fallback);
    return res.json(fallback);
  }

  console.log(`📊 [STATUS] Respuesta para ${userId}:`, data);
  res.json(data);
});

/* ----------------------------------------------------
   🟦 SERVER
---------------------------------------------------- */
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Stripe (${STRIPE_MODE}) en puerto ${PORT}`);
});
