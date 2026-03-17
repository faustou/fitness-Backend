import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import { createClient } from '@supabase/supabase-js';

// ── Clientes ────────────────────────────────────────────────────────────────

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Duración en días por plan
const DURACION_PLANES = {
  BRONCE: 30,
  PLATA:  90,
  ORO:    180,
  VIP:    30,
};

// ── App ─────────────────────────────────────────────────────────────────────

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://fitness-frontend-topaz.vercel.app'
  ],
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true
}));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Access-Control-Request-Private-Network');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('server corriendo');
});

// ── POST /create_preference ──────────────────────────────────────────────────
//
// Body: { planId, monto, profileId, email, nombre, telefono, esVisitante }
//
app.post('/create_preference', async (req, res) => {
  console.log('Body recibido:', JSON.stringify(req.body));
  console.log('Tipo de monto:', typeof req.body.monto, '| Valor:', req.body.monto);

  const { planId, monto, profileId, email, nombre, telefono, esVisitante } = req.body;

  if (!planId || !monto || !email) {
    return res.status(400).json({ error: 'planId, monto y email son requeridos' });
  }

  try {
    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [
          {
            title: `Plan ${planId}`,
            quantity: 1,
            unit_price: Number(monto),
            currency_id: 'ARS',
          },
        ],
        payer: { email },
        back_urls: {
          success: `${FRONTEND_URL}/pago-exitoso`,
          failure: `${FRONTEND_URL}/`,
          pending: `${FRONTEND_URL}/pago-pendiente`,
        },
        auto_return: 'approved',
        notification_url: `${process.env.WEBHOOK_URL}/webhook`,
        metadata: {
          plan_id: planId,
          es_visitante: esVisitante,
          profile_id: profileId || null,
        },
      },
    });

    const preferenceId = result.id;

    if (esVisitante) {
      // Visitante sin cuenta: guardar en alumnos_pendientes
      const { error } = await supabase
        .from('alumnos_pendientes')
        .upsert(
          {
            email,
            nombre,
            telefono: telefono || null,
            plan: planId,
            monto: Number(monto),
            mp_preference_id: preferenceId,
            estado: 'sin_asignar',
          },
          { onConflict: 'email' }
        );
      if (error) {
        console.error('Error guardando alumno pendiente:', error);
        // No bloqueamos el pago — igual devolvemos el preferenceId
      }
    } else {
      // Alumno registrado: registrar el intento de pago en pagos
      const { error } = await supabase.from('pagos').insert({
        profile_id: profileId,
        plan: planId,
        monto: Number(monto),
        mp_preference_id: preferenceId,
        estado: 'pendiente',
      });
      if (error) {
        console.error('Error registrando pago pendiente:', error);
      }
    }

    res.json({ id: preferenceId });
  } catch (error) {
    console.error('Error creando preferencia:', error);
    res.status(500).json({ error: 'Error al crear la preferencia' });
  }
});

// ── POST /verify-payment ──────────────────────────────────────────────────────
//
// Llamado desde /pago-exitoso cuando el alumno vuelve del checkout de MP.
// Body: { paymentId }  — MP lo manda como query param ?payment_id=xxx
//
app.post('/verify-payment', async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: 'paymentId requerido' });

  try {
    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } }
    );

    if (!response.ok) return res.status(500).json({ error: 'Error consultando MP' });

    const pago = await response.json();

    if (pago.status === 'approved') {
      await procesarPagoAprobado(pago);
      res.json({ status: 'approved' });
    } else {
      res.json({ status: pago.status });
    }
  } catch (error) {
    console.error('Error en verify-payment:', error);
    res.status(500).json({ error: 'Error procesando pago' });
  }
});

// ── Validación de firma MP ────────────────────────────────────────────────────

function validarFirmaMP(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // sin secret configurado, saltear en dev

  const signature = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  if (!signature) return false;

  const parts = Object.fromEntries(signature.split(',').map(p => p.split('=')));
  const ts = parts['ts'];
  const v1 = parts['v1'];
  if (!ts || !v1) return false;

  const paymentId = req.body?.data?.id;
  const manifest = `id:${paymentId};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}

// ── POST /webhook ─────────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  console.log('Webhook recibido:', JSON.stringify(req.body, null, 2));

  if (!validarFirmaMP(req)) {
    console.error('Webhook con firma inválida — rechazado');
    return res.sendStatus(401);
  }

  if (req.body.type !== 'payment') {
    return res.sendStatus(200);
  }

  const paymentId = req.body.data?.id;
  if (!paymentId) {
    return res.sendStatus(400);
  }

  try {
    // Consultar el pago a la API de MP
    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
      }
    );

    if (!response.ok) {
      console.error('Error consultando pago a MP:', response.status);
      return res.sendStatus(500);
    }

    const pago = await response.json();
    console.log('Pago MP:', { id: pago.id, status: pago.status, monto: pago.transaction_amount });

    if (pago.status === 'approved') {
      await procesarPagoAprobado(pago);
    } else if (pago.status === 'rejected' || pago.status === 'cancelled') {
      await actualizarEstadoPago(pago);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error en webhook:', error);
    res.sendStatus(500);
  }
});

// ── Helpers del webhook ───────────────────────────────────────────────────────

async function procesarPagoAprobado(pago) {
  const preferenceId = pago.preference_id;
  const paymentId = String(pago.id);

  // Idempotencia: verificar si este paymentId ya fue procesado
  const { data: pagoYaProcesado } = await supabase
    .from('pagos')
    .select('id')
    .eq('mp_payment_id', paymentId)
    .eq('estado', 'aprobado')
    .maybeSingle();

  if (pagoYaProcesado) {
    console.log(`Pago ${paymentId} ya procesado — ignorando`);
    return;
  }

  // 1. ¿Es un alumno pendiente (visitante)?
  const { data: alumno } = await supabase
    .from('alumnos_pendientes')
    .select('*')
    .eq('mp_preference_id', preferenceId)
    .single();

  if (alumno) {
    const { error } = await supabase
      .from('alumnos_pendientes')
      .update({
        mp_payment_id: paymentId,
        monto: pago.transaction_amount,
      })
      .eq('id', alumno.id);
    if (error) console.error('Error actualizando alumno_pendiente:', error);

    // Crear invitación con profesor_id null — el profesor la toma desde el hub
    const { data: invExistente } = await supabase
      .from('invitaciones')
      .select('id')
      .eq('email', alumno.email)
      .eq('usado', false)
      .single();

    if (!invExistente) {
      const { error: invError } = await supabase
        .from('invitaciones')
        .insert({ email: alumno.email, nombre: alumno.nombre, profesor_id: null });
      if (invError) console.error('Error creando invitación:', invError);
      else console.log(`Invitación creada para ${alumno.email}`);
    }

    console.log(`Visitante ${alumno.email} — pago aprobado, invitación creada`);
    return;
  }

  // 2. ¿Es un alumno registrado?
  const { data: pagoRegistro } = await supabase
    .from('pagos')
    .select('*')
    .eq('mp_preference_id', preferenceId)
    .single();

  // Fallback: usar metadata de MP si no hay registro en pagos
  if (!pagoRegistro && pago.metadata?.profile_id) {
    const profileId = pago.metadata.profile_id;
    const planId = pago.metadata.plan_id;
    const dias = DURACION_PLANES[planId] || 30;
    const vencimiento = new Date();
    vencimiento.setDate(vencimiento.getDate() + dias);

    const { error } = await supabase
      .from('profiles')
      .update({
        suscripcion_activa: true,
        plan_activo: planId,
        fecha_vencimiento_plan: vencimiento.toISOString(),
      })
      .eq('id', profileId);

    if (error) console.error('Error activando suscripción (fallback):', error);
    else console.log(`Suscripción activada (fallback metadata) para profile ${profileId}`);

    // Verificar si necesita profesor
    const { data: alumnoRegistrado } = await supabase
      .from('alumnos')
      .select('profesor_id')
      .eq('profile_id', profileId)
      .maybeSingle();

    if (!alumnoRegistrado?.profesor_id) {
      const { data: profileData } = await supabase
        .from('profiles')
        .select('email, nombre')
        .eq('id', profileId)
        .single();

      if (profileData) {
        await supabase
          .from('alumnos_pendientes')
          .upsert(
            {
              email: profileData.email,
              nombre: profileData.nombre,
              plan: planId,
              monto: pago.transaction_amount,
              mp_preference_id: preferenceId,
              mp_payment_id: paymentId,
              estado: 'sin_asignar',
              profile_id: profileId,
            },
            { onConflict: 'email' }
          );
      }
    }
    return;
  }

  if (pagoRegistro) {
    // Actualizar el registro de pago
    await supabase
      .from('pagos')
      .update({
        mp_payment_id: paymentId,
        estado: 'aprobado',
        fecha_pago: pago.date_approved || new Date().toISOString(),
        medio_pago: pago.payment_method_id,
        cuotas: pago.installments,
        nombre_pagador: pago.payer?.first_name
          ? `${pago.payer.first_name} ${pago.payer.last_name || ''}`.trim()
          : null,
      })
      .eq('id', pagoRegistro.id);

    // Activar suscripción en profiles
    const dias = DURACION_PLANES[pagoRegistro.plan] || 30;
    const vencimiento = new Date();
    vencimiento.setDate(vencimiento.getDate() + dias);

    const { error } = await supabase
      .from('profiles')
      .update({
        suscripcion_activa: true,
        plan_activo: pagoRegistro.plan,
        fecha_vencimiento_plan: vencimiento.toISOString(),
      })
      .eq('id', pagoRegistro.profile_id);

    if (error) console.error('Error activando suscripción:', error);
    else console.log(`Suscripción activada para profile ${pagoRegistro.profile_id} — plan ${pagoRegistro.plan}`);

    // Verificar si el alumno ya tiene profesor asignado
    const { data: alumnoRegistrado } = await supabase
      .from('alumnos')
      .select('profesor_id')
      .eq('profile_id', pagoRegistro.profile_id)
      .maybeSingle();

    const tieneProfesor = alumnoRegistrado?.profesor_id != null;

    if (!tieneProfesor) {
      // Sin profesor: insertarlo en alumnos_pendientes para que el hub lo muestre
      const { data: profileData } = await supabase
        .from('profiles')
        .select('email, nombre')
        .eq('id', pagoRegistro.profile_id)
        .single();

      if (profileData) {
        await supabase
          .from('alumnos_pendientes')
          .upsert(
            {
              email: profileData.email,
              nombre: profileData.nombre,
              plan: pagoRegistro.plan,
              monto: pago.transaction_amount,
              mp_preference_id: preferenceId,
              mp_payment_id: paymentId,
              estado: 'sin_asignar',
              profile_id: pagoRegistro.profile_id,
            },
            { onConflict: 'email' }
          );
        console.log(`Alumno registrado ${profileData.email} sin profesor — agregado a alumnos_pendientes`);
      }
    }
  }
}

async function actualizarEstadoPago(pago) {
  await supabase
    .from('pagos')
    .update({ estado: pago.status })
    .eq('mp_preference_id', pago.preference_id);
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(port, () => {
  console.log(`Server corriendo en puerto ${port}`);
});
