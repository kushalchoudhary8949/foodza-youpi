import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentApp } from '../index.js';
import { Database } from '@youpi/db';
import { FoodZaOtpService } from '../services/foodza-otp.service.js';

test('FoodZa OTP integration sends and verifies codes without creating YouPI sessions', async (t) => {
  const previousSecret = process.env.FOODZA_OTP_API_SECRET;
  process.env.FOODZA_OTP_API_SECRET = 'test-foodza-integration-secret';

  const customDb = new Database({ inMemory: true });
  let now = Date.now();
  let failDelivery = false;
  const sentCodes = [];
  const provider = {
    async sendMessage(_to, message) {
      if (failDelivery) return { success: false, delivered: false };
      const code = message.match(/code is \*(\d{6})\*/)?.[1];
      sentCodes.push(code);
      return { success: true, delivered: true, id: `test-${sentCodes.length}` };
    }
  };
  const otpService = new FoodZaOtpService(provider, {
    now: () => now,
    generateOtp: () => '123456'
  });
  const app = createPaymentApp(customDb, { foodZaOtpService: otpService });
  const server = app.rawServer.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    app.destroy();
    server.close();
    if (previousSecret === undefined) delete process.env.FOODZA_OTP_API_SECRET;
    else process.env.FOODZA_OTP_API_SECRET = previousSecret;
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/integrations/foodza/otp`;
  const post = (path, body, authorized = true) => fetch(`${baseUrl}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorized ? { Authorization: `Bearer ${process.env.FOODZA_OTP_API_SECRET}` } : {})
    },
    body: JSON.stringify(body)
  });

  await t.test('rejects unauthenticated service requests', async () => {
    const response = await post('send', { mobileNumber: '9123456789' }, false);
    assert.equal(response.status, 401);
    assert.equal(sentCodes.length, 0);
  });

  await t.test('sends, verifies once, and rejects an incorrect or replayed code', async () => {
    const sendResponse = await post('send', { mobileNumber: '9123456789' });
    assert.equal(sendResponse.status, 200);
    assert.equal((await sendResponse.json()).expiresInSeconds, 300);
    assert.equal(sentCodes.at(-1), '123456');
    const cooldownResponse = await post('send', { mobileNumber: '9123456789' });
    assert.equal(cooldownResponse.status, 429);

    const invalidResponse = await post('verify', { mobileNumber: '9123456789', otp: '000000' });
    assert.equal(invalidResponse.status, 400);

    const validResponse = await post('verify', { mobileNumber: '9123456789', otp: '123456' });
    assert.equal(validResponse.status, 200);
    assert.equal((await validResponse.json()).success, true);

    const replayResponse = await post('verify', { mobileNumber: '9123456789', otp: '123456' });
    assert.equal(replayResponse.status, 404);
    assert.equal(customDb.queryOne('SELECT COUNT(*) AS count FROM customers').count, 0);
    assert.equal(customDb.queryOne('SELECT COUNT(*) AS count FROM customer_sessions').count, 0);
  });

  await t.test('rejects expired OTPs', async () => {
    const sendResponse = await post('send', { mobileNumber: '9123456790' });
    assert.equal(sendResponse.status, 200);
    now += 5 * 60 * 1000 + 1;
    const verifyResponse = await post('verify', { mobileNumber: '9123456790', otp: '123456' });
    assert.equal(verifyResponse.status, 410);
  });

  await t.test('burns a challenge after the failed-attempt limit', async () => {
    const sendResponse = await post('send', { mobileNumber: '9123456792' });
    assert.equal(sendResponse.status, 200);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await post('verify', { mobileNumber: '9123456792', otp: '000000' });
      assert.equal(response.status, 400);
    }
    const finalAttempt = await post('verify', { mobileNumber: '9123456792', otp: '000000' });
    assert.equal(finalAttempt.status, 429);
    const correctAfterLockout = await post('verify', { mobileNumber: '9123456792', otp: '123456' });
    assert.equal(correctAfterLockout.status, 404);
  });

  await t.test('enforces the hourly request limit', async () => {
    for (let request = 0; request < 8; request += 1) {
      if (request > 0) now += 30 * 1000 + 1;
      const response = await post('send', { mobileNumber: '9123456793' });
      assert.equal(response.status, 200);
    }
    now += 30 * 1000 + 1;
    const response = await post('send', { mobileNumber: '9123456793' });
    assert.equal(response.status, 429);
  });

  await t.test('does not create a challenge when WhatsApp delivery fails', async () => {
    failDelivery = true;
    const sendResponse = await post('send', { mobileNumber: '9123456791' });
    assert.equal(sendResponse.status, 502);
    const verifyResponse = await post('verify', { mobileNumber: '9123456791', otp: '123456' });
    assert.equal(verifyResponse.status, 404);
  });
});
