"use strict";

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { delay } = require("./utils");
const { USER_AGENT, VIEWPORT } = require("./constants");

/**
 * Browser lifecycle & authentication.
 * Mixed into InstagramBot.prototype.
 */
module.exports = {
  async init() {
    if (this.isReady) return this;

    try {
      const launchOptions = {
        headless: this.headless,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-setuid-sandbox"
        ]
      };

      if (this.proxy && this.proxy.host) {
        launchOptions.proxy = {
          server: `${this.proxy.protocol || "http"}://${this.proxy.host}:${this.proxy.port}`,
          username: this.proxy.username,
          password: this.proxy.password
        };
      }

      // ── Persistent Context vs standard launch ─────────────────────────────
      if (this.sessionDir) {
        const absoluteSessionDir = path.resolve(this.sessionDir);
        if (!fs.existsSync(absoluteSessionDir)) {
          fs.mkdirSync(absoluteSessionDir, { recursive: true });
        }

        this.context = await chromium.launchPersistentContext(absoluteSessionDir, {
          ...launchOptions,
          viewport: VIEWPORT,
          userAgent: USER_AGENT
        });
      } else {
        this.browser = await chromium.launch(launchOptions);
        this.context = await this.browser.newContext({
          viewport: VIEWPORT,
          userAgent: USER_AGENT
        });
      }

      // ── Apply Stealth Scripts ──────────────────────────────────────────────
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        window.chrome = { runtime: {} };
      });

      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(this.timeout);

      this.emit("browserLaunched");

      // ── Inject cookies if provided and not in persistent context with session
      if (this.cookies && Object.keys(this.cookies).length > 0) {
        const formattedCookies = Object.entries(this.cookies).map(([name, value]) => ({
          name,
          value,
          domain: ".instagram.com",
          path: "/"
        }));
        await this.context.addCookies(formattedCookies);
      }

      // ── Open Instagram ─────────────────────────────────────────────────────
      await this.page.goto("https://www.instagram.com/", {
        waitUntil: "domcontentloaded"
      });
      await delay(3000);

      // ── Verify & Login Flow ────────────────────────────────────────────────
      let loggedIn = await this._checkLoginState();

      if (!loggedIn && this.username && this.password) {
        console.log("🌐 Attempting manual credential login flow...");
        loggedIn = await this._performLogin(this.username, this.password);
      }

      if (!loggedIn) {
        this.isReady = false;
        this.emit("loginRequired");
        return this;
      }

      this.isReady = true;
      this.emit("ready");
      return this;
    } catch (err) {
      this.emit("error", err);
      return this;
    }
  },

  async _checkLoginState() {
    const currentUrl = this.page.url();
    if (currentUrl.includes("/accounts/login")) {
      return false;
    }

    // Check DOM element representing a logged-in user (e.g. Nav elements or Feed)
    try {
      const isLoggedIn = await this.page.evaluate(() => {
        // Look for common logged-in elements (Home icon, Direct icon, profile photo)
        const homeIcon = document.querySelector('svg[aria-label="Home"], svg[aria-label="Ana Sayfa"]');
        const dmIcon = document.querySelector('svg[aria-label="Messenger"], svg[aria-label="Direct"]');
        const profileImg = document.querySelector('img[alt$="profil resmi"], img[alt$="profile picture"]');
        return !!(homeIcon || dmIcon || profileImg);
      });
      return isLoggedIn;
    } catch (e) {
      return false;
    }
  },

  async _performLogin(username, password) {
    try {
      // 1. Robust combined selectors for both legacy and new unified Meta login forms
      const userFieldSelector = 'input[name="username"], input[name="email"], input[type="text"]';
      const passFieldSelector = 'input[name="password"], input[name="pass"], input[type="password"]';

      await this.page.waitForSelector(userFieldSelector, { state: "visible", timeout: 15000 });

      // 2. Clear & Fill Username
      const userEl = await this.page.locator(userFieldSelector).first();
      await userEl.fill("");
      await userEl.type(username, { delay: 100 });
      await delay(500);

      // 3. Fill Password
      const passEl = await this.page.locator(passFieldSelector).first();
      await passEl.fill("");
      await passEl.type(password, { delay: 100 });
      await delay(500);

      // 4. Submit form (Press Enter on password input is much more robust than clicking unstable submit divs/buttons)
      await passEl.press("Enter");

      // 5. Wait for navigation / verification
      await delay(8000);

      // Check for security prompts (Save Info dialog, notifications popups etc.)
      const isSaveInfoVisible = await this.page.evaluate(() => {
        return document.body.innerText.includes("Save Your Login Info?") ||
               document.body.innerText.includes("Giriş Bilgilerini Kaydet?") ||
               document.body.innerText.includes("Save info") ||
               document.body.innerText.includes("Bilgileri Kaydet");
      });

      if (isSaveInfoVisible) {
        // Click "Not Now" or "Kaydet"
        const notNowBtn = await this.page.locator('button:has-text("Not Now"), button:has-text("Şimdi Değil"), div[role="button"]:has-text("Şimdi Değil"), div[role="button"]:has-text("Not Now")').first();
        if (await notNowBtn.isVisible()) {
          await notNowBtn.click();
          await delay(3000);
        }
      }

      // Check Notification prompt
      const isNotificationVisible = await this.page.evaluate(() => {
        return document.body.innerText.includes("Turn on Notifications") ||
               document.body.innerText.includes("Bildirimleri Aç");
      });

      if (isNotificationVisible) {
        const notNowNotification = await this.page.locator('button:has-text("Not Now"), button:has-text("Şimdi Değil"), div[role="button"]:has-text("Şimdi Değil"), div[role="button"]:has-text("Not Now")').first();
        if (await notNowNotification.isVisible()) {
          await notNowNotification.click();
          await delay(3000);
        }
      }

      return await this._checkLoginState();
    } catch (err) {
      console.error("❌ Login performance failed:", err.message);
      return false;
    }
  },

  async close() {
    if (this._msgTimer && this.stopMessageListener) {
      await this.stopMessageListener().catch(() => {});
    }
    if (this.browser) {
      await this.browser.close();
    } else if (this.context) {
      await this.context.close();
    }
    this.emit("closed");
  }
};
