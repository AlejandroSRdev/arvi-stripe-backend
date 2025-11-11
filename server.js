import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import bodyParser from 'body-parser';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Configuración general
app.use(cors());
app.use(express.json());

// Mapear sus precios Stripe
const PRICE_MAP = {
  mini:  'prod_TOyt0CCW0Iidf2',   // <--- Sustituya con sus IDs reales
  base:  'prod_TOyv8VBWSSGwxU',
  pro:   'prod_TOywft0qSxr4g1'
};

// Crear sesión de Checkout
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, userId } = req.body;
    const priceId = PRICE_MAP[plan];
    if (!priceId) return res.status(400).json({ error: 'Plan inválido' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.SUCCESS_BASE_URL}?user=${encodeURIComponent(userId)}&plan=${plan}`,
      cancel_url: process.env.CANCEL_URL,
      metadata: { userId, plan },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('Error creando sesión:', e.message);
    res.status(500).json({ error: 'No se pudo crear la sesión' });
  }
});

// Webhook Stripe
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️ Firma inválida:', err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, plan } = session.metadata;
    console.log(`✅ Pago confirmado → usuario ${userId}, plan ${plan}`);
    // Aquí puede actualizar su base de datos o emitir un token de activación
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 4242, () => {
  console.log(`Servidor Stripe escuchando en puerto ${process.env.PORT || 4242}`);
});
