"use strict";

const { EventEmitter } = require("events");
const { DEFAULT_RATE_LIMITS } = require("./src/constants");

/**
 * InstaFlow — headless Instagram automation powered by Playwright.
 *
 * The implementation is split by concern into ./src modules that are mixed onto
 * the prototype below:
 *   - src/auth.js        init / login / close (browser lifecycle)
 *   - src/safety.js      humanize, rate limiting, block detection, guards
 *   - src/content.js     post / story / profile editing (publishing)
 *   - src/engagement.js  comment / like / save / bulk hashtag like
 *   - src/social.js      follow / unfollow / DM / story interactions
 *   - src/insights.js    profile / post / reel scraping, search, inbox, download
 *
 * @example
 * const InstaFlow = require('instaflow');
 * const bot = new InstaFlow({ sessionDir: './session', headless: true });
 * bot.on('ready', async () => {
 *   const me = await bot.getMyStats();
 *   await bot.close();
 * });
 * bot.init();
 */
class InstagramBot extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} [options.cookies]       – { sessionid, csrftoken, ds_user_id... }
   * @param {string} [options.username]      – Instagram username
   * @param {string} [options.password]      – Instagram password (for auto-login fallback)
   * @param {boolean} [options.headless=true]
   * @param {number}  [options.timeout=60000]
   * @param {string}  [options.sessionDir]   – Path to persistent chrome profile directory
   * @param {boolean} [options.humanize=true]
   * @param {object}  [options.proxy]
   * @param {object}  [options.rateLimits]   – Per-action { hour, day } overrides
   */
  constructor(options = {}) {
    super();

    this.cookies = options.cookies || null;
    this.username = options.username || "";
    this.password = options.password || "";
    this.headless = options.headless !== undefined ? options.headless : true;
    this.timeout = options.timeout || 60000;
    this.sessionDir = options.sessionDir || null;
    this.humanize = options.humanize !== undefined ? options.humanize : true;
    this.proxy = options.proxy || null;

    this.browser = null;
    this.context = null;
    this.page = null;
    this.isReady = false;

    // ── Rate limiter state ──────────────────────────────────────────────────
    // Tracks timestamps of recent actions per type for hourly/daily caps.
    this._actionLog = {
      post: [], story: [], like: [], comment: [],
      follow: [], unfollow: [], dm: []
    };

    // Clone the defaults (per-instance) so per-action overrides never mutate the
    // shared constant, then let options.rateLimits replace whole action entries.
    const defaults = {};
    for (const [action, caps] of Object.entries(DEFAULT_RATE_LIMITS)) {
      defaults[action] = { ...caps };
    }
    this.rateLimits = Object.assign(defaults, options.rateLimits || {});
  }
}

// ── Compose the prototype from the concern-specific mixins ──────────────────
Object.assign(
  InstagramBot.prototype,
  require("./src/auth"),
  require("./src/safety"),
  require("./src/content"),
  require("./src/engagement"),
  require("./src/social"),
  require("./src/insights")
);

module.exports = InstagramBot;
