require('dotenv').config();

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3000;
const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL || `http://localhost:${PORT}`;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_VERIFICATION_REQUIRED = process.env.EMAIL_VERIFICATION_REQUIRED === 'true' && Boolean(process.env.EMAIL_FROM && RESEND_API_KEY);
const TEAM_VERIFY_REQUIRED = process.env.TEAM_VERIFY_REQUIRED === 'true';
const FIRST_API_SEASON = process.env.FIRST_API_SEASON || String(new Date().getFullYear());
const FIRST_API_USERNAME = process.env.FIRST_API_USERNAME || '';
const FIRST_API_AUTH_TOKEN = process.env.FIRST_API_AUTH_TOKEN || '';
const TBA_AUTH_KEY = process.env.TBA_AUTH_KEY || '';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const PROGRAMS = {
  FLL: 'Local pickup',
  FTC: 'Local offer',
  FRC: 'Shipping available'
};

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL. Add a PostgreSQL connection string in your .env or Render environment variables.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false }
});

if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

app.set('trust proxy', 1);

// Stripe webhook must come before express.json().
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(400).send('Stripe is not configured.');

  let event;
  try {
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      const signature = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString('utf8'));
    }
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const sessionObj = event.data.object;
      const orderId = Number(sessionObj.metadata?.orderId);
      if (orderId) {
        const orderResult = await pool.query(
          `UPDATE orders
           SET status = 'paid', updated_at = NOW()
           WHERE id = $1 AND status = 'pending_payment'
           RETURNING listing_id`,
          [orderId]
        );
        if (orderResult.rowCount) {
          await pool.query(`UPDATE listings SET status = 'sold', updated_at = NOW() WHERE id = $1`, [orderResult.rows[0].listing_id]);
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'dev-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed.'));
    cb(null, true);
  }
});

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    program: row.program || 'FTC',
    teamNumber: row.team_number,
    teamName: row.team_name,
    teamLocation: row.team_location,
    teamVerified: row.team_verified,
    teamStats: row.team_stats,
    emailVerified: row.email_verified,
    role: row.role,
    banned: row.banned,
    createdAt: row.created_at
  };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please log in first.' });
  next();
}

async function attachUser(req, res, next) {
  try {
    if (!req.session.userId) return next();
    const result = await pool.query(
      `SELECT id, name, email, program, team_number, team_name, team_location, team_verified, team_stats,
              email_verified, role, banned, created_at
       FROM users WHERE id = $1`,
      [req.session.userId]
    );
    if (!result.rowCount) {
      req.session.destroy(() => {});
      return next();
    }
    req.user = result.rows[0];
    if (req.user.banned) return res.status(403).json({ error: 'This account has been banned.' });
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

function requireVerifiedEmail(req, res, next) {
  if (!EMAIL_VERIFICATION_REQUIRED) return next();
  if (!req.user?.email_verified) return res.status(403).json({ error: 'Please verify your email before using marketplace actions.' });
  next();
}

app.use(attachUser);

function centsToDollars(cents) {
  return Number(cents || 0) / 100;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongPassword(password) {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(password);
}

function normalizeProgram(program) {
  const value = String(program || '').trim().toUpperCase();
  return PROGRAMS[value] ? value : '';
}

function verificationToken() {
  return crypto.randomBytes(24).toString('hex');
}

function compactTeamStats(stats) {
  if (!stats) return null;
  return {
    source: stats.source,
    sourceUrl: stats.sourceUrl,
    season: stats.season || FIRST_API_SEASON,
    rookieYear: stats.rookieYear || null,
    website: stats.website || null,
    verifiedAt: stats.verifiedAt || new Date().toISOString()
  };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
}

function firstAuthHeaders() {
  if (!FIRST_API_USERNAME || !FIRST_API_AUTH_TOKEN) return null;
  const auth = Buffer.from(`${FIRST_API_USERNAME}:${FIRST_API_AUTH_TOKEN}`).toString('base64');
  return { Authorization: `Basic ${auth}`, Accept: 'application/json' };
}

function locationFromParts(parts) {
  return parts.filter(Boolean).join(', ');
}

function parseFirstTeam(program, data) {
  const team = Array.isArray(data?.teams) ? data.teams[0] : data?.team || data;
  if (!team) return null;
  const name = team.nameFull || team.nameShort || team.name || team.schoolName || team.teamName || `${program} ${team.teamNumber || ''}`.trim();
  return {
    source: program === 'FRC' ? 'FIRST Robotics Competition API' : 'FIRST Tech Challenge API',
    sourceUrl: program === 'FRC' ? 'https://frc-api.firstinspires.org/' : 'https://ftc-api.firstinspires.org/',
    name,
    location: locationFromParts([team.city, team.stateProv || team.state, team.country]),
    stats: compactTeamStats({
      source: program === 'FRC' ? 'FIRST Robotics Competition API' : 'FIRST Tech Challenge API',
      sourceUrl: program === 'FRC' ? 'https://frc-api.firstinspires.org/' : 'https://ftc-api.firstinspires.org/',
      season: FIRST_API_SEASON,
      rookieYear: team.rookieYear,
      website: team.website
    })
  };
}

async function fetchFirstTeam(program, teamNumber) {
  const headers = firstAuthHeaders();
  if (!headers || !['FRC', 'FTC'].includes(program)) return null;
  const base = program === 'FRC'
    ? `https://frc-api.firstinspires.org/v3.0/${FIRST_API_SEASON}/teams`
    : `https://ftc-api.firstinspires.org/v2.0/${FIRST_API_SEASON}/teams`;
  const data = await fetchJsonWithTimeout(`${base}?teamNumber=${encodeURIComponent(teamNumber)}`, { headers });
  return parseFirstTeam(program, data);
}

async function fetchTbaTeam(teamNumber) {
  if (!TBA_AUTH_KEY) return null;
  const key = `frc${teamNumber}`;
  const data = await fetchJsonWithTimeout(`https://www.thebluealliance.com/api/v3/team/${key}`, {
    headers: { 'X-TBA-Auth-Key': TBA_AUTH_KEY, Accept: 'application/json' }
  });
  if (!data) return null;
  return {
    source: 'The Blue Alliance',
    sourceUrl: `https://www.thebluealliance.com/team/${teamNumber}`,
    name: data.nickname || data.name || `FRC ${teamNumber}`,
    location: locationFromParts([data.city, data.state_prov, data.country]),
    stats: compactTeamStats({
      source: 'The Blue Alliance',
      sourceUrl: `https://www.thebluealliance.com/team/${teamNumber}`,
      rookieYear: data.rookie_year,
      website: data.website
    })
  };
}

async function lookupTeam(program, teamNumber) {
  const official = await fetchFirstTeam(program, teamNumber).catch(() => null);
  if (official) return { verified: true, ...official };
  if (program === 'FRC') {
    const tba = await fetchTbaTeam(teamNumber).catch(() => null);
    if (tba) return { verified: true, ...tba };
  }
  return {
    verified: false,
    source: null,
    sourceUrl: null,
    name: null,
    location: null,
    stats: null
  };
}

function emptyTeamLookup() {
  return {
    verified: false,
    source: null,
    sourceUrl: null,
    name: null,
    location: null,
    stats: null
  };
}

async function sendVerificationEmail(user, token) {
  const verifyUrl = `${CLIENT_BASE_URL}/api/auth/verify-email?token=${token}`;
  if (!process.env.EMAIL_FROM || !RESEND_API_KEY) {
    console.log(`Email verification for ${user.email}: ${verifyUrl}`);
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: user.email,
      subject: 'Verify your Emerald City Resale email',
      html: `
        <p>Hi ${String(user.name || 'there').replace(/[<>&"]/g, '')},</p>
        <p>Verify your Emerald City Resale account to start messaging, reserving, and selling.</p>
        <p><a href="${verifyUrl}">Verify email</a></p>
        <p>If the button does not work, paste this link into your browser:</p>
        <p>${verifyUrl}</p>
      `
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Email provider failed: ${errorText || response.statusText}`);
  }
}

function queueVerificationEmail(user, token) {
  setImmediate(() => {
    sendVerificationEmail(user, token).catch((err) => {
      console.error(`Email verification failed for ${user.email}:`, err.message);
    });
  });
}

function queueTeamLookup(userId, program, teamNumber) {
  setImmediate(async () => {
    try {
      const team = await lookupTeam(program, teamNumber);
      if (!team.verified) return;
      await pool.query(
        `UPDATE users
         SET team_name = $1,
             team_location = $2,
             team_verified = TRUE,
             team_verified_at = NOW(),
             team_stats = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [team.name, team.location, team.stats, userId]
      );
    } catch (err) {
      console.error(`Team lookup failed for ${program} ${teamNumber}:`, err.message);
    }
  });
}

function normalizeListing(row) {
  return {
    id: row.id,
    sellerId: row.seller_id,
    sellerName: row.seller_name,
    sellerEmail: row.seller_email,
    program: row.program || 'FTC',
    title: row.title,
    description: row.description,
    priceCents: row.price_cents,
    price: centsToDollars(row.price_cents),
    currency: row.currency,
    category: row.category,
    location: row.location,
    condition: row.item_condition,
    imageUrl: row.image_url,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      program TEXT NOT NULL DEFAULT 'FTC' CHECK (program IN ('FLL', 'FTC', 'FRC')),
      team_number TEXT,
      team_name TEXT,
      team_location TEXT,
      team_verified BOOLEAN NOT NULL DEFAULT FALSE,
      team_verified_at TIMESTAMPTZ,
      team_stats JSONB,
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      email_verification_token TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS listings (
      id SERIAL PRIMARY KEY,
      seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      program TEXT NOT NULL DEFAULT 'FTC' CHECK (program IN ('FLL', 'FTC', 'FRC')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'USD',
      category TEXT NOT NULL,
      location TEXT NOT NULL,
      item_condition TEXT NOT NULL DEFAULT 'Used',
      image_url TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'deleted')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
      order_id INTEGER,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
      buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'paid', 'paid_demo', 'shipped', 'completed', 'cancelled')),
      payment_provider TEXT,
      payment_session_id TEXT,
      shipping_name TEXT,
      shipping_address1 TEXT,
      shipping_address2 TEXT,
      shipping_city TEXT,
      shipping_state TEXT,
      shipping_postal TEXT,
      shipping_country TEXT,
      tracking_number TEXT,
      carrier TEXT,
      label_url TEXT,
      buyer_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      seller_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      buyer_confirmed_at TIMESTAMPTZ,
      seller_confirmed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
      admin_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_listings_status_created ON listings(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_id);
    CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(sender_id, receiver_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_number TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS program TEXT NOT NULL DEFAULT 'FTC';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_location TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_verified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_verified_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_stats JSONB;
    ALTER TABLE listings ADD COLUMN IF NOT EXISTS program TEXT NOT NULL DEFAULT 'FTC';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_confirmed_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_confirmed_at TIMESTAMPTZ;
    UPDATE users SET email_verified = TRUE WHERE email_verification_token IS NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_receiver_read ON messages(receiver_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_users_email_verification_token ON users(email_verification_token);
    CREATE INDEX IF NOT EXISTS idx_listings_program_status ON listings(program, status, created_at DESC);
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_users_program_team_unique'
      ) AND NOT EXISTS (
        SELECT 1
        FROM users
        WHERE team_number IS NOT NULL AND team_number <> ''
        GROUP BY program, team_number
        HAVING COUNT(*) > 1
      ) THEN
        CREATE UNIQUE INDEX idx_users_program_team_unique
        ON users(program, team_number)
        WHERE team_number IS NOT NULL AND team_number <> '';
      END IF;
    END $$;
  `);

  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (adminEmail) {
    await pool.query(
      `WITH preferred AS (
         SELECT id FROM users WHERE role = 'admin' AND LOWER(email) = $1 ORDER BY id LIMIT 1
       ),
       fallback AS (
         SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1
       ),
       keeper AS (
         SELECT id FROM preferred
         UNION ALL
         SELECT id FROM fallback WHERE NOT EXISTS (SELECT 1 FROM preferred)
         LIMIT 1
       )
       UPDATE users
       SET role = 'user', updated_at = NOW()
       WHERE role = 'admin' AND id <> COALESCE((SELECT id FROM keeper), -1)`,
      [adminEmail]
    );
  } else {
    await pool.query(`
      WITH keeper AS (
        SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1
      )
      UPDATE users
      SET role = 'user', updated_at = NOW()
      WHERE role = 'admin' AND id <> COALESCE((SELECT id FROM keeper), -1)
    `);
  }

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_admin
    ON users ((role))
    WHERE role = 'admin';
  `);

  // Adds order_id FK after both tables exist. Safe to ignore if already present.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'messages_order_id_fkey'
      ) THEN
        ALTER TABLE messages
        ADD CONSTRAINT messages_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
}

async function uploadListingImage(file) {
  if (!file) return null;

  const hasCloudinary = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET;
  if (hasCloudinary) {
    return await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'global-marketplace/listings', resource_type: 'image' },
        (error, result) => {
          if (error) return reject(error);
          resolve(result.secure_url);
        }
      );
      stream.end(file.buffer);
    });
  }

  // Local fallback for testing. On Render or similar hosts, local uploads can disappear on redeploy.
  const uploadsDir = path.join(__dirname, 'public', 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
  const fileName = `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
  fs.writeFileSync(path.join(uploadsDir, fileName), file.buffer);
  return `/uploads/${fileName}`;
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    stripeEnabled: Boolean(stripe),
    cloudinaryEnabled: Boolean(process.env.CLOUDINARY_CLOUD_NAME),
    emailEnabled: Boolean(process.env.EMAIL_FROM && RESEND_API_KEY),
    emailVerificationRequired: EMAIL_VERIFICATION_REQUIRED,
    teamVerificationEnabled: Boolean((FIRST_API_USERNAME && FIRST_API_AUTH_TOKEN) || TBA_AUTH_KEY),
    teamVerificationRequired: TEAM_VERIFY_REQUIRED
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    programs: PROGRAMS,
    emailVerificationRequired: EMAIL_VERIFICATION_REQUIRED,
    teamVerificationRequired: TEAM_VERIFY_REQUIRED
  });
});

app.get('/api/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get('/api/team/lookup', async (req, res, next) => {
  try {
    const program = normalizeProgram(req.query.program);
    const teamNumber = String(req.query.teamNumber || '').trim();
    if (!program) return res.status(400).json({ error: 'Choose a valid offer type.' });
    if (!/^\d{1,6}$/.test(teamNumber)) return res.status(400).json({ error: 'Enter a valid lookup number.' });
    const team = await lookupTeam(program, teamNumber);
    res.json({ team: { program, teamNumber, ...team } });
  } catch (err) {
    next(err);
  }
});

app.get('/api/notifications', requireAuth, async (req, res, next) => {
  try {
    const messages = await pool.query(
      `SELECT COUNT(*)::int AS count FROM messages WHERE receiver_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );
    const buyerOrders = await pool.query(
      `SELECT COUNT(*)::int AS count FROM orders
       WHERE buyer_id = $1 AND status IN ('paid', 'paid_demo', 'shipped') AND buyer_confirmed = FALSE`,
      [req.user.id]
    );
    const sellerOrders = await pool.query(
      `SELECT COUNT(*)::int AS count FROM orders
       WHERE seller_id = $1 AND status IN ('paid', 'paid_demo', 'shipped') AND seller_confirmed = FALSE`,
      [req.user.id]
    );
    let adminReports = { rows: [{ count: 0 }] };
    if (req.user.role === 'admin') {
      adminReports = await pool.query(`SELECT COUNT(*)::int AS count FROM reports WHERE status = 'open'`);
    }
    res.json({
      notifications: {
        messages: messages.rows[0].count,
        orders: buyerOrders.rows[0].count + sellerOrders.rows[0].count,
        admin: adminReports.rows[0].count
      }
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const program = normalizeProgram(req.body.program) || 'FTC';
    const teamNumber = String(req.body.teamNumber || '').trim();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters.' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (teamNumber && !/^\d{1,6}$/.test(teamNumber)) return res.status(400).json({ error: 'Enter a valid lookup number.' });
    if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters and include uppercase, lowercase, and a number.' });
    }

    if (teamNumber) {
      const existingTeam = await pool.query(
        `SELECT id FROM users WHERE program = $1 AND team_number = $2 LIMIT 1`,
        [program, teamNumber]
      );
      if (existingTeam.rowCount) {
        return res.status(409).json({ error: `An account already exists for ${program} team ${teamNumber}.` });
      }
    }

    let team = emptyTeamLookup();
    if (TEAM_VERIFY_REQUIRED && teamNumber) {
      team = await lookupTeam(program, teamNumber);
    }
    if (TEAM_VERIFY_REQUIRED && teamNumber && !team.verified) {
      return res.status(400).json({
        error: `Could not verify ${program} team ${teamNumber}. Check the number or configure a trusted team stats source.`
      });
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS user_count,
              COUNT(*) FILTER (WHERE role = 'admin')::int AS admin_count
       FROM users`
    );
    const isFirstUser = countResult.rows[0].user_count === 0;
    const hasAdmin = countResult.rows[0].admin_count > 0;
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const role = !hasAdmin && (!adminEmail || adminEmail === email) ? 'admin' : 'user';
    const passwordHash = await bcrypt.hash(password, 12);
    const token = verificationToken();

    const result = await pool.query(
      `INSERT INTO users
       (name, email, program, team_number, team_name, team_location, team_verified, team_verified_at, team_stats,
        email_verified, email_verification_token, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, name, email, program, team_number, team_name, team_location, team_verified, team_stats,
                 email_verified, role, banned, created_at`,
      [
        name,
        email,
        program,
        teamNumber || null,
        team.name,
        team.location,
        team.verified,
        team.verified ? new Date() : null,
        team.stats,
        role === 'admin' || !EMAIL_VERIFICATION_REQUIRED,
        role === 'admin' || !EMAIL_VERIFICATION_REQUIRED ? null : token,
        passwordHash,
        role
      ]
    );

    const user = result.rows[0];
    if (!user.email_verified) queueVerificationEmail(user, token);
    if (teamNumber && !TEAM_VERIFY_REQUIRED) queueTeamLookup(user.id, program, teamNumber);
    req.session.userId = user.id;
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    if (err.code === '23505') {
      if (err.constraint === 'idx_users_single_admin') {
        return res.status(409).json({ error: 'An admin account already exists.' });
      }
      const detail = String(err.detail || '');
      if (detail.includes('team_number') || detail.includes('program')) {
        return res.status(409).json({ error: 'That team already has an account.' });
      }
      return res.status(409).json({ error: 'That email is already registered.' });
    }
    next(err);
  }
});

app.get('/api/auth/verify-email', async (req, res, next) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).send('Missing verification token.');
    const result = await pool.query(
      `UPDATE users
       SET email_verified = TRUE, email_verification_token = NULL, updated_at = NOW()
       WHERE email_verification_token = $1
       RETURNING id`,
      [token]
    );
    if (!result.rowCount) return res.status(400).send('Invalid or expired verification token.');
    res.redirect('/?verified=email');
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/resend-verification', requireAuth, async (req, res, next) => {
  try {
    if (req.user.email_verified) return res.json({ ok: true, alreadyVerified: true });
    const token = verificationToken();
    const result = await pool.query(
      `UPDATE users SET email_verification_token = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, program, team_number, team_name, team_location, team_verified, team_stats,
                 email_verified, role, banned, created_at`,
      [token, req.user.id]
    );
    await sendVerificationEmail(result.rows[0], token);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!result.rowCount) return res.status(401).json({ error: 'Invalid email or password.' });

    const user = result.rows[0];
    if (user.banned) return res.status(403).json({ error: 'This account has been banned.' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/listings', async (req, res, next) => {
  try {
    const params = [];
    const where = [`l.status = 'active'`, `u.banned = FALSE`];

    if (req.query.search) {
      params.push(`%${String(req.query.search).trim()}%`);
      where.push(`(l.title ILIKE $${params.length} OR l.description ILIKE $${params.length})`);
    }
    if (req.query.category) {
      params.push(String(req.query.category).trim());
      where.push(`l.category = $${params.length}`);
    }
    if (req.query.program) {
      const program = normalizeProgram(req.query.program);
      if (program) {
        params.push(program);
        where.push(`l.program = $${params.length}`);
      }
    }
    if (req.query.location) {
      params.push(`%${String(req.query.location).trim()}%`);
      where.push(`l.location ILIKE $${params.length}`);
    }
    if (req.query.minPrice) {
      params.push(Math.round(Number(req.query.minPrice) * 100));
      where.push(`l.price_cents >= $${params.length}`);
    }
    if (req.query.maxPrice) {
      params.push(Math.round(Number(req.query.maxPrice) * 100));
      where.push(`l.price_cents <= $${params.length}`);
    }

    let orderBy = 'l.created_at DESC';
    if (req.query.sort === 'price_asc') orderBy = 'l.price_cents ASC, l.created_at DESC';
    if (req.query.sort === 'price_desc') orderBy = 'l.price_cents DESC, l.created_at DESC';

    const result = await pool.query(
      `SELECT l.*, u.name AS seller_name, u.email AS seller_email
       FROM listings l
       JOIN users u ON u.id = l.seller_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT 100`,
      params
    );
    res.json({ listings: result.rows.map(normalizeListing) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/listings/:id', async (req, res, next) => {
  try {
    const adminCanSeeDeleted = req.user?.role === 'admin';
    const result = await pool.query(
      `SELECT l.*, u.name AS seller_name, u.email AS seller_email
       FROM listings l
       JOIN users u ON u.id = l.seller_id
       WHERE l.id = $1 ${adminCanSeeDeleted ? '' : `AND l.status <> 'deleted'`}`,
      [req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Listing not found.' });
    res.json({ listing: normalizeListing(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/listings', requireAuth, requireAdmin, requireVerifiedEmail, upload.single('image'), async (req, res, next) => {
  try {
    const program = normalizeProgram(req.body.program) || req.user.program || 'FTC';
    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim();
    const price = Number(req.body.price || 0);
    const rawCategory = String(req.body.category || '').trim();
    const customCategory = String(req.body.customCategory || '').trim();
    const category = rawCategory === 'Other' ? (customCategory || 'Other') : (rawCategory || 'Other');
    const location = String(req.body.location || '').trim() || 'Worldwide';
    const condition = String(req.body.condition || '').trim() || 'Used';
    const currency = String(req.body.currency || 'USD').trim().toUpperCase().slice(0, 3) || 'USD';

    if (title.length < 3) return res.status(400).json({ error: 'Title must be at least 3 characters.' });
    if (!PROGRAMS[program]) return res.status(400).json({ error: 'Choose a valid offer type.' });
    if (description.length < 10) return res.status(400).json({ error: 'Description must be at least 10 characters.' });
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Enter a valid price.' });
    if (category.length < 2 || category.length > 40) return res.status(400).json({ error: 'Category must be 2 to 40 characters.' });

    let imageUrl = String(req.body.imageUrl || '').trim();
    if (req.file) imageUrl = await uploadListingImage(req.file);

    const result = await pool.query(
      `INSERT INTO listings
       (seller_id, program, title, description, price_cents, currency, category, location, item_condition, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.user.id, program, title, description, Math.round(price * 100), currency, category, location, condition, imageUrl || null]
    );

    const seller = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.id]);
    res.status(201).json({ listing: normalizeListing({ ...result.rows[0], seller_name: seller.rows[0].name, seller_email: seller.rows[0].email }) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/listings/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Listing not found.' });
    const listing = result.rows[0];
    if (listing.seller_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'You can only delete your own listings.' });
    await pool.query(`UPDATE listings SET status = 'deleted', updated_at = NOW() WHERE id = $1`, [listing.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/listings/:id/report', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 5) return res.status(400).json({ error: 'Please give a short reason.' });
    const listing = await pool.query('SELECT id FROM listings WHERE id = $1 AND status <> $2', [req.params.id, 'deleted']);
    if (!listing.rowCount) return res.status(404).json({ error: 'Listing not found.' });
    await pool.query(
      `INSERT INTO reports (listing_id, reporter_id, reason) VALUES ($1, $2, $3)`,
      [req.params.id, req.user.id, reason]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/messages', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const listingId = Number(req.body.listingId);
    const body = String(req.body.body || '').trim();
    let receiverId = Number(req.body.receiverId || 0);

    if (!body || body.length > 2000) return res.status(400).json({ error: 'Message must be 1 to 2000 characters.' });

    if (listingId && !receiverId) {
      const listing = await pool.query('SELECT seller_id FROM listings WHERE id = $1 AND status <> $2', [listingId, 'deleted']);
      if (!listing.rowCount) return res.status(404).json({ error: 'Listing not found.' });
      receiverId = listing.rows[0].seller_id;
      if (receiverId === req.user.id) return res.status(400).json({ error: 'You cannot message yourself about your own listing.' });
    }

    if (!receiverId) return res.status(400).json({ error: 'Missing receiver.' });
    const receiver = await pool.query('SELECT id, banned FROM users WHERE id = $1', [receiverId]);
    if (!receiver.rowCount || receiver.rows[0].banned) return res.status(404).json({ error: 'Receiver not found.' });

    const result = await pool.query(
      `INSERT INTO messages (listing_id, sender_id, receiver_id, body)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [listingId || null, req.user.id, receiverId, body]
    );
    res.status(201).json({ message: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.get('/api/messages/threads', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT m.*, l.title AS listing_title,
              s.name AS sender_name, r.name AS receiver_name
       FROM messages m
       LEFT JOIN listings l ON l.id = m.listing_id
       JOIN users s ON s.id = m.sender_id
       JOIN users r ON r.id = m.receiver_id
       WHERE m.sender_id = $1 OR m.receiver_id = $1
       ORDER BY m.created_at DESC
       LIMIT 250`,
      [req.user.id]
    );

    const map = new Map();
    for (const msg of result.rows) {
      const otherId = msg.sender_id === req.user.id ? msg.receiver_id : msg.sender_id;
      const otherName = msg.sender_id === req.user.id ? msg.receiver_name : msg.sender_name;
      const key = `${msg.listing_id || 'general'}:${otherId}`;
      if (!map.has(key)) {
        map.set(key, {
          listingId: msg.listing_id,
          listingTitle: msg.listing_title || 'General message',
          otherUserId: otherId,
          otherName,
          latestBody: msg.body,
          latestAt: msg.created_at,
          unread: 0
        });
      }
      if (msg.receiver_id === req.user.id && !msg.read_at) map.get(key).unread += 1;
    }
    res.json({ threads: Array.from(map.values()) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/messages/thread', requireAuth, async (req, res, next) => {
  try {
    const listingId = req.query.listingId ? Number(req.query.listingId) : null;
    const otherUserId = Number(req.query.otherUserId);
    if (!otherUserId) return res.status(400).json({ error: 'Missing otherUserId.' });

    const params = [req.user.id, otherUserId];
    let listingClause = 'm.listing_id IS NULL';
    if (listingId) {
      params.push(listingId);
      listingClause = `m.listing_id = $3`;
    }

    const result = await pool.query(
      `SELECT m.*, s.name AS sender_name, r.name AS receiver_name
       FROM messages m
       JOIN users s ON s.id = m.sender_id
       JOIN users r ON r.id = m.receiver_id
       WHERE ${listingClause}
         AND ((m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1))
       ORDER BY m.created_at ASC`,
      params
    );
    await pool.query(
      `UPDATE messages
       SET read_at = COALESCE(read_at, NOW())
       WHERE receiver_id = $1 AND sender_id = $2 AND ${listingId ? 'listing_id = $3' : 'listing_id IS NULL'}`,
      params
    );
    res.json({ messages: result.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/api/listings/:id/buy', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const listingId = Number(req.params.id);
    const shipping = {
      name: String(req.body.shippingName || '').trim(),
      address1: String(req.body.shippingAddress1 || '').trim(),
      address2: String(req.body.shippingAddress2 || '').trim(),
      city: String(req.body.shippingCity || '').trim(),
      state: String(req.body.shippingState || '').trim(),
      postal: String(req.body.shippingPostal || '').trim(),
      country: String(req.body.shippingCountry || '').trim()
    };

    if (!shipping.name || !shipping.address1 || !shipping.city || !shipping.postal || !shipping.country) {
      return res.status(400).json({ error: 'Please complete the required shipping fields.' });
    }

    await client.query('BEGIN');
    const listingResult = await client.query(
      `SELECT l.*, u.email AS seller_email, u.name AS seller_name
       FROM listings l JOIN users u ON u.id = l.seller_id
       WHERE l.id = $1 FOR UPDATE`,
      [listingId]
    );
    if (!listingResult.rowCount) throw Object.assign(new Error('Listing not found.'), { status: 404 });
    const listing = listingResult.rows[0];
    if (listing.status !== 'active') throw Object.assign(new Error('This item is no longer available.'), { status: 409 });
    if (listing.seller_id === req.user.id) throw Object.assign(new Error('You cannot buy your own listing.'), { status: 400 });

    const orderResult = await client.query(
      `INSERT INTO orders
       (listing_id, buyer_id, seller_id, amount_cents, currency, status, payment_provider,
        shipping_name, shipping_address1, shipping_address2, shipping_city, shipping_state, shipping_postal, shipping_country)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [listing.id, req.user.id, listing.seller_id, listing.price_cents, listing.currency, stripe ? 'pending_payment' : 'paid_demo', stripe ? 'stripe' : 'demo',
       shipping.name, shipping.address1, shipping.address2, shipping.city, shipping.state, shipping.postal, shipping.country]
    );
    const order = orderResult.rows[0];

    if (!stripe) {
      await client.query(`UPDATE listings SET status = 'sold', updated_at = NOW() WHERE id = $1`, [listing.id]);
      await client.query(
        `INSERT INTO messages (listing_id, order_id, sender_id, receiver_id, body)
         VALUES ($1, $2, $3, $4, $5)`,
        [listing.id, order.id, req.user.id, listing.seller_id, `I reserved this offer. Name: ${shipping.name}. Pickup area: ${shipping.postal}.`]
      );
      await client.query('COMMIT');
      return res.status(201).json({ demo: true, order });
    }

    const sessionObj = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: listing.currency.toLowerCase(),
          unit_amount: listing.price_cents,
          product_data: {
            name: listing.title,
            description: listing.description.slice(0, 500),
            images: listing.image_url && listing.image_url.startsWith('http') ? [listing.image_url] : []
          }
        }
      }],
      metadata: {
        orderId: String(order.id),
        listingId: String(listing.id),
        buyerId: String(req.user.id),
        sellerId: String(listing.seller_id)
      },
      success_url: `${CLIENT_BASE_URL}/?payment=success`,
      cancel_url: `${CLIENT_BASE_URL}/?payment=cancelled`
    });

    await client.query(`UPDATE orders SET payment_session_id = $1, updated_at = NOW() WHERE id = $2`, [sessionObj.id, order.id]);
    await client.query('COMMIT');
    res.status(201).json({ checkoutUrl: sessionObj.url, orderId: order.id });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.get('/api/orders', requireAuth, async (req, res, next) => {
  try {
    const role = req.query.role === 'seller' && req.user.role === 'admin' ? 'seller' : 'buyer';
    const column = role === 'seller' ? 'o.seller_id' : 'o.buyer_id';
    const result = await pool.query(
      `SELECT o.*, l.title AS listing_title, l.image_url,
              buyer.name AS buyer_name, seller.name AS seller_name
       FROM orders o
       JOIN listings l ON l.id = o.listing_id
       JOIN users buyer ON buyer.id = o.buyer_id
       JOIN users seller ON seller.id = o.seller_id
       WHERE ${column} = $1
       ORDER BY o.created_at DESC
       LIMIT 100`,
      [req.user.id]
    );
    res.json({ orders: result.rows });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/orders/:id/shipping', requireAuth, async (req, res, next) => {
  try {
    const trackingNumber = String(req.body.trackingNumber || '').trim();
    const carrier = String(req.body.carrier || '').trim();
    const labelUrl = String(req.body.labelUrl || '').trim();
    if (!trackingNumber && !labelUrl) return res.status(400).json({ error: 'Add a tracking number or label URL.' });

    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!order.rowCount) return res.status(404).json({ error: 'Order not found.' });
    if (order.rows[0].seller_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the seller can update shipping.' });

    const result = await pool.query(
      `UPDATE orders
       SET tracking_number = $1, carrier = $2, label_url = $3, status = 'shipped', updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [trackingNumber || null, carrier || null, labelUrl || null, req.params.id]
    );

    await pool.query(
      `INSERT INTO messages (listing_id, order_id, sender_id, receiver_id, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [order.rows[0].listing_id, order.rows[0].id, req.user.id, order.rows[0].buyer_id,
       `Shipping updated. ${carrier ? `Carrier: ${carrier}. ` : ''}${trackingNumber ? `Tracking: ${trackingNumber}.` : ''}`]
    );

    res.json({ order: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/orders/:id/confirm', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!orderResult.rowCount) throw Object.assign(new Error('Order not found.'), { status: 404 });
    const order = orderResult.rows[0];
    if (![order.buyer_id, order.seller_id].includes(req.user.id) && req.user.role !== 'admin') {
      throw Object.assign(new Error('You are not part of this order.'), { status: 403 });
    }
    if (!['paid', 'paid_demo', 'shipped', 'completed'].includes(order.status)) {
      throw Object.assign(new Error('This order cannot be confirmed yet.'), { status: 409 });
    }

    const updates = [];
    if (req.user.id === order.buyer_id || req.user.role === 'admin') {
      updates.push(`buyer_confirmed = TRUE`, `buyer_confirmed_at = COALESCE(buyer_confirmed_at, NOW())`);
    }
    if (req.user.id === order.seller_id || req.user.role === 'admin') {
      updates.push(`seller_confirmed = TRUE`, `seller_confirmed_at = COALESCE(seller_confirmed_at, NOW())`);
    }
    if (!updates.length) throw Object.assign(new Error('Nothing to confirm.'), { status: 400 });

    const updated = await client.query(
      `UPDATE orders SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [order.id]
    );
    const nextOrder = updated.rows[0];
    if (nextOrder.buyer_confirmed && nextOrder.seller_confirmed && nextOrder.status !== 'completed') {
      const completed = await client.query(
        `UPDATE orders SET status = 'completed', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [order.id]
      );
      await client.query(
        `INSERT INTO messages (listing_id, order_id, sender_id, receiver_id, body)
         VALUES ($1, $2, $3, $4, $5), ($1, $2, $3, $6, $5)`,
        [order.listing_id, order.id, req.user.id, order.buyer_id, 'Both sides confirmed this sale. The order is complete.', order.seller_id]
      );
      await client.query('COMMIT');
      return res.json({ order: completed.rows[0] });
    }

    const receiverId = req.user.id === order.buyer_id ? order.seller_id : order.buyer_id;
    await client.query(
      `INSERT INTO messages (listing_id, order_id, sender_id, receiver_id, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [order.listing_id, order.id, req.user.id, receiverId, 'I confirmed my side of this sale.']
    );
    await client.query('COMMIT');
    res.json({ order: nextOrder });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.get('/api/admin/reports', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT reports.*, l.title AS listing_title, l.status AS listing_status,
              reporter.name AS reporter_name,
              seller.id AS seller_id, seller.name AS seller_name, seller.email AS seller_email, seller.banned AS seller_banned
       FROM reports
       JOIN listings l ON l.id = reports.listing_id
       JOIN users reporter ON reporter.id = reports.reporter_id
       JOIN users seller ON seller.id = l.seller_id
       ORDER BY reports.created_at DESC
       LIMIT 200`
    );
    res.json({ reports: result.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const [users, listings, orders, reports, recentUsers, recentOrders] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE banned = FALSE`),
      pool.query(`SELECT COUNT(*)::int AS count FROM listings WHERE status = 'active'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM orders WHERE status <> 'cancelled'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM reports WHERE status = 'open'`),
      pool.query(
        `SELECT id, name, email, program, team_number, team_name, team_location, team_verified, team_stats,
                email_verified, role, banned, created_at
         FROM users ORDER BY created_at DESC LIMIT 25`
      ),
      pool.query(
        `SELECT o.*, l.title AS listing_title, buyer.name AS buyer_name, seller.name AS seller_name
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
         JOIN users buyer ON buyer.id = o.buyer_id
         JOIN users seller ON seller.id = o.seller_id
         ORDER BY o.created_at DESC LIMIT 25`
      )
    ]);

    res.json({
      stats: {
        users: users.rows[0].count,
        listings: listings.rows[0].count,
        orders: orders.rows[0].count,
        openReports: reports.rows[0].count
      },
      users: recentUsers.rows,
      orders: recentOrders.rows
    });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/admin/reports/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const status = ['open', 'resolved', 'dismissed'].includes(req.body.status) ? req.body.status : 'resolved';
    const adminNote = String(req.body.adminNote || '').trim();
    const reportResult = await pool.query(
      `SELECT reports.*, listings.seller_id
       FROM reports JOIN listings ON listings.id = reports.listing_id
       WHERE reports.id = $1`,
      [req.params.id]
    );
    if (!reportResult.rowCount) return res.status(404).json({ error: 'Report not found.' });
    const report = reportResult.rows[0];

    if (req.body.deleteListing) {
      await pool.query(`UPDATE listings SET status = 'deleted', updated_at = NOW() WHERE id = $1`, [report.listing_id]);
    }
    if (req.body.banSeller) {
      await pool.query(`UPDATE users SET banned = TRUE, updated_at = NOW() WHERE id = $1`, [report.seller_id]);
      await pool.query(`UPDATE listings SET status = 'deleted', updated_at = NOW() WHERE seller_id = $1 AND status = 'active'`, [report.seller_id]);
    }

    const result = await pool.query(
      `UPDATE reports SET status = $1, admin_note = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [status, adminNote || null, req.params.id]
    );
    res.json({ report: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Emerald City Resale running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
