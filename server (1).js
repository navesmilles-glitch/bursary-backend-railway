require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { customAlphabet } = require('nanoid');
const twilio = require('twilio');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'quyum123';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || '';
const ADMIN_WHATSAPP_NUMBER = process.env.ADMIN_WHATSAPP_NUMBER || '';

const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

const genRef = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

app.use(cors());
app.use('/api/webhook/paystack', express.raw({ type: 'application/json' }));
app.use(express.json());

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.startsWith('234') ? digits : '234' + digits.slice(-10);
}

async function sendWhatsApp(to, message) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) {
    console.log('[WhatsApp skipped - Twilio not configured]', message);
    return { skipped: true };
  }
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:+${normalizePhone(to)}`;
  try {
    const result = await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM, to: toFormatted, body: message
    });
    return { sid: result.sid };
  } catch (err) {
    console.error('[WhatsApp error]', err.message);
    return { error: err.message };
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'bursary-backend', time: new Date().toISOString() });
});

// Admin login check (used by the admin portal to validate the password before storing it)
app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Invalid password' });
  res.json({ ok: true });
});

// Create payment
app.post('/api/payments', async (req, res) => {
  const { studentName, studentId, academicYear, schoolName, schoolCity,
    ngnAmount, fee, totalNgn, arrivalCurrency, arrivalAmount,
    schoolBank, schoolAccountNumber, schoolSwift, schoolAccountName,
    payerPhone, payerEmail } = req.body;

  if (!studentName || !schoolName || !ngnAmount || !payerPhone)
    return res.status(400).json({ error: 'Missing required fields' });

  const payment = {
    ref: 'BSY-' + genRef(),
    student_name: studentName, student_id: studentId || '',
    academic_year: academicYear || '', school_name: schoolName,
    school_city: schoolCity || '', ngn_amount: ngnAmount,
    fee: fee || 0, total_ngn: totalNgn || ngnAmount,
    arrival_currency: arrivalCurrency || '', arrival_amount: arrivalAmount || 0,
    school_bank: schoolBank || '', school_account_number: schoolAccountNumber || '',
    school_swift: schoolSwift || '', school_account_name: schoolAccountName || '',
    payer_phone: payerPhone, payer_email: payerEmail || null, status: 'awaiting_transfer',
    paystack_reference: null, created_at: new Date().toISOString(),
    received_at: null, delivered_at: null,
  };

  await db.insertPayment(payment);
  res.json({ ok: true, reference: payment.ref });
});

// Check payment status (public)
app.get('/api/payments/:ref', async (req, res) => {
  const p = await db.findByRef(req.params.ref);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

// List all payments (admin) - supports ?status= and ?q= (search ref/student/school)
app.get('/api/admin/payments', requireAdmin, async (req, res) => {
  let payments = await db.findAll();
  const { status, q } = req.query;
  if (status) payments = payments.filter(p => p.status === status);
  if (q) {
    const needle = q.toLowerCase();
    payments = payments.filter(p =>
      p.ref.toLowerCase().includes(needle) ||
      p.student_name.toLowerCase().includes(needle) ||
      p.school_name.toLowerCase().includes(needle));
  }
  res.json(payments);
});

// Dashboard stats (admin)
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  res.json(await db.stats());
});

// Update payment status (admin)
app.patch('/api/admin/payments/:ref', requireAdmin, async (req, res) => {
  const { status } = req.body;
  const allowed = ['awaiting_transfer', 'received', 'converting', 'delivered'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: 'Invalid status' });

  const payment = await db.findByRef(req.params.ref);
  if (!payment) return res.status(404).json({ error: 'Not found' });

  const updates = { status };
  if (status === 'received') updates.received_at = new Date().toISOString();
  if (status === 'delivered') updates.delivered_at = new Date().toISOString();
  await db.updateByRef(req.params.ref, updates);

  if (status === 'delivered') {
    const msg = `✓ *Payment Delivered* 🎓\n\nHi ${payment.student_name.split(' ')[0]},\n\n${payment.school_name} has received your school fees.\n\nRef: ${payment.ref}\nAmount: ₦${payment.ngn_amount.toLocaleString()}\nDelivered: ${payment.arrival_currency === 'USD' ? '$' : '₵'}${Number(payment.arrival_amount).toFixed(2)}\n\nThank you for using Bursary!\n🌐 bursary.co`;
    await sendWhatsApp(payment.payer_phone, msg);
  }

  res.json({ ok: true });
});

// Send receipt WhatsApp
app.post('/api/send-receipt', async (req, res) => {
  const payment = await db.findByRef(req.body.ref);
  if (!payment) return res.status(404).json({ error: 'Not found' });

  const msg = `Hi ${payment.student_name.split(' ')[0]},\n\n✓ *Payment Confirmed*\n\nRef: ${payment.ref}\nStudent: ${payment.student_name}\nSchool: ${payment.school_name}\nYou paid: ₦${payment.ngn_amount.toLocaleString()}\nSchool receives: ${payment.arrival_currency === 'USD' ? '$' : '₵'}${Number(payment.arrival_amount).toFixed(2)}\n\nStatus: Processing — school will be paid within 24 hours.\n\nThank you for using Bursary!\n🌐 bursary.co`;

  const result = await sendWhatsApp(payment.payer_phone, msg);
  res.json({ ok: true, result });
});

// Paystack webhook
app.post('/api/webhook/paystack', async (req, res) => {
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
  if (hash !== req.headers['x-paystack-signature'])
    return res.status(401).send('Invalid signature');

  const event = JSON.parse(req.body.toString());
  if (event.event === 'charge.success') {
    const amountNGN = event.data.amount / 100;
    const narration = (event.data.narration || '').toUpperCase();
    const bsyMatch = narration.match(/BSY-[A-Z0-9]{6}/);

    let payment = bsyMatch ? await db.findPendingByRef(bsyMatch[0]) : null;
    if (!payment) payment = await db.findPendingByAmount(amountNGN);

    if (payment) {
      await db.updateByRef(payment.ref, {
        status: 'received', received_at: new Date().toISOString(),
        paystack_reference: event.data.reference
      });
      if (ADMIN_WHATSAPP_NUMBER) {
        await sendWhatsApp(ADMIN_WHATSAPP_NUMBER,
          `💰 *Payment Received*\n\n₦${amountNGN.toLocaleString()} from ${payment.student_name}\nSchool: ${payment.school_name}\nRef: ${payment.ref}\n\nConvert via Bybit and pay the school.`);
      }
      await sendWhatsApp(payment.payer_phone,
        `✓ We received your transfer of ₦${amountNGN.toLocaleString()} (Ref: ${payment.ref}).\n\nWe're converting now and will pay ${payment.school_name} within 24 hours.`);
    } else {
      if (ADMIN_WHATSAPP_NUMBER) {
        await sendWhatsApp(ADMIN_WHATSAPP_NUMBER,
          `⚠️ Unmatched transfer: ₦${amountNGN.toLocaleString()} received but no matching payment found. Paystack ref: ${event.data.reference}`);
      }
    }
  }
  res.sendStatus(200);
});

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Bursary backend running on port ${PORT}`);
      console.log(twilioClient ? '✓ Twilio connected' : '⚠ Twilio not configured');
    });
  })
  .catch(err => {
    console.error('✗ Failed to initialize database:', err.message);
    process.exit(1);
  });
