import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';                     
import path from 'path';

const app = express();

// --- CONFIGURACIÓN STRIPE ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// --- CONFIGURACIÓN GENERAL ---
app.use(cors());

// 📂 Archivo local donde guardaremos los planes pagados
const DATA_FILE = path.join(process.cwd(), 'pagos.json');

// Utilidad para leer pagos guardados
function leerPagos() {
  if (!fs.existsSync(DATA_FILE)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('⚠️ Error leyendo pagos.json:', e);
    return {};
  }
}

// Utilidad para guardar pagos
function guardarPagos(pagos) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(pagos, null, 2), 'utf8');
    console.log('💾 pagos.json actualizado.');
  } catch (e) {
    console.error('⚠️ Error escribiendo pagos.json:', e);
  }
}

// --- MAPEO DE PLANES Y PRECIOS (IDs reales en Stripe) ---
const PRICE_MAP = {
  mini: 'price_1SSF5CFnbJHY3wka6TBnfrTt',  // ARVI Mini
  base: 'price_1SSF5tFnbJHY3wkatvx4vmUB',  // ARVI Base
  pro:  'price_1SSF6oFnbJHY3wka81bfgqDc',  // ARVI Pro
};

// --- WEBHOOK DE CONFIRMACIÓN STRIPE ---
// ⚠️ Debe ir ANTES del express.json() para que conserve el raw body
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('⚠️ Firma inválida del webhook:', err.message);
    return res.sendStatus(400);
  }

  // Solo nos interesa cuando el pago se ha completado correctamente
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, plan } = session.metadata || {};

    console.log(`✅ Pago confirmado → Usuario: ${userId}, Plan: ${plan}`);

    if (userId && plan) {
      const pagos = leerPagos();

      pagos[userId] = {
        plan,
        activo: true,
        fecha: new Date().toISOString(),
      };

      guardarPagos(pagos);
    } else {
      console.warn('⚠️ Webhook sin metadata userId/plan. No se guarda nada.');
    }
  }

  res.sendStatus(200);
});

// --- APLICAR JSON DESPUÉS DEL WEBHOOK ---
app.use(express.json());

// --- VALIDACIÓN PREVIA DE URLS ---
if (!process.env.SUCCESS_BASE_URL?.startsWith('https')) {
  console.warn(
    '⚠️ Advertencia: SUCCESS_BASE_URL no es HTTPS. Stripe podría rechazar la sesión.'
  );
}

// --- CREAR SESIÓN DE CHECKOUT ---
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, userId } = req.body;
    console.log(`📦 Solicitud de sesión → plan: ${plan}, usuario: ${userId}`);

    const priceId = PRICE_MAP[plan?.toLowerCase()];
    if (!priceId) {
      console.warn('⚠️ Plan inválido recibido:', plan);
      return res.status(400).json({ error: '❌ Plan inválido o inexistente' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.SUCCESS_BASE_URL}?plan=${plan}&success=true`,
      cancel_url: process.env.CANCEL_URL,
      metadata: { userId, plan },
    });

    console.log(`🧾 Sesión Stripe creada correctamente → ${session.id}`);
    res.json({ url: session.url });
  } catch (e) {
    console.error('❌ Error creando sesión Stripe:', e);
    res.status(500).json({
      error: e.message || 'Error interno al crear la sesión de pago',
    });
  }
});

// --- ENDPOINT PARA CONSULTAR ESTADO DEL USUARIO ---
app.get('/estado-usuario', (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'Falta userId en la query' });
  }

  const pagos = leerPagos();

  if (!pagos[userId]) {
    return res.json({ activo: false });
  }

  return res.json(pagos[userId]);
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Stripe activo en puerto ${PORT}`);
  console.log(`📂 Archivo de pagos: ${DATA_FILE}`);
});
