"use strict";

const { delay } = require("./utils");

/**
 * Humanize, rate limiting, block detection and shared guards.
 * Mixed into InstagramBot.prototype.
 */
module.exports = {
  /** Random human-like delay in ms (skipped when humanize=false). */
  async _humanDelay(min = 800, max = 2500) {
    if (!this.humanize) return;
    const ms = Math.floor(min + Math.random() * (max - min));
    await delay(ms);
  },

  /**
   * Throw / emit if the given action exceeds the configured rate limits.
   * Call this at the top of any rate-limited action.
   */
  _checkRateLimit(action) {
    const limits = this.rateLimits[action];
    if (!limits) return;
    const now = Date.now();
    const log = this._actionLog[action] || (this._actionLog[action] = []);
    // Prune entries older than 24h
    const day = 24 * 60 * 60 * 1000;
    const hour = 60 * 60 * 1000;
    while (log.length && now - log[0] > day) log.shift();
    const lastHour = log.filter(t => now - t < hour).length;
    if (lastHour >= limits.hour || log.length >= limits.day) {
      const info = { action, hour: lastHour, day: log.length, limits };
      this.emit("rateLimitHit", info);
      const e = new Error(`Rate limit hit for "${action}" (hour=${lastHour}/${limits.hour}, day=${log.length}/${limits.day})`);
      e.code = "RATE_LIMIT";
      throw e;
    }
  },

  _recordAction(action) {
    (this._actionLog[action] || (this._actionLog[action] = [])).push(Date.now());
  },

  /**
   * Look at the current page DOM/URL and emit actionBlocked / challengeRequired
   * if Instagram is showing one of its block screens. Returns the kind detected.
   */
  async _detectBlock() {
    try {
      const url = this.page.url();
      if (url.includes("/challenge") || url.includes("/accounts/suspended") || url.includes("/accounts/disabled")) {
        const info = { url, timestamp: new Date().toISOString() };
        this.emit("challengeRequired", info);
        return "challenge";
      }
      const flagged = await this.page.evaluate(() => {
        const t = document.body ? document.body.innerText : "";
        const phrases = [
          "Action Blocked", "Try Again Later", "We restrict certain activity",
          "İşlem Engellendi", "Daha Sonra Tekrar Dene", "Bazı etkinlikleri kısıtlıyoruz",
          "Your account has been temporarily locked", "Hesabın geçici olarak kilitlendi"
        ];
        return phrases.find(p => t.includes(p)) || null;
      });
      if (flagged) {
        this.emit("actionBlocked", { reason: flagged, url, timestamp: new Date().toISOString() });
        return "blocked";
      }
      return null;
    } catch (e) {
      return null;
    }
  },

  /** Return current usage vs configured rate limits. */
  getRateLimitStatus() {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const day = 24 * 60 * 60 * 1000;
    const out = {};
    for (const [action, limits] of Object.entries(this.rateLimits)) {
      const log = this._actionLog[action] || [];
      out[action] = {
        hourUsed: log.filter(t => now - t < hour).length,
        hourLimit: limits.hour,
        dayUsed: log.filter(t => now - t < day).length,
        dayLimit: limits.day
      };
    }
    return out;
  },

  _ensureReady() {
    if (!this.isReady) {
      throw new Error("Bot is not ready. Wait for 'ready' event or call init() first.");
    }
  },

  /**
   * Helper to automatically detect and dismiss blocking modal dialogs
   * like "Turn on notifications" (Şimdi Değil / Not Now) and alert popups.
   */
  async _dismissDialogs() {
    try {
      const selectors = [
        'button:has-text("Şimdi Değil")',
        'button:has-text("Not Now")',
        'button:has-text("Not now")',
        'button:has-text("Maybe Later")',
        'button:has-text("Daha Sonra")',
        'div[role="button"]:has-text("Not now")',
        'div[role="button"]:has-text("Şimdi Değil")',
        'button._a9--._a9_1' // Instagram specific "Not Now" notification class
      ].join(', ');

      // Try up to 3 modals back-to-back (login save, notifications, cookies, etc.)
      for (let i = 0; i < 3; i++) {
        const popupBtn = this.page.locator(selectors).first();
        if (await popupBtn.count() > 0 && await popupBtn.isVisible().catch(() => false)) {
          await popupBtn.click({ force: true }).catch(() => {});
          await delay(1200);
        } else {
          break;
        }
      }
    } catch (e) {
      // Quietly ignore since it is a background maintenance check
    }
  }
};
