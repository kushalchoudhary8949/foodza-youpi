# YOUPI PG V2 — Deployment & Installation Guide

This document describes how to deploy and run the clean distributable **YOUPI PG V2** package.

---

## 1. Prerequisites

- **Operating System**: Linux (Ubuntu 22.04+ / Debian 12+), macOS, or Windows 10/11 / Windows Server.
- **Node.js**: Version `>= 20.0.0` (LTS recommended).
- **Package Manager**: `npm` (included with Node.js).
- **Network Ports**:
  - `6100`: Payment Core API
  - `7000`: Checkout Portal & `youpi.js` SDK host
  - `6001`: Merchant Admin Panel
  - `5000`: Demo Coin Wallet Store (Reference Implementation)
  - `6002`: SMS Observer
  - `6003`: Gmail Observer
  - `8090`: Control Center Supervisor

---

## 2. Installation Steps

### Step 1: Extract / Clone Package
Ensure you are in the package root directory:
```bash
cd "YOUPI PG PACKAGE"
```

### Step 2: Configure Environment
Copy the clean template to `.env`:
```bash
cp .env.example .env
```
Open `.env` in your editor and configure:
1. `ENCRYPTION_MASTER_KEY`: Generate a 64-character hex key (e.g. `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`).
2. `JWT_SECRET`: Random string at least 32 characters.
3. `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD`: Credentials for your Merchant Admin dashboard.
4. `BASE_PAYMENT_API_URL` and `BASE_CHECKOUT_URL`: Your public domain or localhost URLs.

### Step 3: Install Dependencies
```bash
npm install
```

### Step 4: Initialize Fresh Database
Run the automated database setup to initialize schema and seed the default merchant and receiving account:
```bash
npm run db:setup
```
*(Creates `data/youpi_pg.sqlite` in clean state with 0 transactions).*

### Step 5: Start the System

#### Development / Demonstration Mode:
```bash
npm run dev
```
Starts all services with live reload and console aggregation under the Control Center at `http://localhost:8090`.

#### Production Mode:
```bash
npm run start
```
Starts services in background daemon mode.

---

## 3. Verifying Your Installation

1. **Checkout Portal & SDK**:
   Open `http://localhost:7000/youpi.js` — you should see the official JavaScript SDK.
2. **Demo Store**:
   Open `http://localhost:5000` — you should see the reference YOUPI Store with the interactive buy button and Developer Guide.
3. **Merchant Admin**:
   Open `http://localhost:6001` and log in with your admin credentials from `.env`.
   Configure your active UPI ID and payee name in the Receiving Accounts tab.
4. **Health Check**:
   `curl http://localhost:6100/health` returns `{"status":"UP"}`.

---

## 4. Production Domain & SSL (Cloudflare / NGINX)

For production deployment:
1. Terminate SSL at your reverse proxy (NGINX, Caddy, or Cloudflare Tunnel).
2. Point your public domain (e.g. `pay.yourdomain.com`) to port `7000` (Checkout Portal) or `6100` (Payment API).
   *The Checkout Portal automatically proxies all `/api/*` requests to the Payment API.*
3. Update `BASE_PAYMENT_API_URL` and `BASE_CHECKOUT_URL` in `.env` to match your public HTTPS domain.

---

## 5. Render.com Deployment

YOUPI PG V2 ships with a [`render.yaml`](../render.yaml) blueprint for one-click Render deployment.

### Key requirements

| Requirement | Detail |
| :--- | :--- |
| **Persistent Disk** | Mount at `/app/data` (1 GB minimum). The SQLite database, Gmail OAuth tokens, and all auto-generated secrets live here. Without it, every deploy wipes the database. |
| **`ENCRYPTION_MASTER_KEY`** | Exactly **64 hexadecimal characters** (32 bytes). Set in the Render Environment tab. See §5.1 below. |
| **`JWT_SECRET`** | At least 32 random characters. Set in the Render Environment tab. |
| **Port** | Render routes external traffic to container port **7000** (Checkout Portal). |

### 5.1 Setting ENCRYPTION_MASTER_KEY on Render

> **⚠ CRITICAL — read before generating a key:**
> `ENCRYPTION_MASTER_KEY` encrypts webhook secrets, Gmail OAuth tokens, and OTPs stored in the database. If you change this key after encrypted data has been written, those records become **permanently unreadable**. Generate once; keep it stable.

**Step 1 — Generate a secure key (run this locally):**
```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# or
openssl rand -hex 32
```
The output is exactly 64 lowercase hexadecimal characters. Example (do not use this):
```
a3f8c2d1e5b9074628f3a1e0d7c4b2a9f6e3d0c8b5a2f9e6d3c0b7a4f1e8d5
```

**Step 2 — Set it in Render:**
1. Open your Render dashboard → select your YOUPI PG service.
2. Go to **Environment** tab → **Add Environment Variable**.
3. Key: `ENCRYPTION_MASTER_KEY`
4. Value: *(paste the 64-hex-char output from Step 1)*
5. Click **Save Changes** → **Manual Deploy**.

**Step 3 — Verify the app starts cleanly:**
```bash
# In Render logs you should see:
# ✔ Encryption master key validated.
# [1/3] Loading persisted production database & settings...
```
If you see `[CONFIGURATION ERROR] PRODUCTION STARTUP FAILED`, the key is still wrong. Run `npm run validate:env` locally against your Render-equivalent `.env` to debug.

### 5.2 Persistent Disk configuration

In the Render dashboard:
1. Your service → **Disks** tab → **Add Disk**.
2. Name: `youpi-data`
3. Mount Path: `/app/data`
4. Size: 1 GB (increase if you expect many payment sessions).

Then set:
```
SQLITE_DB_PATH=/app/data/youpi_pg.sqlite
USE_SQLITE_FALLBACK=true
```

### 5.3 Full environment variable checklist for Render

Run the pre-flight validator locally before deploying:
```bash
# Copy your Render env values into a local .env.render file, then:
env $(cat .env.render | xargs) node scripts/validate-env.js
```

| Variable | Required | Notes |
| :--- | :--- | :--- |
| `ENCRYPTION_MASTER_KEY` | **Required** | 64 hex chars; generate once, never rotate |
| `JWT_SECRET` | **Required** | ≥ 32 random chars |
| `INITIAL_ADMIN_EMAIL` | Recommended | First-run admin login |
| `INITIAL_ADMIN_PASSWORD` | Recommended | First-run admin login (strong password) |
| `USE_SQLITE_FALLBACK` | `true` | Use SQLite (no PostgreSQL needed on Render) |
| `SQLITE_DB_PATH` | `/app/data/youpi_pg.sqlite` | Must be on the persistent disk |
| `YOUPI_MODE` | `production` | Set by render.yaml |
| `CLOUDFLARE_DOMAIN` | Required in production mode | Your Cloudflare root domain |
| `GMAIL_CLIENT_ID` | Optional | Required for Gmail bank alert observation |
| `GMAIL_CLIENT_SECRET` | Optional | Required for Gmail bank alert observation |
| `GMAIL_REDIRECT_URI` | Optional | Must be HTTPS; Google requires it |
| `ANDROID_ENROLLMENT_SECRET` | Optional | Auto-generated if unset |
| `CHECKOUT_FRAME_ANCESTORS` | Optional | Merchant storefront origin(s) for iframe CSP |
| `FOODZA_OTP_API_SECRET` | Optional | FoodZa integration only |
