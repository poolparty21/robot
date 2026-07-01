if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const { uploadFile } = require('./lib/supabase');

const {
  initSchema,
  insertLead,
  insertAffiliateSignup,
  saveChatMessages,
  insertEstimate,
  getLatestEstimate,
  insertRoomPhoto,
  getAllLeads,
} = require('./db');

const app = express();

// ── Middleware ────────────────────────────────────────

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser(process.env.COOKIE_SECRET || 'sunnyhost-secret-2026'));

app.use(express.static(path.join(__dirname, 'public')));

// ── Rate Limiters ────────────────────────────────────

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});

// ── Multer (in-memory for photo uploads) ────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// ── Helpers ─────────────────────────────────────────

function hashIP(ip) {
  const salt = process.env.IP_SALT || 'sunnyhost-ip-salt';
  return crypto
    .createHash('sha256')
    .update(ip + salt)
    .digest('hex')
    .slice(0, 16);
}

function getLeadFromCookie(req) {
  if (req.signedCookies && req.signedCookies.sunnyhost_lead_id) {
    return req.signedCookies.sunnyhost_lead_id;
  }
  return null;
}

/**
 * Income estimation logic (server-side so it isn't visible/tamperable).
 */
function calculateIncome(params) {
  const roomMultiplier = (params.roomType === 'private_room') ? 0.8
    : (params.roomType === 'entire_home') ? 1.0
    : (params.roomType === 'studio') ? 0.9
    : (params.roomType === 'shared') ? 0.5
    : 0.85;

  const locationBoost = (params.location === 'city_center') ? 1.5
    : (params.location === 'urban') ? 1.2
    : (params.location === 'suburban') ? 1.0
    : 0.85;

  const amenityCount = Array.isArray(params.amenities) ? params.amenities.length : 0;
  const amenityBoost = 1.0 + amenityCount * 0.05;
  const countMultiplier = Math.max(1, (params.roomCount || 1));

  const base = Math.floor(1000 * roomMultiplier * locationBoost * amenityBoost * countMultiplier);

  return {
    monthlyIncome: Math.max(300, base),
    occupancy: Math.min(94, Math.floor(65 + Math.random() * 27)),
    dailyRate: Math.max(30, Math.floor(base / 22)),
    daysToBooking: Math.floor(Math.random() * 10) + 5,
  };
}


// ── Admin Auth Helper ──────────────────────────────
function isAdmin(req) {
  const pass = process.env.ADMIN_PASS;
  if (!pass) return true; // no password set = open access (dev mode)
  return req.query.pass === pass;
}

// ── ENDPOINTS ────────────────────────────────────────

// POST /api/leads — create a lead and set a signed httpOnly cookie
app.post('/api/leads', generalLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const ipHash = hashIP(req.ip || req.connection.remoteAddress || '0.0.0.0');
    const userAgent = req.headers['user-agent'] || '';

    const lead = await insertLead({ email, ipHash, userAgent });

    // Signed httpOnly cookie so subsequent requests don't need to pass leadId
    res.cookie('sunnyhost_lead_id', lead.id, {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });

    res.json({ leadId: lead.id });
  } catch (err) {
    console.error('POST /api/leads error:', err);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

// POST /api/affiliate/signup — generate server-side referral URL
app.post('/api/affiliate/signup', generalLimiter, async (req, res) => {
  try {
    const leadId = getLeadFromCookie(req);

    if (!leadId) {
      return res.status(401).json({ error: 'No lead session. Please enter your email first.' });
    }

    const referralUrl = process.env.AIRBNB_REFERRAL_URL || 'https://www.airbnb.de/rp/alejandrod20340?p=stay';

    const signup = await insertAffiliateSignup({
      leadId,
      status: 'sent',
      referralUrl,
    });

    res.json({ referralUrl, status: 'sent', signupId: signup.id });
  } catch (err) {
    console.error('POST /api/affiliate/signup error:', err);
    res.status(500).json({ error: 'Failed to create affiliate signup' });
  }
});

// POST /api/chat — proxy to Groq (server-side key only)
app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const leadId = getLeadFromCookie(req);
    const { message, history } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Can't proceed without a Groq key
    if (!process.env.GROQ_API_KEY) {
      return res.status(503).json({ error: 'AI service not configured' });
    }

    const systemPrompt = [
      'You are Sunny — a warm, enthusiastic short-term rental expert.',
      'Help users maximize income from their spaces.',
      'Keep responses concise, warm, and actionable. Use emojis.',
      'Focus on Airbnb hosting tips and rental strategies.',
    ].join(' ');

    const groqMessages = [
      { role: 'system', content: systemPrompt },
      ...(Array.isArray(history) ? history.slice(-6) : []),
      { role: 'user', content: message },
    ];

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: groqMessages,
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq API error:', groqRes.status, errText);
      return res.status(502).json({ error: 'AI service temporarily unavailable' });
    }

    const data = await groqRes.json();
    const reply = data.choices[0].message.content;

    // Persist chat messages if we know the lead
    if (leadId) {
      await saveChatMessages(leadId, [
        { role: 'user', content: message },
        { role: 'assistant', content: reply },
      ]);
    }

    res.json({ reply });
  } catch (err) {
    console.error('POST /api/chat error:', err);
    res.status(500).json({ error: 'Failed to process chat message' });
  }
});

// POST /api/estimate — server-side income calculation
app.post('/api/estimate', generalLimiter, async (req, res) => {
  try {
    const leadId = getLeadFromCookie(req);
    const { roomType, location, amenities, roomCount } = req.body || {};

    const computed = calculateIncome({ roomType, location, amenities, roomCount });

    // Persist the estimate
    if (leadId) {
      await insertEstimate({
        leadId,
        monthlyIncome: computed.monthlyIncome,
        occupancy: computed.occupancy,
        dailyRate: computed.dailyRate,
        daysToBooking: computed.daysToBooking,
      });
    }

    res.json({
      monthlyIncome: computed.monthlyIncome,
      occupancy: computed.occupancy,
      dailyRate: computed.dailyRate,
      daysToBooking: computed.daysToBooking,
      airbnbEstimate: Math.floor(computed.monthlyIncome * 1.25),
    });
  } catch (err) {
    console.error('POST /api/estimate error:', err);
    res.status(500).json({ error: 'Failed to calculate estimate' });
  }
});

// POST /api/photo — upload + optional AI analysis
app.post('/api/photo', upload.single('photo'), async (req, res) => {
  try {
    const leadId = getLeadFromCookie(req);

    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded. Send a file in the "photo" field.' });
    }

    const base64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const ext = mimeType.split('/')[1] || 'jpg';

    // AI vision analysis via Groq
    let analysis = null;
    if (process.env.GROQ_API_KEY) {
      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'llama-3.2-11b-vision-preview',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Analyze this room for Airbnb short-term rental potential. Identify: 1) Room type and estimated size 2) Key selling features (natural light, view, furniture quality) 3) Potential issues 4) Estimated nightly rate range. Keep it concise, 3-5 sentences.',
                  },
                  {
                    type: 'image_url',
                    image_url: { url: `data:${mimeType};base64,${base64}` },
                  },
                ],
              },
            ],
            max_tokens: 300,
          }),
        });

        if (groqRes.ok) {
          const groqData = await groqRes.json();
          analysis = groqData.choices[0].message.content;
        } else {
          const errText = await groqRes.text();
          console.error('Groq vision error:', groqRes.status, errText);
        }
      } catch (visionErr) {
        console.error('Vision analysis error:', visionErr);
      }
    }

    // Upload to Supabase Storage (persists across Vercel deployments)
    const filename = `photos/${leadId || 'anon'}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'sunnhost-photos';

    const { publicUrl, error: uploadError } = await uploadFile(bucket, filename, req.file.buffer, mimeType);

    if (uploadError) {
      console.error('Supabase Storage upload error:', uploadError);
      return res.status(500).json({ error: 'Failed to upload photo to storage' });
    }

    const photoUrl = publicUrl;

    // Persist to room_photos
    if (leadId) {
      await insertRoomPhoto({
        leadId,
        storageUrl: photoUrl,
        aiAnalysis: analysis ? { analysis } : null,
      });
    }

    res.json({ url: photoUrl, analysis });
  } catch (err) {
    console.error('POST /api/photo error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum 8 MB.' });
    }
    res.status(500).json({ error: 'Failed to process photo' });
  }
});

// GET /api/stats — latest estimate for the current lead (via cookie)
app.get('/api/stats', async (req, res) => {
  try {
    const leadId = getLeadFromCookie(req);

    if (!leadId) {
      return res.status(401).json({ error: 'No lead session found' });
    }

    const estimate = await getLatestEstimate(leadId);

    if (!estimate) {
      return res.json({ exists: false });
    }

    res.json({
      exists: true,
      monthlyIncome: Number(estimate.monthly_income),
      occupancy: Number(estimate.occupancy),
      dailyRate: Number(estimate.daily_rate),
      daysToBooking: estimate.days_to_booking,
    });
  } catch (err) {
    console.error('GET /api/stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});


// GET /api/leads — list all leads (requires ADMIN_PASS)
app.get('/api/leads', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized. Pass ADMIN_PASS as ?pass= parameter.' });
  }
  try {
    const leads = await getAllLeads();
    res.json(leads.map(function(l) {
      return {
        id: l.id,
        email: l.email,
        affiliateId: l.affiliate_id,
        createdAt: l.created_at,
        ipHash: l.ip_hash ? l.ip_hash.slice(0, 8) + '...' : null,
      };
    }));
  } catch (err) {
    console.error('GET /api/leads error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// GET /admin — HTML admin page (requires ADMIN_PASS)
app.get('/admin', async (req, res) => {
  if (!isAdmin(req)) {
    return res.send(`<!DOCTYPE html>
<html><head><title>Admin Login - sidebusiness.online</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
.card{background:#fff;border-radius:16px;padding:2.5rem 2rem;max-width:360px;width:100%;box-shadow:0 10px 25px rgba(0,0,0,0.08);text-align:center}
.card h1{font-size:1.3rem;color:#1a1a2e;margin-bottom:0.3rem}
.card p{font-size:0.85rem;color:#888;margin-bottom:1.5rem}
.card input{width:100%;padding:0.75rem 1rem;border:2px solid #e5e7eb;border-radius:10px;font-size:0.95rem;outline:none;margin-bottom:0.8rem;transition:border-color 0.2s}
.card input:focus{border-color:#E85D04}
.card button{width:100%;padding:0.75rem;border:none;border-radius:10px;background:#E85D04;color:#fff;font-weight:700;font-size:0.95rem;cursor:pointer}
.card button:hover{background:#d45404}
.card .error{color:#dc2626;font-size:0.82rem;margin-top:0.5rem}
</style></head><body>
<div class="card">
<h1>🔐 Admin</h1>
<p>Enter your admin password</p>
<form method="get">
<input type="password" name="pass" placeholder="Password" autofocus>
<button type="submit">Login</button>
</form>
${req.query.pass ? '<div class="error">Wrong password</div>' : ''}
</div>
</body></html>`);
  }
  try {
    const leads = await getAllLeads();
    res.send(`<!DOCTYPE html>
<html><head><title>Leads - sidebusiness.online</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#f0f2f5;padding:2rem;color:#1a1a2e}
h1{font-size:1.4rem;margin-bottom:0.5rem;display:flex;align-items:center;gap:0.5rem}
h1 i{color:#E85D04}
.stats{display:flex;gap:1rem;margin-bottom:1.5rem}
.stat{padding:0.8rem 1.2rem;background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.06)}
.stat-num{font-size:1.8rem;font-weight:900;color:#E85D04}
.stat-lbl{font-size:0.72rem;color:#888;text-transform:uppercase;letter-spacing:0.5px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06)}
th{background:#f9fafb;text-align:left;padding:0.8rem 1rem;font-size:0.72rem;text-transform:uppercase;color:#888;letter-spacing:0.5px}
td{padding:0.8rem 1rem;font-size:0.85rem;border-top:1px solid #f0f0f0}
td.email{font-weight:700;color:#1a1a2e}
td.time{color:#888;font-size:0.8rem}
tr:hover td{background:#fafafa}
.empty{text-align:center;padding:3rem;color:#888}
.copy-btn{padding:0.2rem 0.6rem;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;font-size:0.7rem;color:#888}
.copy-btn:hover{background:#f5f5f5;border-color:#ccc}
</style></head><body>
<h1><i class="fas fa-cat"></i> sidebusiness.online — Leads</h1>
<div class="stats">
  <div class="stat"><div class="stat-num">${leads.length}</div><div class="stat-lbl">Total Leads</div></div>
  <div class="stat"><div class="stat-num">${leads.filter(l => l.affiliateId).length}</div><div class="stat-lbl">With Affiliate ID</div></div>
</div>
${leads.length > 0 ? '<table><thead><tr><th>Email</th><th>Affiliate ID</th><th>Created</th></tr></thead><tbody>' +
  leads.map(function(l) {
    var time = new Date(l.createdAt).toLocaleString();
    return '<tr><td class="email">' + l.email + ' <button class="copy-btn" onclick="navigator.clipboard.writeText(\'' + l.email + '\')">copy</button></td><td>' + (l.affiliateId || '-') + '</td><td class="time">' + time + '</td></tr>';
  }).join('') + '</tbody></table>' : '<div class="empty">No leads yet 🐱</div>'}
</body></html>`);
  } catch (err) {
    res.status(500).send('Error loading leads');
  }
});

// ── Schema init on first load ───────────────────────

// Don't block — init schema in background
if (process.env.DATABASE_URL) {
  initSchema().catch((err) => console.error('Schema init failed:', err.message));
}

// ── Export for Vercel serverless ─────────────────────

module.exports = app;

// ── Local dev server ────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🐱 sidebusiness.online — Chat Cat running on http://localhost:${PORT}`);
  });
}
