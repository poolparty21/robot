-- sidebusiness.online — Database Schema
-- Run against your Supabase/Postgres database manually, or let server.js auto-init

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
  status TEXT NOT NULL,            -- pending | sent | clicked | confirmed | failed
  referral_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id),
  role TEXT NOT NULL,              -- user | assistant
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

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_chat_messages_lead ON chat_messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_estimates_lead ON estimates(lead_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_signups_lead ON affiliate_signups(lead_id);
