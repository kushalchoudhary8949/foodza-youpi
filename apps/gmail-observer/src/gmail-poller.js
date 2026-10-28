import { PaymentObserverClient } from '@youpi/observer-sdk';
import { getObserverToken } from '@youpi/common';
import { BankEmailParser } from './parser.js';

function extractBodyFromGmailPayload(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    try {
      return Buffer.from(payload.body.data, 'base64url').toString('utf8');
    } catch {}
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        try {
          return Buffer.from(part.body.data, 'base64url').toString('utf8');
        } catch {}
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        try {
          const html = Buffer.from(part.body.data, 'base64url').toString('utf8');
          return html.replace(/<[^>]+>/g, ' ');
        } catch {}
      }
    }
    for (const part of payload.parts) {
      if (part.body?.data) {
        try {
          return Buffer.from(part.body.data, 'base64url').toString('utf8');
        } catch {}
      }
    }
  }
  return '';
}

function diagnosticCode(value, fallback) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized) ? normalized : fallback;
}

async function googleErrorCode(response) {
  try {
    const payload = await response.clone().json();
    const error = payload?.error;
    const code = typeof error === 'string' ? error : error?.status || error?.code;
    return diagnosticCode(code, `HTTP_${response.status}`);
  } catch {
    return `HTTP_${response.status}`;
  }
}

function safeReason(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized) ? normalized : null;
}

function paymentApiFailure(error) {
  const errorMessage = typeof error?.message === 'string' ? error.message : '';
  const responseMatch = errorMessage.match(/Observer submit failed \[HTTP (\d{3})\]:\s*([\s\S]*)$/);

  if (responseMatch) {
    const status = Number(responseMatch[1]);
    let reason = null;
    try {
      reason = safeReason(JSON.parse(responseMatch[2])?.reason);
    } catch {}

    if (status === 401 || status === 403) {
      return {
        code: `PAYMENT_API_AUTH_HTTP_${status}`,
        message: 'The Payment API rejected observer authentication.'
      };
    }
    if (status >= 500) {
      return {
        code: `PAYMENT_API_HTTP_${status}`,
        message: 'The Payment API returned a server error while accepting the observation.'
      };
    }
    return {
      code: reason ? `PAYMENT_API_REJECTED_${reason}` : `PAYMENT_API_HTTP_${status}`,
      message: 'The Payment API rejected the Gmail observation.'
    };
  }

  const networkCode = safeReason(error?.code);
  if (error?.name === 'TypeError' || networkCode) {
    return {
      code: networkCode ? `PAYMENT_API_NETWORK_${networkCode}` : 'PAYMENT_API_NETWORK_ERROR',
      message: 'The Gmail observer could not reach the Payment API.'
    };
  }

  return {
    code: 'PAYMENT_API_SUBMISSION_ERROR',
    message: 'The Gmail observation could not be submitted to the Payment API.'
  };
}

function createDiagnosticError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class GmailPoller {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   receivingAccountId?: string,
   *   pollIntervalMs?: number
   * }} options
   */
  constructor(options = {}) {
    this.apiBaseUrl = options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.receivingAccountId = options.receivingAccountId || '00000000-0000-0000-0000-000000000002';
    this.pollIntervalMs = options.pollIntervalMs || Number(process.env.GMAIL_POLL_INTERVAL_MS || 5000);
    this.observerClient = new PaymentObserverClient({
      apiBaseUrl: this.apiBaseUrl,
      sourceName: 'GMAIL'
    });

    this.isRunning = false;
    this.timer = null;
    this.lastPollAt = null;
    this.lastSuccessfulPollAt = null;
    this.lastPollError = null;
    this.observedCount = 0;
    this.credentials = null;
    this.cachedAccessToken = null;
    this.tokenExpiresAt = 0;
    this.processedMessageIds = new Set();
    this._isPolling = false;
  }

  setCredentials(creds) {
    const credentialsChanged = ['clientId', 'clientSecret', 'refreshToken']
      .some(key => creds[key] !== undefined && creds[key] !== this.credentials?.[key]);
    this.credentials = { ...(this.credentials || {}), ...creds };
    if (credentialsChanged) {
      this.cachedAccessToken = null;
      this.tokenExpiresAt = 0;
    }
  }

  recordPollError(code, message) {
    const normalizedCode = diagnosticCode(code, 'GMAIL_POLL_FAILED');
    this.lastPollError = {
      code: normalizedCode,
      message,
      at: new Date().toISOString()
    };
    if (this._lastLoggedPollErrorCode !== normalizedCode) {
      console.warn(`[Gmail Observer] ${normalizedCode}: ${message}`);
      this._lastLoggedPollErrorCode = normalizedCode;
    }
  }

  async fetchCredentialsFromPaymentApi() {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/admin/gmail/credentials`, { headers: { Authorization: `Bearer ${getObserverToken()}` } });
      if (res.ok) {
        const data = await res.json();
        const conf = data.gmailConfig || data;
        if (conf.refreshToken || conf.clientId) {
          this.setCredentials({
            clientId: conf.clientId,
            clientSecret: conf.clientSecret,
            refreshToken: conf.refreshToken,
            connectedEmail: conf.connectedEmail
          });
        }
        if (!this.credentials?.clientId || !this.credentials?.clientSecret || !this.credentials?.refreshToken) {
          this.recordPollError('MISSING_OAUTH_CREDENTIALS', 'Saved Gmail OAuth credentials are incomplete.');
          return false;
        }
        return true;
      } else {
        this.recordPollError(
          `PAYMENT_API_CREDENTIALS_HTTP_${res.status}`,
          'Unable to load saved Gmail OAuth credentials from the Payment API.'
        );
        return false;
      }
    } catch (err) {
      const code = diagnosticCode(err.code || err.name, 'REQUEST_FAILED');
      this.recordPollError(
        `PAYMENT_API_CREDENTIALS_${code}`,
        'Unable to load saved Gmail OAuth credentials from the Payment API.'
      );
      return false;
    }
  }

  async getAccessToken() {
    if (this.cachedAccessToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedAccessToken;
    }

    if (!this.credentials?.refreshToken || !this.credentials?.clientId || !this.credentials?.clientSecret) {
      const loaded = await this.fetchCredentialsFromPaymentApi();
      if (!loaded) return null;
    }

    const { clientId, clientSecret, refreshToken } = this.credentials || {};
    if (!clientId || !clientSecret || !refreshToken) {
      this.recordPollError('MISSING_OAUTH_CREDENTIALS', 'Saved Gmail OAuth credentials are incomplete.');
      return null;
    }

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }),
        signal: AbortSignal.timeout(8000)
      });

      if (!tokenRes.ok) {
        const code = await googleErrorCode(tokenRes);
        this.recordPollError(
          `GMAIL_TOKEN_REFRESH_${code}`,
          'Google rejected the Gmail OAuth refresh request; reconnect the Gmail account if this continues.'
        );
        return null;
      }

      const tokenData = await tokenRes.json();
      if (typeof tokenData.access_token !== 'string' || !tokenData.access_token) {
        this.recordPollError('GMAIL_TOKEN_RESPONSE_INVALID', 'Google returned no usable access token.');
        return null;
      }
      this.cachedAccessToken = tokenData.access_token;
      this.tokenExpiresAt = Date.now() + ((tokenData.expires_in || 3500) - 120) * 1000;
      return this.cachedAccessToken;
    } catch (err) {
      const code = diagnosticCode(err.code || err.name, 'REQUEST_FAILED');
      this.recordPollError(
        `GMAIL_TOKEN_REFRESH_${code}`,
        'The Gmail OAuth token refresh request failed.'
      );
      return null;
    }
  }

  async resolveActiveReceivingAccount() {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/pollers/active-window`, {
        headers: { Authorization: 'Bearer ' + getObserverToken() },
        signal: AbortSignal.timeout(1000)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.sessions && data.sessions.length > 0) {
          return data.sessions[0].receivingAccountId;
        }
      } else {
        this.recordPollError(
          `PAYMENT_API_ACTIVE_WINDOW_HTTP_${res.status}`,
          'The Payment API rejected the active payment-window lookup.'
        );
      }
    } catch (err) {
      const code = diagnosticCode(err.code || err.name, 'REQUEST_FAILED');
      this.recordPollError(
        `PAYMENT_API_ACTIVE_WINDOW_${code}`,
        'The Gmail observer could not load the active payment window.'
      );
    }
    return null;
  }

  /**
   * Ingests an email directly (e.g. from webhook, push notification, or manual poll).
   * @param {{ subject: string, body: string, date?: string | Date, from?: string, id?: string }} email
   */
  async processEmail(email) {
    if (!email || typeof email !== 'object' || Array.isArray(email) ||
        (email.subject !== undefined && typeof email.subject !== 'string') ||
        (email.body !== undefined && typeof email.body !== 'string')) {
      this.recordPollError('GMAIL_MESSAGE_MALFORMED', 'The Gmail message had an invalid subject or body.');
      return { accepted: false, ignored: true, reason: 'MALFORMED_MESSAGE' };
    }

    const subject = email.subject || '';
    const body = email.body || '';
    if (!subject.trim() && !body.trim()) {
      this.recordPollError('GMAIL_MESSAGE_MALFORMED', 'The Gmail message had no readable subject or body.');
      return { accepted: false, ignored: true, reason: 'MALFORMED_MESSAGE' };
    }

    let parsed = null;
    try {
      parsed = BankEmailParser.parse({ ...email, subject, body });
    } catch {
      this.recordPollError('GMAIL_MESSAGE_PARSE_ERROR', 'The Gmail message could not be parsed.');
      return { accepted: false, ignored: true, reason: 'PARSE_ERROR' };
    }

    if (!parsed) {
      return { accepted: false, ignored: true, reason: 'IRRELEVANT_EMAIL' };
    }

    const sender = email.from || email.sender;
    if (typeof sender !== 'string' || !sender.trim()) {
      this.recordPollError('GMAIL_MESSAGE_MISSING_SENDER', 'The payment-like Gmail message had no sender address.');
      return { accepted: false, ignored: true, reason: 'MISSING_SENDER' };
    }

    let targetAccountId = this.receivingAccountId;
    try {
      const activeAcct = await this.resolveActiveReceivingAccount();
      if (activeAcct) targetAccountId = activeAcct;
    } catch {}

    const rawContent = `${subject}\n${body}`.trim();

    try {
      const result = await this.observerClient.submitObservation({
        receivingAccountId: targetAccountId,
        amountPaise: parsed.amountPaise,
        amount: parsed.amount,
        observedAt: parsed.observedAt,
        bankReferenceNumber: parsed.bankReferenceNumber,
        senderVpa: parsed.senderVpa,
        sender,
        rawText: rawContent,
        rawPayload: {
          messageId: email.id || email.messageId || `gmail_${Date.now()}`,
          subject,
          body,
          snippet: parsed.rawSnippet || body.substring(0, 200),
          from: sender,
          sender,
          source: 'GMAIL',
          internalDate: email.internalDate || parsed.observedAt.getTime()
        }
      });

      if (result?.accepted !== true) {
        const reason = safeReason(result?.reason || result?.status);
        const code = reason ? `PAYMENT_API_REJECTED_${reason}` : 'PAYMENT_API_REJECTED_NOT_ACCEPTED';
        this.recordPollError(code, 'The Payment API did not accept the Gmail observation.');
        return { ...result, accepted: false };
      }

      this.observedCount += 1;
      return result;
    } catch (err) {
      const failure = paymentApiFailure(err);
      this.recordPollError(failure.code, failure.message);
      throw createDiagnosticError(failure.code, failure.message);
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Gmail Observer] Poller started (interval: ${this.pollIntervalMs}ms)`);

    // Run first poll cycle immediately
    this.pollCycle().catch(() => {});

    this.timer = setInterval(() => {
      this.pollCycle().catch(() => {});
    }, this.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this._isPolling = false;
    console.log('[Gmail Observer] Poller stopped.');
  }

  async pollCycle() {
    if (this._isPolling) return;
    this._isPolling = true;

    try {
      this.lastPollAt = new Date();
      const accessToken = await this.getAccessToken();
      if (!accessToken) return;

      const query = encodeURIComponent('subject:(credit OR credited OR received OR upi OR deposit OR alert)');
      const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${query}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000)
      });

      if (!listRes.ok) {
        if (listRes.status === 401) {
          this.cachedAccessToken = null;
        }
        const code = await googleErrorCode(listRes);
        this.recordPollError(
          `GMAIL_MESSAGE_LIST_${code}`,
          'Google rejected the Gmail message-list request.'
        );
        return;
      }

      const listData = await listRes.json();
      if (!listData || typeof listData !== 'object' ||
          (listData.messages !== undefined && !Array.isArray(listData.messages))) {
        this.recordPollError('GMAIL_MESSAGE_LIST_RESPONSE_INVALID', 'Google returned an invalid Gmail message-list response.');
        return;
      }
      this.lastSuccessfulPollAt = new Date();
      this.lastPollError = null;
      this._lastLoggedPollErrorCode = null;
      const messages = listData.messages || [];

      for (const m of messages) {
        if (!m || typeof m.id !== 'string' || !m.id) {
          this.recordPollError('GMAIL_MESSAGE_LIST_RESPONSE_INVALID', 'Google returned a Gmail message without a valid ID.');
          continue;
        }
        if (this.processedMessageIds.has(m.id)) continue;

        let messageStage = 'fetch';
        try {
          const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=full`, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(8000)
          });
          if (!msgRes.ok) {
            const code = await googleErrorCode(msgRes);
            this.recordPollError(
              `GMAIL_MESSAGE_FETCH_${code}`,
              'Google rejected a Gmail message fetch request.'
            );
            continue;
          }

          messageStage = 'parse';
          const msgData = await msgRes.json();
          if (!msgData || typeof msgData !== 'object' || Array.isArray(msgData)) {
            this.recordPollError('GMAIL_MESSAGE_RESPONSE_INVALID', 'Google returned an invalid Gmail message response.');
            continue;
          }
          const headers = Array.isArray(msgData.payload?.headers) ? msgData.payload.headers : [];
          const getHeader = name => headers.find(h =>
            typeof h?.name === 'string' && h.name.toLowerCase() === name
          )?.value;
          const from = getHeader('from') || '';
          const subject = getHeader('subject') || '';
          const dateStr = getHeader('date') || '';
          const body = extractBodyFromGmailPayload(msgData.payload) || msgData.snippet || '';

          messageStage = 'process';
          const result = await this.processEmail({
            id: m.id,
            messageId: m.id,
            subject,
            body,
            from,
            date: dateStr ? new Date(dateStr) : new Date(Number(msgData.internalDate || Date.now()))
          });

          if (result?.accepted === true || result?.ignored === true) {
            this.processedMessageIds.add(m.id);
            if (this.processedMessageIds.size > 500) {
              const firstKey = this.processedMessageIds.values().next().value;
              this.processedMessageIds.delete(firstKey);
            }
          }
        } catch (msgErr) {
          if (messageStage === 'fetch') {
            const code = diagnosticCode(msgErr.code || msgErr.name, 'REQUEST_FAILED');
            this.recordPollError(
              `GMAIL_MESSAGE_FETCH_NETWORK_${code}`,
              'The Gmail message could not be fetched from Google.'
            );
          } else if (messageStage === 'parse') {
            this.recordPollError('GMAIL_MESSAGE_RESPONSE_INVALID', 'Google returned an invalid Gmail message response.');
          } else if (typeof msgErr?.code === 'string' && msgErr.code.startsWith('PAYMENT_API_')) {
            this.recordPollError(msgErr.code, msgErr.message);
          } else {
            const code = diagnosticCode(msgErr?.code || msgErr?.name, 'PROCESSING_ERROR');
            this.recordPollError(
              `GMAIL_MESSAGE_PROCESS_${code}`,
              'The Gmail message could not be processed.'
            );
          }
        }
      }
    } catch (err) {
      const code = diagnosticCode(err.code || err.name, 'REQUEST_FAILED');
      this.recordPollError(`GMAIL_POLL_${code}`, 'The Gmail polling cycle failed.');
    } finally {
      this._isPolling = false;
    }
  }
}
