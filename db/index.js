const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
      max: 10,
    });
  }
  return pool;
}

/**
 * Initialize the database schema — run on first start.
 */
async function initSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      affiliate_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      user_agent TEXT,
      ip_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS affiliate_signups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID REFERENCES leads(id),
      status TEXT NOT NULL,
      referral_url TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID REFERENCES leads(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS estimates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID REFERENCES leads(id),
      monthly_income NUMERIC,
      occupancy NUMERIC,
      daily_rate NUMERIC,
      days_to_booking INTEGER,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS room_photos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID REFERENCES leads(id),
      storage_url TEXT NOT NULL,
      ai_analysis JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `;

  const client = await getPool().connect();
  try {
    await client.query(sql);
    console.log('Database schema initialized');
  } finally {
    client.release();
  }
}

// ── Leads ────────────────────────────────────────────

async function insertLead({ email, affiliateId, ipHash, userAgent }) {
  const result = await getPool().query(
    `INSERT INTO leads (email, affiliate_id, ip_hash, user_agent)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [email, affiliateId || null, ipHash || null, userAgent || null]
  );
  return result.rows[0];
}

// ── Affiliate Signups ────────────────────────────────

async function insertAffiliateSignup({ leadId, status, referralUrl }) {
  const result = await getPool().query(
    `INSERT INTO affiliate_signups (lead_id, status, referral_url)
     VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [leadId, status, referralUrl]
  );
  return result.rows[0];
}

// ── Chat Messages ────────────────────────────────────

async function saveChatMessages(leadId, messages) {
  if (!leadId || !messages || messages.length === 0) return;

  const client = await getPool().connect();
  try {
    for (const msg of messages) {
      await client.query(
        `INSERT INTO chat_messages (lead_id, role, content)
         VALUES ($1, $2, $3)`,
        [leadId, msg.role, msg.content]
      );
    }
  } finally {
    client.release();
  }
}

// ── Estimates ────────────────────────────────────────

async function insertEstimate({ leadId, monthlyIncome, occupancy, dailyRate, daysToBooking }) {
  const result = await getPool().query(
    `INSERT INTO estimates (lead_id, monthly_income, occupancy, daily_rate, days_to_booking)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [leadId, monthlyIncome, occupancy, dailyRate, daysToBooking]
  );
  return result.rows[0];
}

async function getLatestEstimate(leadId) {
  const result = await getPool().query(
    `SELECT monthly_income, occupancy, daily_rate, days_to_booking
     FROM estimates
     WHERE lead_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [leadId]
  );
  return result.rows[0] || null;
}

// ── Room Photos ──────────────────────────────────────

async function insertRoomPhoto({ leadId, storageUrl, aiAnalysis }) {
  const result = await getPool().query(
    `INSERT INTO room_photos (lead_id, storage_url, ai_analysis)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [leadId, storageUrl, aiAnalysis ? JSON.stringify(aiAnalysis) : null]
  );
  return result.rows[0];
}

async function getAllLeads() {
  const result = await getPool().query(
    `SELECT id, email, affiliate_id, created_at, ip_hash
     FROM leads
     ORDER BY created_at DESC
     LIMIT 100`
  );
  return result.rows;
}

module.exports = {
  initSchema,
  insertLead,
  getAllLeads,
  insertAffiliateSignup,
  saveChatMessages,
  insertEstimate,
  getLatestEstimate,
  insertRoomPhoto,
};
