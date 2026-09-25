const { Pool } = require('pg');

// Works with any managed Postgres (Neon, Render, Railway, Supabase, etc.) as
// long as DATABASE_URL is set. SSL is required by every one of those hosts,
// so it's on by default — only skipped for a plain local database.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false } : undefined,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      ref TEXT PRIMARY KEY,
      student_name TEXT NOT NULL,
      student_id TEXT,
      academic_year TEXT,
      school_name TEXT NOT NULL,
      school_city TEXT,
      ngn_amount NUMERIC NOT NULL,
      fee NUMERIC DEFAULT 0,
      total_ngn NUMERIC NOT NULL,
      arrival_currency TEXT,
      arrival_amount NUMERIC,
      school_bank TEXT,
      school_account_number TEXT,
      school_swift TEXT,
      school_account_name TEXT,
      payer_phone TEXT NOT NULL,
      payer_email TEXT,
      status TEXT NOT NULL DEFAULT 'awaiting_transfer',
      paystack_reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      received_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at DESC);
  `);
  console.log('✓ Postgres schema ready');
}

function rowOut(r) {
  if (!r) return null;
  return {
    ...r,
    ngn_amount: Number(r.ngn_amount),
    fee: Number(r.fee),
    total_ngn: Number(r.total_ngn),
    arrival_amount: r.arrival_amount === null ? null : Number(r.arrival_amount),
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    received_at: r.received_at ? new Date(r.received_at).toISOString() : null,
    delivered_at: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
  };
}

module.exports = {
  init,

  async insertPayment(p) {
    await pool.query(
      `INSERT INTO payments
        (ref, student_name, student_id, academic_year, school_name, school_city,
         ngn_amount, fee, total_ngn, arrival_currency, arrival_amount,
         school_bank, school_account_number, school_swift, school_account_name,
         payer_phone, payer_email, status, paystack_reference, created_at, received_at, delivered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [p.ref, p.student_name, p.student_id, p.academic_year, p.school_name, p.school_city,
       p.ngn_amount, p.fee, p.total_ngn, p.arrival_currency, p.arrival_amount,
       p.school_bank, p.school_account_number, p.school_swift, p.school_account_name,
       p.payer_phone, p.payer_email || null, p.status, p.paystack_reference,
       p.created_at, p.received_at, p.delivered_at]
    );
    return p;
  },

  async findByRef(ref) {
    const { rows } = await pool.query('SELECT * FROM payments WHERE ref = $1', [ref]);
    return rowOut(rows[0]);
  },

  async findAll() {
    const { rows } = await pool.query('SELECT * FROM payments ORDER BY created_at DESC');
    return rows.map(rowOut);
  },

  async findPendingByAmount(amount) {
    const { rows } = await pool.query(
      `SELECT * FROM payments WHERE status = 'awaiting_transfer' AND total_ngn = $1
       ORDER BY created_at DESC LIMIT 1`, [amount]);
    return rowOut(rows[0]);
  },

  async findPendingByRef(ref) {
    const { rows } = await pool.query(
      `SELECT * FROM payments WHERE ref = $1 AND status = 'awaiting_transfer'`, [ref]);
    return rowOut(rows[0]);
  },

  async updateByRef(ref, updates) {
    const keys = Object.keys(updates);
    if (!keys.length) return this.findByRef(ref);
    const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE payments SET ${setClause} WHERE ref = $1 RETURNING *`,
      [ref, ...keys.map(k => updates[k])]
    );
    return rowOut(rows[0]);
  },

  async stats() {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total_count,
        COALESCE(SUM(ngn_amount), 0)::float AS total_ngn,
        COUNT(*) FILTER (WHERE status = 'awaiting_transfer')::int AS awaiting_count,
        COUNT(*) FILTER (WHERE status = 'received')::int AS received_count,
        COUNT(*) FILTER (WHERE status = 'converting')::int AS converting_count,
        COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered_count
      FROM payments
    `);
    return rows[0];
  },
};
