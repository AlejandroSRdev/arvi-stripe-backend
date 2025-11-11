import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import bodyParser from 'body-parser';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// --- CONFIGURACIÓN GENERAL ---
app.use(cors());
app.use(express.json());

// --- MAPEO DE PLANES Y PRECIOS (actualice IDs si cambian) ---
const PRICE_MAP = {
  mini: 'prod_TOyt0CCW0Iidf2',  // Precio plan MINI
  base: 'prod_TOyv8VBWSSGwxU',  // Precio plan BASE
  pro:  'prod_TOywft0qSxr4g1',  // Precio plan PRO
};

// --- CREAR SESIÓN DE CHECKOUT ---
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, userId } = req.body;
    const priceId = PRICE_MAP[plan];

    if (!priceId) {
      return res.status(400).json({ error: '❌ Plan inválido o inexistente' });
    }

    // ✅ Crear sesión de pago con redirección a /success?plan=X&success=true
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.SUCCESS_BASE_URL}?plan=${plan}&success=true`,
      cancel_url: process.env.CANCEL_URL,
      metadata: { userId, plan },
    });

    console.log(`🧾 Sesión Stripe creada → Plan: ${plan}, Usuario: ${userId}`);
    res.json({ url: session.url });
  } catch (e) {
    console.error('❌ Error creando sesión Stripe:', e.message);
    res.status(500).json({ error: 'No se pudo crear la sesión de pago' });
  }
});

// --- WEBHOOK DE CONFIRMACIÓN STRIPE ---
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️ Firma inválida del webhook:', err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, plan } = session.metadata;

    console.log(`✅ Pago confirmado → Usuario: ${userId}, Plan: ${plan}`);

    // 👉 En el futuro: puede emitir un token, guardar en Firestore o enviar email
  }

  res.sendStatus(200);
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Stripe activo en puerto ${PORT}`);
});
