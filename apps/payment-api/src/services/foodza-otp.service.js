import crypto from 'node:crypto';
import { isValidMobile, normalizeMobile, safeEqual } from '@youpi/common';

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_REQUESTS_PER_HOUR = 8;

export class FoodZaOtpService {
  constructor(whatsappService, options = {}) {
    this.whatsappService = whatsappService;
    this.now = options.now || Date.now;
    this.generateOtp = options.generateOtp || (() => crypto.randomInt(100000, 1000000).toString());
    this.challenges = new Map();
    this.requests = new Map();
  }

  async send(phone) {
    const mobile = normalizeMobile(phone);
    if (!mobile || !isValidMobile(mobile)) {
      return { success: false, status: 400, error: 'Please enter a valid 10-digit mobile number.' };
    }

    const now = this.now();
    for (const [challengePhone, challenge] of this.challenges) {
      if (now >= challenge.expiresAt) this.challenges.delete(challengePhone);
    }
    for (const [requestPhone, times] of this.requests) {
      const activeTimes = times.filter((time) => now - time < 60 * 60 * 1000);
      if (activeTimes.length) this.requests.set(requestPhone, activeTimes);
      else this.requests.delete(requestPhone);
    }
    const recent = (this.requests.get(mobile) || []).filter((time) => now - time < 60 * 60 * 1000);
    if (recent.length > 0 && now - recent[recent.length - 1] < OTP_RESEND_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - recent[recent.length - 1])) / 1000);
      this.requests.set(mobile, recent);
      return { success: false, status: 429, error: 'Please wait before requesting another verification code.', waitSeconds };
    }
    if (recent.length >= OTP_MAX_REQUESTS_PER_HOUR) {
      this.requests.set(mobile, recent);
      return { success: false, status: 429, error: 'Too many verification code requests. Please try again later.' };
    }

    recent.push(now);
    this.requests.set(mobile, recent);

    if (!this.whatsappService) {
      return { success: false, status: 503, error: 'WhatsApp delivery service is unavailable.' };
    }

    const otp = this.generateOtp();
    const message = `🔐 *FoodZa Verification Code*\n\nYour one-time login code is *${otp}*.\n\n⏱ _Valid for 5 minutes. Do not share this code with anyone._`;
    let delivery;
    try {
      delivery = await this.whatsappService.sendMessage(mobile, message);
    } catch (error) {
      console.error('[FoodZa OTP] WhatsApp dispatch failed:', error.message);
      return { success: false, status: 502, error: 'WhatsApp delivery failed. Please try again later.' };
    }

    if (delivery?.success !== true || delivery?.delivered !== true) {
      return { success: false, status: 502, error: 'WhatsApp delivery failed. Please try again later.' };
    }

    this.challenges.set(mobile, {
      otp,
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
      deliveryId: delivery.id || null
    });

    return {
      success: true,
      phone: mobile,
      expiresInSeconds: OTP_TTL_MS / 1000,
      dispatchId: delivery.id || null
    };
  }

  verify(phone, submittedOtp) {
    const mobile = normalizeMobile(phone);
    if (!mobile || !isValidMobile(mobile)) {
      return { success: false, status: 400, error: 'Please enter a valid 10-digit mobile number.' };
    }

    const challenge = this.challenges.get(mobile);
    if (!challenge) {
      return { success: false, status: 404, error: 'No active verification request. Please request a new code.' };
    }
    if (this.now() >= challenge.expiresAt) {
      this.challenges.delete(mobile);
      return { success: false, status: 410, error: 'Verification code has expired. Please request a new code.' };
    }
    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      this.challenges.delete(mobile);
      return { success: false, status: 429, error: 'Too many incorrect attempts. Please request a new code.' };
    }
    if (typeof submittedOtp !== 'string' || !/^\d{6}$/.test(submittedOtp) || !safeEqual(challenge.otp, submittedOtp)) {
      challenge.attempts += 1;
      if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
        this.challenges.delete(mobile);
        return { success: false, status: 429, error: 'Too many incorrect attempts. Please request a new code.' };
      }
      return { success: false, status: 400, error: 'Invalid verification code. Please check and try again.' };
    }

    this.challenges.delete(mobile);
    return { success: true, phone: mobile };
  }
}
