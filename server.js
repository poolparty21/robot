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

    const referralUrl = process.env.AIRBNB_REFERRAL_URL || 'https://www.airbnb.com/r/sidebusiness';

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
    console.log(`☀️ SunnyHost running on http://localhost:${PORT}`);
  });
}
