import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';

const app = express();

/* ----------------------------------------------------
   🟦 SISTEMA DE MODOS
---------------------------------------------------- */
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
const DATA_FILE = path.join(process.cwd(), 'pagos.json');

/* ----------------------------------------------------
   🟦 UTILIDADES
---------------------------------------------------- */

function leerPagos() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error("⚠️ Error leyendo pagos.json:", e);
    return {};
  }
}

function guardarPagos(pagos) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(pagos, null, 2), 'utf8');
    console.log("💾 pagos.json actualizado.");
  } catch (e) {
    console.error("⚠️ Error escribiendo pagos.json:", e);
  }
}

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
       🟦 checkout.session.completed → ACTIVAR PLAN - MEJORADO
    ---------------------------------------------------- */
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // 🔍 Log completo para depurar
      console.log('\n🧾 [WEBHOOK] checkout.session.completed recibido:');
      console.log('   id sesión:', session.id);
      console.log('   metadata:', session.metadata);
      console.log('   customer:', session.customer);
      console.log('   subscription:', session.subscription);

      const { userId, plan } = session.metadata || {};

      // 🟢 Obtener customerId de forma robusta
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

      // 🆕 Añadir metadata a la suscripción real (CRÍTICO para futuros eventos)
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

      // 🎯 GUARDAR EN PAGOS.JSON - ESTRUCTURA EXACTA REQUERIDA
      if (userId && plan) {
        const pagos = leerPagos();

        pagos[userId] = {
          plan: plan,
          activo: true,
          customerId: customerId || null,
          fecha: new Date().toISOString(),
        };

        guardarPagos(pagos);
        console.log('   💾 Pago registrado en pagos.json');
        console.log('   📋 Estructura guardada:', pagos[userId]);
      } else {
        console.warn('⚠️ Webhook sin metadata válida userId/plan.');
      }
    }

    /* ----------------------------------------------------
       🟡 customer.subscription.deleted → CANCELADA - MEJORADO
    ---------------------------------------------------- */
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      const customerId = subscription.customer;

      console.log(`\n🟡 Suscripción cancelada:`);
      console.log(`   → Usuario: ${userId}`);
      console.log(`   → Customer: ${customerId}`);

      if (userId) {
        const pagos = leerPagos();
        
        // 🆕 ESTRUCTURA EXACTA para cancelación
        pagos[userId] = {
          plan: 'freemium',
          activo: false,
          customerId: null, // 🔥 ELIMINAR customerId en cancelación
          fecha: new Date().toISOString(),
        };
        
        guardarPagos(pagos);
        console.log('   💾 Usuario revertido a freemium en pagos.json');
      }
    }

    /* ----------------------------------------------------
       🔴 invoice.payment_failed → FALLÓ RENOVACIÓN - MEJORADO
    ---------------------------------------------------- */
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      
      // 🆕 Obtener userId desde metadata de la suscripción
      let userId = invoice.metadata?.userId;
      
      if (!userId && invoice.subscription) {
        try {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          userId = sub.metadata?.userId;
        } catch (e) {
          console.error('   ❌ Error obteniendo metadata de suscripción:', e.message);
        }
      }

      console.log(`\n🔴 Renovación fallida:`);
      console.log(`   → Usuario: ${userId}`);
      console.log(`   → Factura: ${invoice.id}`);

      if (userId) {
        const pagos = leerPagos();
        
        // 🆕 ESTRUCTURA EXACTA para fallo de pago
        pagos[userId] = {
          plan: 'freemium',
          activo: false,
          customerId: null, // 🔥 ELIMINAR customerId en fallo de pago
          fecha: new Date().toISOString(),
        };
        
        guardarPagos(pagos);
        console.log('   💾 Usuario revertido a freemium por fallo de pago');
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
   🟦 CREAR SESIÓN CHECKOUT - MEJORADO
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

    // 🆕 ASEGURAR que metadata se incluye SIEMPRE
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.SUCCESS_BASE_URL}?plan=${plan}&success=true`,
      cancel_url: process.env.CANCEL_URL,
      metadata: { 
        userId: userId,
        plan: plan 
      }, // 🔥 CRÍTICO: metadata siempre presente
      subscription_data: {
        metadata: {
          userId: userId,
          plan: plan
        }
      }, // 🆕 También en subscription_data para mayor seguridad
    });

    console.log(`✅ [CHECKOUT] Sesión creada: ${session.id}`);
    console.log(`📋 [CHECKOUT] Metadata incluida: userId=${userId}, plan=${plan}`);

    res.json({ url: session.url });

  } catch (e) {
    console.error(`❌ [CHECKOUT] Error:`, e.message);
    return res.status(500).json({ error: e.message });
  }
});

/* ----------------------------------------------------
   🟦 PORTAL FACTURACIÓN - SIN CAMBIOS
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
   🟦 ESTADO DEL USUARIO - ENDPOINT CORREGIDO
---------------------------------------------------- */
app.get('/user/:userId/status', (req, res) => {
  const { userId } = req.params;
  
  console.log(`\n📋 [STATUS] Consultando estado para userId: ${userId}`);
  
  const pagos = leerPagos();
  const data = pagos[userId] || { 
    plan: 'freemium', 
    activo: false, 
    customerId: null,
    fecha: new Date().toISOString()
  };

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




