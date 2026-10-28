import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { startGmailObserver } from '../index.js';
import { GmailPoller } from '../gmail-poller.js';
import { BankEmailParser } from '../parser.js';
import { PaymentStatus, createOAuthState } from '@youpi/common';
import { TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';

async function withMockedFetch(mockFetch, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('Gmail Payment Observer Integration Tests', () => {
  let apiInstance;
  let gmailInstance;
  let gmailBaseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6198, testDb);
    gmailInstance = await startGmailObserver(6099, {
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      receivingAccountId: '00000000-0000-0000-0000-000000000002'
    });
    gmailBaseUrl = `http://localhost:${gmailInstance.port}`;
  });

  after(async () => {
    await gmailInstance.close();
    await apiInstance.close();
    testDb.close();
  });

  function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
      http.get(`${gmailBaseUrl}${path}`, { headers }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, text: data });
        });
      }).on('error', reject);
    });
  }

  describe('Bank Email Parser', () => {
    test('correctly parses HDFC credit notification email', () => {
      const email = {
        subject: 'ALERT: Account credited with Rs. 200.00',
        body: 'Dear Customer, your account has been credited with Rs. 200.00 on 08-Sep-2026. Ref no: UTR-HDFC-9911 from sender@upi.',
        from: 'alerts@hdfcbank.net'
      };

      const parsed = BankEmailParser.parse(email);
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 20000n);
      assert.equal(parsed.amount, '200.00');
      assert.equal(parsed.bankReferenceNumber, 'UTR-HDFC-9911');
      assert.equal(parsed.senderVpa, 'sender@upi');
    });

    test('correctly parses custom or alt-account emails like "20.00 received"', () => {
      const altEmail = {
        subject: '20.00 received',
        body: '20.00 received from alt account',
        from: 'alt@gmail.com'
      };

      const parsed = BankEmailParser.parse(altEmail);
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 2000n);
      assert.equal(parsed.amount, '20.00');
    });

    test('ignores debit notification emails', () => {
      const debitEmail = {
        subject: 'ALERT: Account debited with Rs. 500.00',
        body: 'Your account was debited for purchase at Amazon.',
        from: 'alerts@hdfcbank.net'
      };

      const parsed = BankEmailParser.parse(debitEmail);
      assert.equal(parsed, null);
    });
  });

  describe('Gmail Observer HTTP Service', () => {
    test('GET /health returns UP', async () => {
      const res = await get('/health');
      assert.equal(res.status, 200);
      const json = JSON.parse(res.text);
      assert.equal(json.status, 'UP');
      assert.equal(json.service, 'gmail-observer');
      assert.equal(json.isRunning, true);
      assert.equal(json.lastSuccessfulPollAt, null);
      assert.ok(Object.hasOwn(json, 'lastPollError'));
    });

    test('GET /oauth/url requires a token and returns a Google OAuth URL carrying a signed state', async () => {
      assert.equal((await get('/oauth/url')).status, 401);

      const res = await get('/oauth/url', { Authorization: `Bearer ${TEST_OBSERVER_TOKEN}` });
      assert.equal(res.status, 200);
      const json = JSON.parse(res.text);
      assert.ok(json.authUrl.includes('accounts.google.com/o/oauth2/v2/auth'));
      assert.ok(json.authUrl.includes('gmail.readonly'));
      assert.ok(new URL(json.authUrl).searchParams.get('state'));
      assert.ok(!json.redirectUri.includes('gauravtesting'));
    });

    test('GET /oauth/callback rejects a missing, forged or reused state', async () => {
      const bad = await get('/oauth/callback?code=abc');
      assert.equal(bad.status, 400);
      assert.ok(bad.text.includes('Invalid or expired OAuth state'));

      const forged = await get('/oauth/callback?code=abc&state=aaaa.9999999999999.bbbb');
      assert.ok(forged.text.includes('Invalid or expired OAuth state'));

      const previousClientId = process.env.GMAIL_CLIENT_ID;
      const previousClientSecret = process.env.GMAIL_CLIENT_SECRET;
      delete process.env.GMAIL_CLIENT_ID;
      delete process.env.GMAIL_CLIENT_SECRET;
      try {
        const state = createOAuthState();
        const first = await get(`/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
        assert.ok(!first.text.includes('Invalid or expired OAuth state'));
        assert.ok(first.text.includes('Missing Gmail OAuth Client ID or Client Secret'));
        const replay = await get(`/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
        assert.ok(replay.text.includes('Invalid or expired OAuth state'));
      } finally {
        if (previousClientId === undefined) delete process.env.GMAIL_CLIENT_ID;
        else process.env.GMAIL_CLIENT_ID = previousClientId;
        if (previousClientSecret === undefined) delete process.env.GMAIL_CLIENT_SECRET;
        else process.env.GMAIL_CLIENT_SECRET = previousClientSecret;
      }
    });

    test('End-to-End: processing bank email confirms active payment session in Payment API', async () => {
      // 1. Create a payment in Payment API
      const session = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'GMAIL-ORD-777',
        amountPaise: 20000n
      });

      apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

      // 2. Process matching incoming bank email via Gmail Observer
      const result = await gmailInstance.poller.processEmail({
        subject: 'Credit alert: Rs 200.00 received',
        body: 'Your account received Rs 200.00 from buyer@upi Ref: UTR-GMAIL-777',
        from: 'alerts@icicibank.com'
      });

      assert.ok(result);
      assert.equal(result.accepted, true);
      assert.equal(result.attribution.attributed, true);
      assert.equal(result.attribution.paymentSessionId, session.id);
      assert.equal(gmailInstance.poller.observedCount, 1);

      // Verify session updated to SUCCESS in DB
      const updated = apiInstance.app.context.sessionRepo.findById(session.id);
      assert.equal(updated.status, PaymentStatus.SUCCESS);
    });
  });

  describe('Gmail Poller startup and diagnostics', () => {
    const oauthCredentials = {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      refreshToken: 'test-refresh-token'
    };

    test('records a successful Gmail message-list poll', async () => {
      const poller = new GmailPoller();
      poller.setCredentials(oauthCredentials);

      await withMockedFetch(async url => {
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), { status: 200 });
        }
        if (String(url).startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
          return new Response(JSON.stringify({ messages: [] }), { status: 200 });
        }
        throw new Error('Unexpected test request');
      }, async () => {
        await poller.pollCycle();
      });

      assert.ok(poller.lastSuccessfulPollAt instanceof Date);
      assert.equal(poller.lastPollError, null);
    });

    test('uses observer authentication when resolving the active receiving account', async () => {
      const poller = new GmailPoller({ apiBaseUrl: 'http://payment-api.test' });

      await withMockedFetch(async (url, options = {}) => {
        assert.equal(String(url), 'http://payment-api.test/api/v1/pollers/active-window');
        assert.equal(options.headers.Authorization, `Bearer ${TEST_OBSERVER_TOKEN}`);
        return new Response(JSON.stringify({
          sessions: [{ receivingAccountId: 'active-account-id' }]
        }), { status: 200 });
      }, async () => {
        assert.equal(await poller.resolveActiveReceivingAccount(), 'active-account-id');
      });
    });

    test('ignores irrelevant messages without submitting observations', async () => {
      const poller = new GmailPoller();
      let submissions = 0;
      poller.observerClient.submitObservation = async () => {
        submissions++;
        return { accepted: true };
      };

      const result = await poller.processEmail({
        subject: 'Your monthly statement is ready',
        body: 'Your account statement is available to view.',
        from: 'notifications@bank.example'
      });

      assert.equal(result.ignored, true);
      assert.equal(result.reason, 'IRRELEVANT_EMAIL');
      assert.equal(submissions, 0);
      assert.equal(poller.observedCount, 0);
      assert.equal(poller.lastPollError, null);
    });

    test('reports malformed messages without submitting observations', async () => {
      const poller = new GmailPoller();
      let submissions = 0;
      poller.observerClient.submitObservation = async () => {
        submissions++;
        return { accepted: true };
      };

      const result = await poller.processEmail({ subject: { private: 'value' }, body: 'text' });

      assert.equal(result.ignored, true);
      assert.equal(result.reason, 'MALFORMED_MESSAGE');
      assert.equal(submissions, 0);
      assert.equal(poller.observedCount, 0);
      assert.equal(poller.lastPollError.code, 'GMAIL_MESSAGE_MALFORMED');
    });

    test('increments observedCount only for an accepted Payment API response', async () => {
      const poller = new GmailPoller();
      poller.resolveActiveReceivingAccount = async () => null;
      poller.observerClient.submitObservation = async payload => {
        assert.equal(payload.amountPaise, 20000n);
        assert.equal(payload.sender, 'alerts@bank.example');
        assert.equal(payload.rawText, 'Credit received Rs 200.00\nYour account received Rs 200.00 Ref: UTR-ACCEPT-1');
        return { accepted: true, observationId: 'observation-test' };
      };

      const result = await poller.processEmail({
        subject: 'Credit received Rs 200.00',
        body: 'Your account received Rs 200.00 Ref: UTR-ACCEPT-1',
        from: 'alerts@bank.example'
      });

      assert.equal(result.accepted, true);
      assert.equal(poller.observedCount, 1);
    });

    test('does not count or retry-count a 200 response with accepted false', async () => {
      const poller = new GmailPoller();
      poller.resolveActiveReceivingAccount = async () => null;
      poller.observerClient.submitObservation = async () => ({
        accepted: false,
        status: 'LATE_UNMATCHED',
        reason: 'LATE_OBSERVATION_NO_ACTIVE_SESSION'
      });

      const result = await poller.processEmail({
        subject: 'Credit received Rs 200.00',
        body: 'Your account received Rs 200.00 Ref: UTR-LATE-1',
        from: 'alerts@bank.example'
      });

      assert.equal(result.accepted, false);
      assert.equal(poller.observedCount, 0);
      assert.equal(poller.lastPollError.code, 'PAYMENT_API_REJECTED_LATE_OBSERVATION_NO_ACTIVE_SESSION');
    });

    test('reports a sanitized Payment API validation rejection', async () => {
      const poller = new GmailPoller();
      poller.resolveActiveReceivingAccount = async () => null;
      poller.observerClient.submitObservation = async () => {
        throw new Error(`Observer submit failed [HTTP 400]: ${JSON.stringify({
          reason: 'INVALID_EMAIL_DOMAIN',
          error: 'Sensitive message content must not be logged.'
        })}`);
      };

      await assert.rejects(poller.processEmail({
        subject: 'Credit received Rs 200.00',
        body: 'Your account received Rs 200.00 Ref: UTR-REJECT-1',
        from: 'alerts@bank.example'
      }), error => error.code === 'PAYMENT_API_REJECTED_INVALID_EMAIL_DOMAIN');

      assert.equal(poller.observedCount, 0);
      assert.equal(poller.lastPollError.code, 'PAYMENT_API_REJECTED_INVALID_EMAIL_DOMAIN');
      assert.ok(!JSON.stringify(poller.lastPollError).includes('Sensitive message content'));
    });

    test('reports Payment API network failures without exposing request contents', async () => {
      const poller = new GmailPoller();
      poller.resolveActiveReceivingAccount = async () => null;
      poller.observerClient.submitObservation = async () => {
        throw new TypeError('fetch failed while sending a private message');
      };

      await assert.rejects(poller.processEmail({
        subject: 'Credit received Rs 200.00',
        body: 'Your account received Rs 200.00 Ref: UTR-NETWORK-1',
        from: 'alerts@bank.example'
      }), error => error.code === 'PAYMENT_API_NETWORK_ERROR');

      assert.equal(poller.observedCount, 0);
      assert.equal(poller.lastPollError.code, 'PAYMENT_API_NETWORK_ERROR');
      assert.ok(!JSON.stringify(poller.lastPollError).includes('private message'));
    });

    test('reports missing saved OAuth credentials without requesting a Google token', async () => {
      const poller = new GmailPoller({ apiBaseUrl: 'http://payment-api.test' });
      let googleRequestMade = false;

      await withMockedFetch(async url => {
        if (String(url).startsWith('http://payment-api.test/')) {
          return new Response(JSON.stringify({ gmailConfig: {} }), { status: 200 });
        }
        googleRequestMade = true;
        throw new Error('Unexpected Google request');
      }, async () => {
        await poller.pollCycle();
      });

      assert.equal(googleRequestMade, false);
      assert.equal(poller.lastSuccessfulPollAt, null);
      assert.equal(poller.lastPollError.code, 'MISSING_OAUTH_CREDENTIALS');
    });

    test('reports invalid refresh credentials without exposing their values', async () => {
      const poller = new GmailPoller();
      poller.setCredentials(oauthCredentials);

      await withMockedFetch(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }), async () => {
        await poller.pollCycle();
      });

      assert.equal(poller.lastSuccessfulPollAt, null);
      assert.equal(poller.lastPollError.code, 'GMAIL_TOKEN_REFRESH_INVALID_GRANT');
      assert.ok(!JSON.stringify(poller.lastPollError).includes(oauthCredentials.refreshToken));
      assert.ok(!JSON.stringify(poller.lastPollError).includes(oauthCredentials.clientSecret));
    });

    test('reports Gmail message-list API failures and does not mark the poll successful', async () => {
      const poller = new GmailPoller();
      poller.setCredentials(oauthCredentials);

      await withMockedFetch(async url => {
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 });
      }, async () => {
        await poller.pollCycle();
      });

      assert.equal(poller.lastSuccessfulPollAt, null);
      assert.equal(poller.lastPollError.code, 'GMAIL_MESSAGE_LIST_PERMISSION_DENIED');
    });

    test('distinguishes Gmail message-fetch HTTP failures from API submission errors', async () => {
      const poller = new GmailPoller();
      poller.setCredentials(oauthCredentials);
      poller.cachedAccessToken = 'test-access-token';
      poller.tokenExpiresAt = Date.now() + 60000;

      await withMockedFetch(async url => {
        if (String(url).includes('/users/me/messages?')) {
          return new Response(JSON.stringify({ messages: [{ id: 'gmail-message-id' }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: { status: 'NOT_FOUND' } }), { status: 404 });
      }, async () => {
        await poller.pollCycle();
      });

      assert.ok(poller.lastSuccessfulPollAt instanceof Date);
      assert.equal(poller.lastPollError.code, 'GMAIL_MESSAGE_FETCH_NOT_FOUND');
      assert.equal(poller.observedCount, 0);
    });

    test('loads saved credentials and resumes one polling timer after observer restart', async () => {
      const apiBaseUrl = 'http://payment-api.test';
      let credentialsRequests = 0;
      let messageListRequests = 0;
      let observer;

      await withMockedFetch(async (url, options = {}) => {
        const requestUrl = String(url);
        if (requestUrl === `${apiBaseUrl}/api/v1/admin/gmail/credentials`) {
          credentialsRequests++;
          assert.equal(options.headers.Authorization, `Bearer ${TEST_OBSERVER_TOKEN}`);
          return new Response(JSON.stringify({ gmailConfig: oauthCredentials }), { status: 200 });
        }
        if (requestUrl.startsWith('https://oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), { status: 200 });
        }
        if (requestUrl.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
          messageListRequests++;
          return new Response(JSON.stringify({ messages: [] }), { status: 200 });
        }
        throw new Error('Unexpected test request');
      }, async () => {
        const probe = http.createServer();
        await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
        const port = probe.address().port;
        await new Promise((resolve, reject) => probe.close(err => err ? reject(err) : resolve()));

        try {
          observer = await startGmailObserver(port, { apiBaseUrl, pollIntervalMs: 60000 });
          const firstTimer = observer.poller.timer;
          observer.poller.start();

          const deadline = Date.now() + 2000;
          while (!observer.poller.lastSuccessfulPollAt && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }

          assert.equal(observer.poller.isRunning, true);
          assert.ok(observer.poller.lastSuccessfulPollAt instanceof Date);
          assert.equal(credentialsRequests, 1);
          assert.equal(messageListRequests, 1);
          assert.equal(observer.poller.timer, firstTimer);
        } finally {
          if (observer) await observer.close();
        }
      });
    });
  });
});
