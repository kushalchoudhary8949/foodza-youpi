#!/usr/bin/env node
/**
 * scripts/validate-env.js
 *
 * Pre-flight environment validation for YOUPI PG V2.
 *
 * Checks all required and recommended environment variables before startup.
 * Run directly:
 *   node scripts/validate-env.js
 *
 * Or as part of your CI/CD pipeline to catch misconfiguration before deploy.
 *
 * Exit codes:
 *   0 — All required variables are present and valid.
 *   1 — One or more required variables are missing or invalid.
 */

import crypto from 'node:crypto';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';

const errors = [];
const warnings = [];

function ok(label) {
  console.log(`  ${GREEN}✔${RESET} ${label}`);
}
function warn(label, hint) {
  console.log(`  ${YELLOW}⚠${RESET} ${label}`);
  if (hint) console.log(`      ${YELLOW}↳ ${hint}${RESET}`);
  warnings.push(label);
}
function fail(label, hint) {
  console.log(`  ${RED}✘${RESET} ${label}`);
  if (hint) console.log(`      ${RED}↳ ${hint}${RESET}`);
  errors.push(label);
}

// ── Example-file placeholder (must never be treated as a valid key) ───────────
const PLACEHOLDER_MASTER_KEY = 'REPLACE_WITH_64_RANDOM_HEX_CHARS_GENERATED_BY_crypto_randomBytes_32';

// ── Helper: generate a suggestion the operator can copy-paste ─────────────────
function suggestKey(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

console.log(`\n${BOLD}YOUPI PG V2 — Environment Pre-flight Validation${RESET}`);
console.log('═'.repeat(52));

// ── 1. ENCRYPTION_MASTER_KEY ──────────────────────────────────────────────────
{
  const key = (process.env.ENCRYPTION_MASTER_KEY || '').trim();
  const label = 'ENCRYPTION_MASTER_KEY';

  if (!key) {
    // Unset is ACCEPTABLE: the app auto-generates one under data/.secrets/
    // when a persistent data directory is available.  Warn but don't fail.
    warn(
      `${label} is not set`,
      'The app will auto-generate a key under data/.secrets/encryption_master_key. ' +
      'This is ONLY safe when /app/data is a persistent volume. ' +
      'If the volume is ephemeral, all encrypted records become unreadable after a restart. ' +
      `Suggested key: ${suggestKey()}`
    );
  } else if (key === PLACEHOLDER_MASTER_KEY) {
    fail(
      `${label} is still the .env.example placeholder value`,
      `Generate a real key: node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
    );
  } else if (!/^[0-9a-f]{64}$/i.test(key)) {
    fail(
      `${label} has ${key.length} character(s) — must be exactly 64 hexadecimal characters (32 bytes)`,
      `Current value starts with: ${key.slice(0, 8)}…\n` +
      `      Generate a valid key: node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
    );
  } else {
    ok(`${label} — 64 hex chars (AES-256 key) ✓`);
  }
}

// ── 2. JWT_SECRET ─────────────────────────────────────────────────────────────
{
  const val = (process.env.JWT_SECRET || '').trim();
  const label = 'JWT_SECRET';
  const WEAK_DEFAULTS = [
    'super_secret_jwt_key_change_in_production_min_32_chars',
    'secret',
    'changeme',
    'your-secret',
  ];

  if (!val) {
    fail(`${label} is not set`, `Generate: node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`);
  } else if (WEAK_DEFAULTS.some(d => val.toLowerCase().includes(d.toLowerCase()))) {
    fail(`${label} is using a default/example value`, 'Replace with a random secret of at least 32 characters.');
  } else if (val.length < 32) {
    fail(`${label} is too short (${val.length} chars; minimum 32)`, 'Use a longer, random secret.');
  } else {
    ok(`${label} — ${val.length} chars ✓`);
  }
}

// ── 3. INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD ──────────────────────────
{
  const email = (process.env.INITIAL_ADMIN_EMAIL || '').trim();
  const pass = (process.env.INITIAL_ADMIN_PASSWORD || '').trim();
  if (!email) {
    warn('INITIAL_ADMIN_EMAIL is not set', 'Defaults to admin@youpi.local — change before first login.');
  } else if (email === 'admin@youpi.local') {
    warn('INITIAL_ADMIN_EMAIL is still the example value', 'Set to your real admin email before deploy.');
  } else {
    ok(`INITIAL_ADMIN_EMAIL — ${email} ✓`);
  }

  if (!pass) {
    warn('INITIAL_ADMIN_PASSWORD is not set', 'Set a strong password before first login.');
  } else if (pass === 'AdminSecurePassword123!') {
    fail('INITIAL_ADMIN_PASSWORD is still the example password', 'Set a strong, unique password before deploy.');
  } else if (pass.length < 12) {
    warn(`INITIAL_ADMIN_PASSWORD is short (${pass.length} chars)`, 'Use at least 12 characters with mixed case and symbols.');
  } else {
    ok('INITIAL_ADMIN_PASSWORD — set ✓');
  }
}

// ── 4. Database ───────────────────────────────────────────────────────────────
{
  const useSqlite = (process.env.USE_SQLITE_FALLBACK || 'true').trim().toLowerCase() === 'true';
  const sqlitePath = (process.env.SQLITE_DB_PATH || './data/youpi_pg.sqlite').trim();
  const dbUrl = (process.env.DATABASE_URL || '').trim();

  if (useSqlite) {
    ok(`USE_SQLITE_FALLBACK=true — SQLite at ${sqlitePath}`);
    if (sqlitePath.startsWith('./') || sqlitePath.startsWith('../')) {
      warn(
        'SQLITE_DB_PATH is a relative path',
        'On Render/Docker, use an absolute path like /app/data/youpi_pg.sqlite to ensure ' +
        'the file lands on the persistent volume, not inside the container image layer.'
      );
    }
  } else if (!dbUrl) {
    fail('DATABASE_URL is not set and USE_SQLITE_FALLBACK is false', 'Set a PostgreSQL connection string or enable SQLite fallback.');
  } else {
    ok(`DATABASE_URL — ${dbUrl.replace(/:\/\/[^@]+@/, '://<credentials>@')} ✓`);
  }
}

// ── 5. Gmail Observer (optional service) ─────────────────────────────────────
{
  const clientId = (process.env.GMAIL_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GMAIL_CLIENT_SECRET || '').trim();
  const redirectUri = (process.env.GMAIL_REDIRECT_URI || '').trim();

  if (!clientId && !clientSecret) {
    warn('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not set', 'Gmail observer will start but OAuth will fail. Set if you need Gmail bank alerts.');
  } else if (!clientId) {
    fail('GMAIL_CLIENT_ID is not set (GMAIL_CLIENT_SECRET is set)', 'Set the matching OAuth client ID.');
  } else if (!clientSecret) {
    fail('GMAIL_CLIENT_SECRET is not set (GMAIL_CLIENT_ID is set)', 'Set the matching OAuth client secret.');
  } else {
    ok('GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET — set ✓');
  }

  if (clientId && redirectUri && !redirectUri.startsWith('https://')) {
    warn(`GMAIL_REDIRECT_URI is not HTTPS: ${redirectUri}`, 'Google OAuth requires HTTPS redirect URIs in production.');
  } else if (clientId && redirectUri) {
    ok(`GMAIL_REDIRECT_URI — ${redirectUri} ✓`);
  }
}

// ── 6. Android Observer security ─────────────────────────────────────────────
{
  const secret = (process.env.ANDROID_ENROLLMENT_SECRET || '').trim();
  if (!secret) {
    ok('ANDROID_ENROLLMENT_SECRET — unset (auto-generated under data/.secrets/)');
  } else if (secret === 'android_pairing_enrollment_secret_key_32_chars') {
    fail('ANDROID_ENROLLMENT_SECRET is still the example placeholder', 'Generate a real secret or leave unset for auto-generation.');
  } else if (secret.length < 16) {
    warn(`ANDROID_ENROLLMENT_SECRET is short (${secret.length} chars)`, 'Use at least 32 random characters.');
  } else {
    ok(`ANDROID_ENROLLMENT_SECRET — ${secret.length} chars ✓`);
  }
}

// ── 7. Render-specific: data persistence hint ─────────────────────────────────
{
  // Render sets RENDER=true in its build/run environment.
  const onRender = process.env.RENDER === 'true';
  const sqlitePath = (process.env.SQLITE_DB_PATH || './data/youpi_pg.sqlite').trim();
  if (onRender && !sqlitePath.startsWith('/app/data')) {
    warn(
      'Running on Render but SQLITE_DB_PATH does not point to /app/data',
      'Configure a Render Persistent Disk mounted at /app/data and set SQLITE_DB_PATH=/app/data/youpi_pg.sqlite. ' +
      'Without the disk, the SQLite database and all auto-generated secrets are lost on every deploy.'
    );
  }
}

// ── 8. Webhook settings ───────────────────────────────────────────────────────
{
  const allowPrivate = (process.env.YOUPI_ALLOW_PRIVATE_WEBHOOKS || '').trim().toLowerCase();
  if (allowPrivate === 'true') {
    const mode = (process.env.NODE_ENV || '').toLowerCase();
    if (mode === 'production') {
      warn('YOUPI_ALLOW_PRIVATE_WEBHOOKS=true in production', 'Permits SSRF to loopback/LAN endpoints. Only keep if you have a self-hosted LAN merchant target.');
    } else {
      ok('YOUPI_ALLOW_PRIVATE_WEBHOOKS=true (development) ✓');
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log('═'.repeat(52));
if (errors.length === 0 && warnings.length === 0) {
  console.log(`${GREEN}${BOLD}✔ All checks passed — environment is ready.${RESET}\n`);
  process.exit(0);
} else if (errors.length === 0) {
  console.log(`${YELLOW}${BOLD}⚠ ${warnings.length} warning(s) — review before deploying to production.${RESET}\n`);
  process.exit(0);
} else {
  console.log(`${RED}${BOLD}✘ ${errors.length} error(s) must be fixed before the app can start.${RESET}`);
  if (warnings.length > 0) console.log(`${YELLOW}  ${warnings.length} additional warning(s).${RESET}`);
  console.log('');
  console.log(`${BOLD}Quick fix for ENCRYPTION_MASTER_KEY:${RESET}`);
  console.log(`  node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`);
  console.log(`  → Copy the output (64 hex chars) into your Render Environment Variables.`);
  console.log('');
  process.exit(1);
}
