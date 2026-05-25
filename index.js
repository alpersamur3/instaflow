const { chromium } = require("playwright");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REQUIRED_COOKIES = ["sessionid"];

class InstagramBot extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} [options.cookies]       – { sessionid, csrftoken, ds_user_id... }
   * @param {string} [options.username]      – Instagram username
   * @param {string} [options.password]      – Instagram password (for auto-login fallback)
   * @param {boolean} [options.headless=true]
   * @param {number}  [options.timeout=60000]
   * @param {string}  [options.sessionDir]   – Path to persistent chrome profile directory
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
    this.rateLimits = Object.assign({
      post:     { hour: 3,  day: 10  },
      story:    { hour: 5,  day: 15  },
      like:     { hour: 30, day: 150 },
      comment:  { hour: 15, day: 60  },
      follow:   { hour: 10, day: 40  },
      unfollow: { hour: 10, day: 40  },
      dm:       { hour: 10, day: 40  }
    }, options.rateLimits || {});
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HUMANIZE & RATE LIMITING
  // ═══════════════════════════════════════════════════════════════════════════

  /** Random human-like delay in ms (skipped when humanize=false). */
  async _humanDelay(min = 800, max = 2500) {
    if (!this.humanize) return;
    const ms = Math.floor(min + Math.random() * (max - min));
    await delay(ms);
  }

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
  }

  _recordAction(action) {
    (this._actionLog[action] || (this._actionLog[action] = [])).push(Date.now());
  }

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
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INIT & AUTHENTICATION
  // ═══════════════════════════════════════════════════════════════════════════

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
          viewport: { width: 1280, height: 720 },
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        });
      } else {
        this.browser = await chromium.launch(launchOptions);
        this.context = await this.browser.newContext({
          viewport: { width: 1280, height: 720 },
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
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
  }

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
  }

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
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CORE ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a single photo / carousel / video
   * @param {string} caption 
   * @param {object} options 
   * @param {string[]} options.media - Local paths to image/video files
   */
  async post(caption, options = {}) {
    this._ensureReady();
    this._checkRateLimit("post");
    if (!options.media || options.media.length === 0) {
      throw new Error("Media is required for posting");
    }

    try {
      const mediaPaths = options.media.map(p => path.resolve(p));
      for (const p of mediaPaths) {
        if (!fs.existsSync(p)) {
          throw new Error(`Media file not found: ${p}`);
        }
      }

      // 0. Navigate to homepage first to ensure clean, stable sidebar layout
      await this.page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
      await delay(4000);
      await this._dismissDialogs();

      // 1. Click "New Post" link in the sidebar.
      // The clickable element is the parent <a>, not the inner svg. Match by aria-label
      // on the nested SVG (EN + TR), with text fallbacks. Use page.evaluate as a final
      // fallback because the sidebar link can sit just outside Playwright's strict
      // viewport check on narrow windows.
      // Case-insensitive partial matches — IG localizes labels and changes casing.
      const newPostSelectors = [
        'a:has(svg[aria-label*="New post" i])',
        'a:has(svg[aria-label*="Yeni Gönderi" i])',
        'a:has(svg[aria-label*="Create" i])',
        'a:has(svg[aria-label*="Oluştur" i])',
        'div[role="menuitem"]:has-text("Post")',
        'div[role="menuitem"]:has-text("Gönderi")'
      ];
      let opened = false;
      for (const sel of newPostSelectors) {
        const loc = this.page.locator(sel).first();
        if (await loc.count() > 0) {
          try {
            await loc.click({ force: true, timeout: 4000 });
            opened = true;
            break;
          } catch (_) { /* try next */ }
        }
      }
      if (!opened) {
        // JS-level click fallback (works even if element is technically out of viewport)
        const ok = await this.page.evaluate(() => {
          const svgs = Array.from(document.querySelectorAll('svg[aria-label]'));
          const target = svgs.find(s => /new post|yeni gönderi|create|oluştur/i.test(s.getAttribute('aria-label')));
          if (!target) return false;
          const anchor = target.closest('a') || target.closest('[role="link"]') || target.parentElement;
          if (anchor) { anchor.click(); return true; }
          return false;
        });
        if (!ok) throw new Error("Could not find sidebar 'New post' / 'Yeni gönderi' link");
      }
      await delay(2500);

      // 1b. Some accounts get a popover first ("Post", "Story", "Reel"). Click Post.
      const postSubmenu = this.page.locator(
        'div[role="menuitem"]:has-text("Post"), ' +
        'div[role="menuitem"]:has-text("Gönderi"), ' +
        'svg[aria-label="Post"], svg[aria-label="Gönderi"]'
      ).first();
      if (await postSubmenu.count() > 0 && await postSubmenu.isVisible().catch(() => false)) {
        await postSubmenu.click({ force: true }).catch(() => {});
        await delay(2000);
      }

      // 1c. Wait for the create dialog to mount before reaching for the file input.
      // The input itself is hidden by CSS, so wait for it to be ATTACHED (not visible).
      await this.page.waitForSelector('div[role="dialog"] input[type="file"]', { state: "attached", timeout: 15000 });

      // 2. Select file (Instagram exposes a hidden input[type="file"] inside the dialog).
      const fileInput = this.page.locator('div[role="dialog"] input[type="file"]').first();
      await fileInput.setInputFiles(mediaPaths[0]);
      await delay(4500);

      // Carousel: If multiple images are provided
      if (mediaPaths.length > 1) {
        const expandBtn = this.page.locator(
          'svg[aria-label*="Select multiple" i], svg[aria-label*="Birden fazla" i]'
        ).first();
        if (await expandBtn.count() > 0 && await expandBtn.isVisible().catch(() => false)) {
          await expandBtn.click({ force: true });
          await delay(1500);
          const multiInput = this.page.locator('div[role="dialog"] input[type="file"]').first();
          await multiInput.setInputFiles(mediaPaths.slice(1));
          await delay(2500);
        }
      }

      // Helper: find a primary-action button inside the dialog by exact text (EN + TR).
      const findDialogBtn = async (regexes, retries = 3) => {
        for (let i = 0; i < retries; i++) {
          for (const re of regexes) {
            const loc = this.page.locator('div[role="dialog"] button')
              .filter({ hasText: re })
              .filter({ hasNot: this.page.locator('img, canvas, video, svg[aria-label="Loading..."]') });
            const count = await loc.count();
            for (let j = 0; j < count; j++) {
              const cand = loc.nth(j);
              if (await cand.isVisible().catch(() => false) &&
                  await cand.isEnabled().catch(() => false)) {
                return cand;
              }
            }
            // Fall back to div[role="button"] for accounts where IG uses divs
            const divLoc = this.page.locator('div[role="dialog"] div[role="button"]')
              .filter({ hasText: re })
              .filter({ hasNot: this.page.locator('img, canvas, video') });
            if (await divLoc.count() > 0 && await divLoc.first().isVisible().catch(() => false)) {
              return divLoc.first();
            }
          }
          await delay(1500);
        }
        return null;
      };

      // 3. Click "Next" on the Crop screen
      const nextBtn = await findDialogBtn([/^Next$/i, /^İleri$/i]);
      if (!nextBtn) throw new Error("Could not find 'Next' / 'İleri' button on Crop screen");
      await nextBtn.click({ force: true });
      await delay(3000);

      // 4. Click "Next" again on the Edit / Filters screen
      const filterNextBtn = await findDialogBtn([/^Next$/i, /^İleri$/i]);
      if (!filterNextBtn) throw new Error("Could not find second 'Next' / 'İleri' button on Edit screen");
      await filterNextBtn.click({ force: true });
      await delay(3500);

      // 5. Fill caption — aria-label on the textbox is "Write a caption..." / "Açıklama yaz..."
      const captionArea =
        'div[role="dialog"] div[role="textbox"][aria-label="Write a caption..."], ' +
        'div[role="dialog"] div[role="textbox"][aria-label="Açıklama yaz..."], ' +
        'div[role="dialog"] div[role="textbox"][contenteditable="true"]';
      await this.page.waitForSelector(captionArea, { state: "visible", timeout: 15000 });
      const captionInput = this.page.locator(captionArea).first();
      await captionInput.click();
      await captionInput.type(caption, { delay: 50 });
      await delay(1500);

      // 6. Click "Share" / "Paylaş"
      const shareBtn = await findDialogBtn([/^Share$/i, /^Paylaş$/i]);
      if (!shareBtn) throw new Error("Could not find 'Share' / 'Paylaş' button in the post creation dialog");
      await shareBtn.click({ force: true });

      // Wait for completion dialog or upload process (usually takes 5-10 seconds)
      try {
        const successDialogSelector =
          'span:has-text("Your post has been shared"), ' +
          'span:has-text("Gönderin paylaşıldı"), ' +
          'h2:has-text("shared"), h2:has-text("paylaşıldı"), ' +
          'div[role="dialog"] img[alt*="animation" i], ' + // success animation
          'div[role="dialog"]:has-text("Post shared"), ' +
          'div[role="dialog"]:has-text("Gönderi paylaşıldı")';
        await this.page.waitForSelector(successDialogSelector, { timeout: 35000 });
      } catch (e) {
        console.warn("⚠️ Success text not matched immediately, waiting for safe publish window...");
        await delay(12000);
      }
      await delay(2000);

      // Close create dialog if still open
      const closeBtn = await this.page.locator('svg[aria-label*="Close" i], svg[aria-label*="Kapat" i]').first();
      if (await closeBtn.isVisible()) {
        await closeBtn.locator('xpath=..').click({ force: true });
      }

      const result = {
        success: true,
        caption,
        timestamp: new Date().toISOString()
      };

      this._recordAction("post");
      this.emit("postPublished", result);
      return result;
    } catch (err) {
      this.emit("postFailed", { caption, error: err.message });
      throw err;
    }
  }

  /**
   * Post a Story
   * Note: Story uploading on Instagram Web has certain view size / responsiveness constraints. 
   * Works beautifully in mobile view or standard Chrome emulation.
   * @param {string} mediaPath - Path to local image
   */
  async postStory(mediaPath) {
    this._ensureReady();
    this._checkRateLimit("story");
    const resolvedPath = path.resolve(mediaPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Media file not found: ${resolvedPath}`);
    }

    try {
      await this.page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
      await delay(3000);
      await this._dismissDialogs();

      // Try finding the create story button (mobile layout or top banner)
      const storyBtn = await this.page.locator('svg[aria-label="Add to your story"], svg[aria-label="Hikayene ekle"]').first();
      if (!(await storyBtn.isVisible())) {
        throw new Error("Story upload button not found in desktop view. Story upload requires Mobile View Emulation.");
      }
      await storyBtn.click();
      await delay(1000);

      const fileInput = await this.page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(resolvedPath);
      await delay(3000);

      const addToStoryBtn = this.page.locator('button:has-text("Add to story"), button:has-text("Hikayeye ekle")');
      await addToStoryBtn.first().click();
      
      await delay(5000); // Wait for upload

      const result = {
        success: true,
        timestamp: new Date().toISOString()
      };
      this._recordAction("story");
      this.emit("storyPublished", result);
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Leave a comment on a specific post
   * @param {string} postUrl - Full URL of the post or post shortcode
   * @param {string} text - Comment text
   */
  async comment(postUrl, text) {
    this._ensureReady();
    this._checkRateLimit("comment");
    const url = postUrl.startsWith("http") ? postUrl : `https://www.instagram.com/p/${postUrl}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(3000);

      // Focus on the comment textarea - Multi-selector list matching placeholders, aria-labels and roles
      const commentAreaSelector = [
        'textarea[aria-label="Add a comment..."]',
        'textarea[aria-label="Yorum ekle..."]',
        'textarea[placeholder="Add a comment..."]',
        'textarea[placeholder="Yorum ekle..."]',
        'textarea'
      ].join(', ');
      
      await this.page.waitForSelector(commentAreaSelector, { state: "visible", timeout: 15000 });
      
      const commentArea = await this.page.locator(commentAreaSelector).first();
      await commentArea.click();
      await delay(500);

      // Write natural characters
      await commentArea.type(text, { delay: 60 });
      await delay(800);

      // Click "Post" (Paylaş)
      // The comment posting button is STRICTLY inside the comment <form> element. 
      // This prevents clicking paper airplane / share buttons ("Paylaş") located higher in the DOM tree.
      const postBtnSelectors = [
        'form div[role="button"]:has-text("Post")',
        'form div[role="button"]:has-text("Paylaş")',
        'form button[type="submit"]',
        'form button:has-text("Post")',
        'form button:has-text("Paylaş")'
      ].join(', ');
      
      const postBtn = await this.page.locator(postBtnSelectors).first();
      if (await postBtn.isVisible()) {
        await postBtn.click();
      } else {
        // Ultimate fallback: type message and press Enter
        await commentArea.press("Enter");
      }

      await delay(3000); // Wait for the comment to post successfully

      const result = { success: true, postUrl: url, text, timestamp: new Date().toISOString() };
      this._recordAction("comment");
      this.emit("commentPosted", result);
      return result;
    } catch (err) {
      this.emit("commentFailed", { postUrl: url, text, error: err.message });
      throw err;
    }
  }

  /**
   * Like a specific post
   * @param {string} postUrl 
   */
  async likePost(postUrl) {
    this._ensureReady();
    this._checkRateLimit("like");
    const url = postUrl.startsWith("http") ? postUrl : `https://www.instagram.com/p/${postUrl}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(3500);
      await this._detectBlock();

      // Selectors for Like / Unlike heart icon
      // The main post heart is width=24; small comment-row hearts are width=12 — filter those out.
      // Use EXACT aria-label match (= not *=) because "Beğen" is a substring of "Beğeniyi Kaldır".
      const likeSvgSelector = 'svg[aria-label="Like" i][width="24"], svg[aria-label="Beğen" i][width="24"]';
      const unlikeSvgSelector = 'svg[aria-label="Unlike" i][width="24"], svg[aria-label="Beğenmekten Vazgeç" i][width="24"], svg[aria-label="Beğeniyi Kaldır" i][width="24"]';

      // Check if already liked by looking for unlike button
      const unlikeSvg = await this.page.locator(unlikeSvgSelector).first();
      if (await unlikeSvg.isVisible()) {
        return { success: true, status: "already_liked", postUrl: url };
      }

      // Find like SVG or heart button directly
      const likeSvg = await this.page.locator(likeSvgSelector).first();
      if (await likeSvg.isVisible()) {
        // Parent node (button/div wrapper) of SVG
        const likeBtn = await likeSvg.locator("xpath=..");
        await likeBtn.click();
        await delay(1500);
        const result = { success: true, status: "liked", postUrl: url, timestamp: new Date().toISOString() };
        this._recordAction("like");
        this.emit("postLiked", result);
        return result;
      }

      // Fallback: search for double-click target inside main article or post media containers
      const mediaSelectors = [
        'article div[role="button"]',
        'article div._aagw',
        'article video',
        'article img',
        'main article',
        'div[style*="padding-bottom"]'
      ];

      for (const selector of mediaSelectors) {
        const el = await this.page.locator(selector).first();
        if (await el.isVisible()) {
          await el.dblclick();
          await delay(1500);
          const result = { success: true, status: "liked", postUrl: url, timestamp: new Date().toISOString() };
          this.emit("postLiked", result);
          return result;
        }
      }

      throw new Error("Could not find Like button SVG or double-click target on page DOM");
    } catch (err) {
      throw err;
    }
  }

  /**
   * Remove like from a specific post
   * @param {string} postUrl 
   */
  async unlikePost(postUrl) {
    this._ensureReady();
    const url = postUrl.startsWith("http") ? postUrl : `https://www.instagram.com/p/${postUrl}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(3500);

      const unlikeSvgSelector = 'svg[aria-label="Unlike" i][width="24"], svg[aria-label="Beğenmekten Vazgeç" i][width="24"], svg[aria-label="Beğeniyi Kaldır" i][width="24"]';
      const likeSvgSelector = 'svg[aria-label="Like" i][width="24"], svg[aria-label="Beğen" i][width="24"]';

      const likeSvg = await this.page.locator(likeSvgSelector).first();
      if (await likeSvg.isVisible()) {
        return { success: true, status: "not_liked", postUrl: url };
      }

      const unlikeSvg = await this.page.locator(unlikeSvgSelector).first();
      if (await unlikeSvg.isVisible()) {
        const unlikeBtn = await unlikeSvg.locator("xpath=..");
        await unlikeBtn.click();
        await delay(1500);
        return { success: true, status: "unliked", postUrl: url, timestamp: new Date().toISOString() };
      }

      throw new Error("Unlike button SVG not visible/found on this page");
    } catch (err) {
      throw err;
    }
  }

  /**
   * Follow a specific user
   * @param {string} username - User handle with or without @
   */
  async followUser(username) {
    this._ensureReady();
    this._checkRateLimit("follow");
    const normalizedUser = username.replace(/^@/, "");
    const url = `https://www.instagram.com/${normalizedUser}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(3500);

      // Check if profile exists / is active
      const exists = await this.page.evaluate(() => {
        return !document.body.innerText.includes("Sorry, this page isn't available") &&
               !document.body.innerText.includes("Üzgünüz, bu sayfaya ulaşılamıyor");
      });

      if (!exists) {
        throw new Error(`Instagram user @${normalizedUser} not found or account is deactivated`);
      }

      // Check follow state
      // Find all clickable buttons/anchors inside profile header and filter dynamically (perfectly safe against UI languages, updates, and custom button tags)
      const buttons = await this.page.locator('header button, header [role="button"], header a').all();
      let followBtn = null;
      let followingBtn = null;
      let requestedBtn = null;

      for (const btn of buttons) {
        const text = (await btn.innerText()).trim().toLowerCase();
        
        // Exact and fuzzy match for Following state
        if (text === "following" || text === "takip ediliyor" || text === "takiptesin" || text.includes("takiptesin") || text.includes("following")) {
          followingBtn = btn;
        } 
        // Exact and fuzzy match for Requested state
        else if (text === "requested" || text === "istek gönderildi" || text === "i̇stek gönderildi" || text.includes("istek") || text.includes("requested")) {
          requestedBtn = btn;
        } 
        // Exact and fuzzy match for Follow action button
        else if (text === "follow" || text === "takip et" || text === "follow back" || text === "geri takip et" || text.includes("takip") || text.includes("follow")) {
          followBtn = btn;
        }
      }

      // 1. Is already following or requested?
      if (followingBtn) {
        return { username: normalizedUser, status: "already_following", timestamp: new Date().toISOString() };
      }
      if (requestedBtn) {
        return { username: normalizedUser, status: "requested", timestamp: new Date().toISOString() };
      }

      // 2. Perform follow click
      if (followBtn) {
        await followBtn.click();
        await delay(2500);
        
        // Re-check buttons
        const updatedButtons = await this.page.locator('header button, header [role="button"], header a').all();
        let confirmedState = "followed";
        for (const btn of updatedButtons) {
          const text = (await btn.innerText()).trim().toLowerCase();
          if (text === "following" || text === "takip ediliyor" || text === "takiptesin" || text.includes("takiptesin")) {
            confirmedState = "followed";
          } else if (text === "requested" || text === "istek gönderildi" || text === "i̇stek gönderildi" || text.includes("istek")) {
            confirmedState = "requested";
          }
        }
        
        const result = { username: normalizedUser, status: confirmedState, timestamp: new Date().toISOString() };
        this._recordAction("follow");
        this.emit("userFollowed", result);
        return result;
      }

      throw new Error(`Could not find follow/interaction button in header. Profile structure might be different or restricted.`);
    } catch (err) {
      this.emit("followFailed", { username: normalizedUser, error: err.message });
      throw err;
    }
  }

  /**
   * Unfollow a specific user
   * @param {string} username 
   */
  async unfollowUser(username) {
    this._ensureReady();
    this._checkRateLimit("unfollow");
    const normalizedUser = username.replace(/^@/, "");
    const url = `https://www.instagram.com/${normalizedUser}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(3000);

      // Check current state
      const buttons = await this.page.locator('header button, header [role="button"], header a').all();
      let followingBtn = null;
      for (const btn of buttons) {
        const text = (await btn.innerText()).trim().toLowerCase();
        if (
          text === "following" || 
          text === "takip ediliyor" || 
          text === "takiptesin" ||
          text.includes("takiptesin") ||
          text === "requested" || 
          text === "istek gönderildi" || 
          text === "i̇stek gönderildi" ||
          text.includes("istek")
        ) {
          followingBtn = btn;
          break;
        }
      }

      if (!followingBtn) {
        return { username: normalizedUser, status: "not_following" };
      }

      // Click "Following" to open the prompt dialog
      await followingBtn.click();
      await delay(2000);

      // Click "Unfollow" in popup menu
      const unfollowConfirmBtn = await this.page.locator('button:has-text("Unfollow"), button:has-text("Takibi Bırak")').first();
      if (!await unfollowConfirmBtn.isVisible()) {
        throw new Error("Unfollow confirmation modal / button not found in page DOM");
      }

      await unfollowConfirmBtn.click();
      await delay(2500);

      const result = { username: normalizedUser, status: "unfollowed", timestamp: new Date().toISOString() };
      this._recordAction("unfollow");
      this.emit("userUnfollowed", result);
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Update authenticated profile metadata
   * @param {object} options 
   * @param {string} [options.bio] 
   * @param {string} [options.website] 
   * @param {string} [options.avatar] - Local path to new profile picture
   */
  async setupProfile(options = {}) {
    this._ensureReady();
    
    try {
      await this.page.goto("https://www.instagram.com/accounts/edit/", { waitUntil: "domcontentloaded" });
      await delay(4000);
      await this._dismissDialogs();

      const report = { bio: false, website: false, avatar: false, saved: false };

      // Update Bio / Website
      if (options.bio !== undefined) {
        const bioSelector = 'textarea, textarea[id="pepBiography"]'; // PEP selectors
        await this.page.waitForSelector(bioSelector, { state: "visible" });
        const bioArea = await this.page.locator(bioSelector).first();
        await bioArea.fill("");
        await bioArea.type(options.bio, { delay: 30 });
        report.bio = true;
      }

      if (options.website !== undefined) {
        const webSelector = 'input[type="text"][id="pepWebsite"], input[placeholder="Website"]';
        const webArea = await this.page.locator(webSelector).first();
        if (await webArea.isVisible()) {
          await webArea.fill("");
          await webArea.type(options.website, { delay: 30 });
          report.website = true;
        }
      }

      // Avatar/Profile Picture update
      if (options.avatar) {
        const resolvedPath = path.resolve(options.avatar);
        if (!fs.existsSync(resolvedPath)) {
          throw new Error(`Profile photo not found: ${resolvedPath}`);
        }

        // Click "Change Profile Photo" / "Profil Fotoğrafını Değiştir"
        const changePhotoSelectors = [
          'button:has-text("Change profile photo")', 'button:has-text("Profil Fotoğrafını Değiştir")',
          'button:has-text("Change photo")', 'button:has-text("Fotoğrafı Değiştir")'
        ];

        let changeBtn = null;
        for (const selector of changePhotoSelectors) {
          const btn = await this.page.locator(selector).first();
          if (await btn.isVisible()) {
            changeBtn = btn;
            break;
          }
        }

        if (changeBtn) {
          // Instagram triggers file selector. Playwright intercepts input[type="file"]
          const fileInputPromise = this.page.waitForEvent("filechooser");
          await changeBtn.click();
          const fileChooser = await fileInputPromise;
          await fileChooser.setFiles(resolvedPath);
          await delay(5000); // Wait for upload and auto save
          report.avatar = true;
        }
      }

      // Submit changes
      // In modern Instagram Web, the Submit button is a div[role="button"] wrapping a span with text "Gönder" or "Submit"
      const submitSelectors = [
        'div[role="button"]:has-text("Submit")',
        'div[role="button"]:has-text("Gönder")',
        'div[role="button"]:has-text("Save")',
        'div[role="button"]:has-text("Kaydet")',
        'button[type="submit"]',
        'button:has-text("Submit")',
        'button:has-text("Gönder")'
      ].join(', ');

      const submitBtn = await this.page.locator(submitSelectors).first();
      
      // Before clicking, let's make sure the form values are set by triggering a keyup/input event if needed,
      // and wait for the save button to be enabled (removing aria-disabled="true" if present)
      if (await submitBtn.isVisible() && (report.bio || report.website)) {
        await submitBtn.click();
        await delay(3500);
        report.saved = true;
      } else {
        report.saved = report.avatar; // Avatar changes save automatically
      }

      const finalResult = { ...report, timestamp: new Date().toISOString() };
      this.emit("profileSetup", finalResult);
      return finalResult;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Search posts containing a specific hashtag and like them
   * @param {string} hashtag 
   * @param {number} count 
   */
  async searchAndLike(hashtag, count = 5) {
    this._ensureReady();
    const tag = hashtag.replace(/^#/, "");
    const url = `https://www.instagram.com/explore/tags/${tag}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(4000);

      // Collect post shortcodes/hrefs
      const postHrefs = await this.page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href^="/p/"]'));
        return anchors.map(a => a.getAttribute("href")).filter((v, i, self) => self.indexOf(v) === i);
      });

      if (postHrefs.length === 0) {
        throw new Error(`No posts found for hashtag #${tag}`);
      }

      const targetList = postHrefs.slice(0, count);
      let likedCount = 0;

      for (const href of targetList) {
        try {
          const result = await this.likePost(href);
          if (result.status === "liked") {
            likedCount++;
          }
          await delay(3000 + Math.random() * 5000); // Random delay to prevent rate limits
        } catch (e) {
          console.warn(`⚠️ Failed to like post ${href}: ${e.message}`);
        }
      }

      return { hashtag: tag, liked: likedCount, requested: count };
    } catch (err) {
      throw err;
    }
  }

  async getPostComments(postUrl, count = 10) {
    this._ensureReady();
    const url = postUrl.startsWith("http") ? postUrl : `https://www.instagram.com/p/${postUrl}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(4000);

      let commentsMap = new Map(); // username + text to dedup
      let noNewDataCount = 0;

      while (commentsMap.size < count && noNewDataCount < 5) {
        const visibleComments = await this.page.evaluate(() => {
          const list = [];
          
          // Find scrollable comments wrapper
          const scrollable = document.querySelector('div.x5yr21d.xw2csxc.x1odjw0f.x1n2onr6');
          const rootElement = scrollable ? scrollable.firstElementChild : document;
          if (!rootElement) return [];

          // Query commenter profile name spans (TR: span._ap3a, EN: span._ap3a)
          const usernameSpans = Array.from(rootElement.querySelectorAll('span._ap3a'));

          usernameSpans.forEach(span => {
            let row = span.parentElement;
            while (row && row !== rootElement) {
              // Target commenter comment text element (real comments reside in wrappers containing class matching x1cy8zhl)
              // Caption / main description does NOT contain this class and is automatically ignored!
              const textEl = row.querySelector('div[class*="x1cy8zhl"]');
              if (textEl) {
                const username = span.textContent.trim();
                const text = textEl.textContent.trim();

                const timeEl = row.querySelector('time');
                const timestamp = timeEl ? timeEl.textContent.trim() : null;

                if (username && text && username !== "" && text !== "") {
                  list.push({ username, text, timestamp });
                }
                break;
              }
              row = row.parentElement;
            }
          });

          return list;
        });

        let added = 0;
        for (const c of visibleComments) {
          const key = `${c.username}_${c.text}`;
          if (!commentsMap.has(key)) {
            commentsMap.set(key, c);
            added++;
          }
        }

        if (added === 0) {
          noNewDataCount++;
        } else {
          noNewDataCount = 0;
        }

        if (commentsMap.size >= count) break;

        // Try scrolling comment list container
        await this.page.evaluate(() => {
          // Scroll the main content box / dialog container
          const commentContainers = Array.from(document.querySelectorAll('div[style*="overflow: scroll"], div[style*="overflow-y: scroll"], div[style*="overflow: auto"], div.x1y1aw1k'));
          const mainContainer = commentContainers.find(c => c.clientHeight > 200) || window;
          mainContainer.scrollBy(0, 500);
        });

        await delay(2000);
      }

      const results = Array.from(commentsMap.values()).slice(0, count);
      return {
        postUrl: url,
        collected: results.length,
        comments: results
      };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Send a direct message to a user
   * @param {string} username - Target handle (e.g. "instagram")
   * @param {string} text - Message text
   */
  async sendDM(username, text) {
    this._ensureReady();
    this._checkRateLimit("dm");
    const normalizedUser = username.replace(/^@/, "");
    
    try {
      // 1. Go to messages list directly
      await this.page.goto("https://www.instagram.com/direct/inbox/", { waitUntil: "domcontentloaded" });
      await delay(4000);

      // Check and close active alert popups (like "Turn on notifications" etc.)
      const notNowBtn = await this.page.locator('button:has-text("Not Now"), button:has-text("Şimdi Değil")').first();
      if (await notNowBtn.isVisible()) {
        await notNowBtn.click();
        await delay(1500);
      }

      // 2. Click "New Message" button
      // SVG with aria-label="New Message" or "Yeni Mesaj"
      const newMsgBtn = await this.page.locator('svg[aria-label="New message"], svg[aria-label="Yeni Mesaj"], svg[aria-label*="message" i]').first();
      if (await newMsgBtn.isVisible()) {
        await newMsgBtn.locator("xpath=..").click();
      } else {
        // Fallback: click "Send Message" if profile page approach is easier
        await this.page.goto(`https://www.instagram.com/${normalizedUser}/`, { waitUntil: "domcontentloaded" });
        await delay(3500);
        const sendMsgBtn = await this.page.locator('div[role="button"]:has-text("Message"), button:has-text("Message"), button:has-text("Mesaj Gönder"), div[role="button"]:has-text("Mesaj Gönder")').first();
        if (await sendMsgBtn.isVisible()) {
          await sendMsgBtn.click();
          await delay(4000);
        } else {
          throw new Error("Could not find new message trigger");
        }
      }

      // If we clicked "New Message" popup, type username and select
      const searchInput = await this.page.locator('input[name="query"], input[placeholder*="Search" i], input[placeholder*="Ara" i]').first();
      if (await searchInput.isVisible()) {
        await searchInput.type(normalizedUser, { delay: 100 });
        await delay(3000);
        
        // Click on the first user matching normalizedUser in the list
        // Custom checkboxes or list items in selection list
        const searchResult = await this.page.locator(`span:has-text("${normalizedUser}")`).first();
        if (await searchResult.isVisible()) {
          await searchResult.click();
          await delay(1500);
          
          // Click "Chat" / "Sohbet" button
          const chatBtn = await this.page.locator('div[role="button"]:has-text("Chat"), button:has-text("Chat"), button:has-text("Sohbet"), div[role="button"]:has-text("Sohbet")').first();
          await chatBtn.click();
          await delay(3000);
        } else {
          throw new Error(`User @${normalizedUser} not found in selection list`);
        }
      }

      // 3. Locate DM Textarea and send message
      const dmAreaSelector = 'div[role="textbox"], textarea[placeholder*="Message" i], textarea[placeholder*="Mesaj" i]';
      await this.page.waitForSelector(dmAreaSelector, { state: "visible", timeout: 15000 });
      
      const dmArea = await this.page.locator(dmAreaSelector).first();
      await dmArea.click();
      await delay(500);
      await dmArea.type(text, { delay: 60 });
      await delay(1000);
      
      // Press Enter or click Send
      await dmArea.press("Enter");
      await delay(2000);

      const result = {
        success: true,
        to: normalizedUser,
        message: text,
        timestamp: new Date().toISOString()
      };

      this._recordAction("dm");
      this.emit("dmSent", result);
      return result;
    } catch (err) {
      this.emit("dmFailed", { to: normalizedUser, error: err.message });
      throw err;
    }
  }

  /**
   * Get post details from a specific user's profile (including own profile)
   * @param {string} username - User handle with or without @
   * @param {number} count - Number of posts to fetch
   */
  async getUserPosts(username, count = 12) {
    this._ensureReady();
    const normalizedUser = username.replace(/^@/, "");
    const url = `https://www.instagram.com/${normalizedUser}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(4000);

      // Check if profile exists / is active
      const exists = await this.page.evaluate(() => {
        return !document.body.innerText.includes("Sorry, this page isn't available") &&
               !document.body.innerText.includes("Üzgünüz, bu sayfaya ulaşılamıyor");
      });

      if (!exists) {
        throw new Error(`Instagram user @${normalizedUser} not found or deactivated`);
      }

      let postHrefs = new Set();
      let noNewDataCount = 0;

      while (postHrefs.size < count && noNewDataCount < 4) {
        const currentHrefs = await this.page.evaluate(() => {
          // IG now serves profile-scoped urls: /username/p/SHORTCODE/ and /username/reel/SHORTCODE/
          // Plus older flat /p/SHORTCODE/ and /reels/SHORTCODE/ formats elsewhere.
          const links = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]'));
          return links
            .map(a => a.getAttribute("href"))
            .filter(h => h && /\/(p|reel|reels)\/[A-Za-z0-9_-]{5,}\//.test(h));
        });

        let added = 0;
        for (const href of currentHrefs) {
          if (href && !postHrefs.has(href)) {
            postHrefs.add(href);
            added++;
          }
        }

        if (added === 0) {
          noNewDataCount++;
        } else {
          noNewDataCount = 0;
        }

        if (postHrefs.size >= count) break;

        // Scroll to load more posts
        await this.page.evaluate(() => window.scrollBy(0, 800));
        await delay(2000);
      }

      const results = Array.from(postHrefs)
        .map(href => {
          // Extract the /(p|reel|reels)/SHORTCODE/ portion from any URL shape
          const m = href.match(/\/(p|reel|reels)\/([A-Za-z0-9_-]+)\//);
          if (!m) return null;
          const type = m[1] === "p" ? "post" : "reel";
          const shortcode = m[2];
          return {
            shortcode,
            url: `https://www.instagram.com${href.startsWith("/") ? href : "/" + href}`,
            type
          };
        })
        .filter(Boolean)
        .slice(0, count);

      return {
        username: normalizedUser,
        count: results.length,
        posts: results
      };
    } catch (err) {
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PROFILE / STATS / DISCOVERY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Parse Instagram short-count strings ("1.2M", "12,3 B", "4.567") into a number.
   * Best-effort; returns null when it can't be parsed.
   */
  _parseCount(raw) {
    if (raw == null) return null;
    let s = String(raw).trim().toLowerCase().replace(/\s+/g, "");
    if (!s) return null;
    // Strip thousands separators (both . and ,) only when no unit suffix is present
    const unit = s.match(/[kmbtbnmilmln]/);
    let mult = 1;
    if (/k$/.test(s)) { mult = 1e3; s = s.slice(0, -1); }
    else if (/m$/.test(s) || /mn$/.test(s) || /mln$/.test(s) || /milyon$/.test(s)) { mult = 1e6; s = s.replace(/(mln|mn|milyon|m)$/, ""); }
    else if (/b$/.test(s) || /bn$/.test(s) || /milyar$/.test(s)) { mult = 1e9; s = s.replace(/(bn|milyar|b)$/, ""); }
    // Normalize decimal separators
    s = s.replace(/[.,](?=\d{3}(?:\D|$))/g, ""); // thousands sep
    s = s.replace(",", ".");
    const n = parseFloat(s);
    if (isNaN(n)) return null;
    return Math.round(n * mult);
  }

  /**
   * Get full profile info for a user: followers, following, posts, bio, isPrivate,
   * isVerified, fullName, avatar, externalUrl, businessCategory.
   * @param {string} username
   */
  async getProfile(username) {
    this._ensureReady();
    const normalizedUser = username.replace(/^@/, "");
    const url = `https://www.instagram.com/${normalizedUser}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(3500);
      await this._detectBlock();

      const exists = await this.page.evaluate(() => {
        return !document.body.innerText.includes("Sorry, this page isn't available") &&
               !document.body.innerText.includes("Üzgünüz, bu sayfaya ulaşılamıyor");
      });
      if (!exists) {
        throw new Error(`Instagram user @${normalizedUser} not found`);
      }

      const data = await this.page.evaluate(() => {
        const out = {};
        const meta = (name) => {
          const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
          return el ? el.getAttribute("content") : null;
        };

        // Try to use the meta description: "X Followers, Y Following, Z Posts - ..."
        out._metaDescription = meta("og:description");
        out._metaTitle = meta("og:title");
        out._avatarUrl = meta("og:image");

        // Header text — covers "followers", "following", "posts" labels in EN/TR
        const headerEl = document.querySelector("header") || document.body;
        const lis = Array.from(headerEl.querySelectorAll("li, ul > *, header ul li, header section ul li"));
        out._headerTexts = lis.map(li => li.innerText.trim()).filter(Boolean);

        // Bio: <h1> often contains full name; bio text is in a sibling block.
        const h = headerEl.querySelector("h1, h2");
        out._fullName = h ? h.innerText.trim() : null;

        // Bio: scan first section spans/divs containing text not equal to numbers
        const bioContainer = headerEl.querySelector("section, div[role='presentation']");
        out._bioText = bioContainer ? bioContainer.innerText : "";

        // External URL link in header
        const ext = headerEl.querySelector('a[href^="http"]:not([href*="instagram.com"])');
        out._externalUrl = ext ? ext.href : null;

        // Verified badge
        out._isVerified = !!headerEl.querySelector('svg[aria-label*="Verified" i], svg[aria-label*="Onaylı" i]');

        // Private?
        out._isPrivate = (document.body.innerText.includes("This Account is Private") ||
                         document.body.innerText.includes("Bu Hesap Gizli"));

        return out;
      });

      // Parse counts from header texts
      const parseFromLine = (line, keywords) => {
        const lower = line.toLowerCase();
        if (!keywords.some(k => lower.includes(k))) return null;
        const num = line.match(/[\d.,]+\s*[kmKMbBмMмлн]?/);
        return num ? this._parseCount(num[0]) : null;
      };

      let posts = null, followers = null, following = null;
      for (const line of data._headerTexts || []) {
        if (posts == null)     posts     = parseFromLine(line, ["posts", "gönderi", "publicaciones"]);
        if (followers == null) followers = parseFromLine(line, ["follower", "takipçi", "seguidores"]);
        if (following == null) following = parseFromLine(line, ["following", "takip", "siguiendo"]);
      }

      // Fallback parsing from meta description: "1,234 Followers, 567 Following, 89 Posts - ..."
      if ((!posts || !followers || !following) && data._metaDescription) {
        const md = data._metaDescription;
        const fol  = md.match(/([\d.,]+\s*[kmKMbB]?)\s*(Followers|Takipçi)/i);
        const flw  = md.match(/([\d.,]+\s*[kmKMbB]?)\s*(Following|Takip)/i);
        const pst  = md.match(/([\d.,]+\s*[kmKMbB]?)\s*(Posts|Gönderi)/i);
        if (fol && followers == null) followers = this._parseCount(fol[1]);
        if (flw && following == null) following = this._parseCount(flw[1]);
        if (pst && posts == null)     posts     = this._parseCount(pst[1]);
      }

      // Bio: best-effort — strip name + counts line
      let bio = (data._bioText || "").replace(data._fullName || "", "").trim();
      bio = bio.split("\n").filter(l => !/follow|takip|post|gönderi/i.test(l)).join("\n").trim();

      return {
        username: normalizedUser,
        fullName: data._fullName,
        bio,
        isPrivate: data._isPrivate,
        isVerified: data._isVerified,
        followers,
        following,
        posts,
        avatarUrl: data._avatarUrl,
        externalUrl: data._externalUrl,
        profileUrl: url,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      throw err;
    }
  }

  /** Convenience: get the bot's own profile stats (uses configured username). */
  async getMyStats() {
    if (!this.username) {
      throw new Error("No `username` configured on the bot instance");
    }
    return await this.getProfile(this.username);
  }

  /**
   * Get likes/comments counters and basic metadata for a post.
   * @param {string} postUrl - Full URL or shortcode
   */
  async getPostStats(postUrl) {
    this._ensureReady();
    const url = postUrl.startsWith("http") ? postUrl : `https://www.instagram.com/p/${postUrl}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(3500);

      const data = await this.page.evaluate(() => {
        const out = {};
        const article = document.querySelector("article") || document.body;
        const text = article.innerText || "";

        // Likes line: "X likes" / "Beğenen: X" / "X kişi beğendi" / "X beğeni"
        const likeMatch = text.match(/([\d.,]+\s*[kmKMbB]?)\s*(likes|beğeni|beğendi|like)/i)
                       || text.match(/(likes|beğen[a-zçğıöşü]*)[\s:]+([\d.,]+\s*[kmKMbB]?)/i);
        out._likesRaw = likeMatch ? (likeMatch[1] && /\d/.test(likeMatch[1]) ? likeMatch[1] : likeMatch[2]) : null;

        // Time
        const timeEl = article.querySelector("time");
        out._time = timeEl ? (timeEl.getAttribute("datetime") || timeEl.innerText) : null;

        // Caption (first comment-row by author)
        const captionEl = article.querySelector('h1, h2, div[data-testid="post-comment-root"] span');
        out._caption = captionEl ? captionEl.innerText : null;

        // Author username from header anchor
        const authorEl = article.querySelector('header a[href^="/"]');
        out._author = authorEl ? authorEl.getAttribute("href").replace(/\//g, "") : null;

        // Comments count: "View all X comments" / "X yorumun tümünü gör"
        const cMatch = text.match(/View all\s*([\d.,]+\s*[kmKMbB]?)\s*comments/i)
                    || text.match(/([\d.,]+\s*[kmKMbB]?)\s*yorum/i);
        out._commentsRaw = cMatch ? cMatch[1] : null;

        return out;
      });

      return {
        postUrl: url,
        author: data._author,
        caption: data._caption,
        likes: this._parseCount(data._likesRaw),
        comments: this._parseCount(data._commentsRaw),
        publishedAt: data._time,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Get a list of followers for a given user. Requires the account to be public
   * (or the bot to be following it).
   * @param {string} username
   * @param {number} count - Maximum entries to collect
   */
  async getFollowers(username, count = 50) {
    return await this._scrapeFollowList(username, "followers", count);
  }

  /** Get a list of accounts the user follows. */
  async getFollowing(username, count = 50) {
    return await this._scrapeFollowList(username, "following", count);
  }

  async _scrapeFollowList(username, kind, count) {
    this._ensureReady();
    const normalizedUser = username.replace(/^@/, "");
    const url = `https://www.instagram.com/${normalizedUser}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(3500);

      // Open the followers / following dialog by clicking the appropriate <a>
      const keywords = kind === "followers"
        ? ["followers", "takipçi"]
        : ["following", "takip"];
      const anchors = await this.page.locator(`header a[href*="/${normalizedUser}/${kind}"], a[href*="/${kind}"]`).all();
      let target = anchors[0];
      if (!target) {
        // Fallback: search by visible text
        const all = await this.page.locator("header a, header li").all();
        for (const a of all) {
          const t = (await a.innerText().catch(() => "")).toLowerCase();
          if (keywords.some(k => t.includes(k))) { target = a; break; }
        }
      }
      if (!target) throw new Error(`Could not open ${kind} dialog`);
      await target.click();
      await delay(2500);

      const collected = new Map();
      let noNew = 0;
      while (collected.size < count && noNew < 5) {
        const entries = await this.page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('div[role="dialog"] a[href^="/"][role="link"], div[role="dialog"] a[href^="/"]'));
          const out = [];
          for (const a of links) {
            const href = a.getAttribute("href");
            if (!href || !/^\/[\w._]+\/$/.test(href)) continue;
            const handle = href.replace(/\//g, "");
            const img = a.querySelector("img");
            out.push({
              username: handle,
              avatar: img ? img.src : null,
              fullName: a.parentElement ? (a.parentElement.innerText || "").split("\n")[0] : null
            });
          }
          return out;
        });

        let added = 0;
        for (const e of entries) {
          if (e.username && !collected.has(e.username)) {
            collected.set(e.username, e);
            added++;
          }
        }
        if (added === 0) noNew++; else noNew = 0;
        if (collected.size >= count) break;

        // Scroll the dialog list
        await this.page.evaluate(() => {
          const dialog = document.querySelector('div[role="dialog"]');
          if (!dialog) return;
          const scrollables = Array.from(dialog.querySelectorAll("div")).filter(d => d.scrollHeight > d.clientHeight + 10);
          const sc = scrollables.find(d => d.clientHeight > 200) || dialog;
          sc.scrollBy(0, 600);
        });
        await delay(1500);
      }

      // Close dialog
      try {
        const closeBtn = await this.page.locator('svg[aria-label="Close"], svg[aria-label="Kapat"]').first();
        if (await closeBtn.isVisible()) await closeBtn.locator("xpath=..").click({ force: true });
      } catch (_) {}

      return {
        username: normalizedUser,
        kind,
        collected: collected.size,
        list: Array.from(collected.values()).slice(0, count)
      };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Search Instagram for users / hashtags / places matching a query.
   * @param {string} query
   * @returns {Promise<{users:Array, hashtags:Array, places:Array}>}
   */
  async search(query) {
    this._ensureReady();
    try {
      await this.page.goto(`https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(query)}`, {
        waitUntil: "domcontentloaded"
      });
      await delay(3500);

      const data = await this.page.evaluate(() => {
        const out = { users: [], hashtags: [], places: [] };
        const links = Array.from(document.querySelectorAll('a[href^="/"]'));
        const seen = new Set();
        for (const a of links) {
          const href = a.getAttribute("href");
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const text = (a.innerText || "").trim();
          if (/^\/explore\/tags\//.test(href)) {
            out.hashtags.push({ tag: href.split("/").filter(Boolean).pop(), text });
          } else if (/^\/explore\/locations\//.test(href)) {
            out.places.push({ id: href.split("/").filter(Boolean)[2], text });
          } else if (/^\/[\w._]+\/$/.test(href)) {
            const img = a.querySelector("img");
            out.users.push({
              username: href.replace(/\//g, ""),
              avatar: img ? img.src : null,
              text
            });
          }
        }
        return out;
      });

      return { query, ...data, timestamp: new Date().toISOString() };
    } catch (err) {
      throw err;
    }
  }

  /** Backwards-compat alias used in the plan API. */
  async searchUsers(query) {
    const res = await this.search(query);
    return res.users;
  }

  /**
   * Get post links for a given hashtag. Useful for batched scrape/like flows.
   */
  async getHashtagPosts(hashtag, count = 20) {
    this._ensureReady();
    const tag = hashtag.replace(/^#/, "");
    const url = `https://www.instagram.com/explore/tags/${tag}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(3500);

      const hrefs = new Set();
      let noNew = 0;
      while (hrefs.size < count && noNew < 4) {
        const current = await this.page.evaluate(() => {
          return Array.from(document.querySelectorAll('a[href^="/p/"], a[href^="/reel/"], a[href^="/reels/"]'))
            .map(a => a.getAttribute("href"));
        });
        const before = hrefs.size;
        current.forEach(h => h && hrefs.add(h));
        if (hrefs.size === before) noNew++; else noNew = 0;
        if (hrefs.size >= count) break;
        await this.page.evaluate(() => window.scrollBy(0, 1000));
        await delay(1500);
      }

      const posts = Array.from(hrefs).slice(0, count).map(h => {
        const parts = h.split("/").filter(Boolean);
        return {
          shortcode: parts[1],
          type: parts[0] === "p" ? "post" : "reel",
          url: `https://www.instagram.com${h}`
        };
      });

      return { hashtag: tag, count: posts.length, posts };
    } catch (err) {
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  STORIES / DM EXTRAS / SAVES
  // ═══════════════════════════════════════════════════════════════════════════

  /** Open and view a user's current story (counts as a view). */
  async viewStory(username) {
    this._ensureReady();
    const normalizedUser = username.replace(/^@/, "");
    try {
      await this.page.goto(`https://www.instagram.com/stories/${normalizedUser}/`, { waitUntil: "domcontentloaded" });
      await delay(3000);

      // Some accounts have no live story => 404 / redirect
      const url = this.page.url();
      if (!url.includes("/stories/")) {
        return { username: normalizedUser, viewed: false, reason: "no_active_story" };
      }

      // Start playback if a "View story" button shows up
      const viewBtn = this.page.locator('div[role="button"]:has-text("View story"), div[role="button"]:has-text("Hikayeyi gör")').first();
      if (await viewBtn.isVisible().catch(() => false)) {
        await viewBtn.click();
        await delay(1500);
      }

      // Linger a few seconds to register the view
      await delay(5000);

      const result = { username: normalizedUser, viewed: true, timestamp: new Date().toISOString() };
      this.emit("storyViewed", result);
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * React to the currently-open story of a user with an emoji.
   * @param {string} username
   * @param {string} emoji
   */
  async reactToStory(username, emoji = "🔥") {
    this._ensureReady();
    const normalizedUser = username.replace(/^@/, "");
    try {
      await this.page.goto(`https://www.instagram.com/stories/${normalizedUser}/`, { waitUntil: "domcontentloaded" });
      await delay(3500);
      await this._dismissDialogs();

      // The story reply box is a contenteditable / textarea at the bottom
      const replySelector = 'textarea[placeholder*="Reply" i], textarea[placeholder*="Yanıtla" i], div[contenteditable="true"][aria-label*="Reply" i], div[contenteditable="true"][aria-label*="Yanıtla" i]';
      const reply = this.page.locator(replySelector).first();
      await reply.waitFor({ state: "visible", timeout: 10000 });
      await reply.click();
      await delay(400);
      await reply.type(emoji, { delay: 50 });
      await delay(400);
      await reply.press("Enter");
      await delay(1500);

      const result = { username: normalizedUser, emoji, timestamp: new Date().toISOString() };
      this.emit("storyReacted", result);
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Read the DM inbox — recent threads with last-message preview.
   * @param {number} count
   */
  async getInbox(count = 20) {
    this._ensureReady();
    try {
      await this.page.goto("https://www.instagram.com/direct/inbox/", { waitUntil: "domcontentloaded" });
      await delay(4000);
      await this._dismissDialogs();

      const threads = await this.page.evaluate(() => {
        const out = [];
        const items = Array.from(document.querySelectorAll('a[href^="/direct/t/"], div[role="listitem"] a[href*="/direct/t/"]'));
        const seen = new Set();
        for (const a of items) {
          const href = a.getAttribute("href");
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const id = href.split("/").filter(Boolean).pop();
          const text = (a.innerText || "").split("\n").map(s => s.trim()).filter(Boolean);
          out.push({
            threadId: id,
            url: `https://www.instagram.com${href}`,
            title: text[0] || null,
            preview: text.slice(1).join(" | ") || null
          });
        }
        return out;
      });

      return { collected: threads.length, threads: threads.slice(0, count) };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Read recent messages in a specific DM thread.
   * @param {string} threadId - The id from getInbox()
   * @param {number} count
   */
  async getMessages(threadId, count = 30) {
    this._ensureReady();
    try {
      await this.page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: "domcontentloaded" });
      await delay(4000);

      const messages = await this.page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('div[role="row"], div[data-pagelet*="MWThread"] div[role="listitem"]'));
        const out = [];
        for (const it of items) {
          const text = (it.innerText || "").trim();
          if (!text) continue;
          out.push({ text });
        }
        return out;
      });

      return { threadId, collected: messages.length, messages: messages.slice(-count) };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Save (bookmark) a post.
   */
  async savePost(postUrl) {
    this._ensureReady();
    const url = postUrl.startsWith("http") ? postUrl : `https://www.instagram.com/p/${postUrl}/`;
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(3000);

      const saveSvg = this.page.locator('svg[aria-label*="Save" i], svg[aria-label*="Kaydet" i]').first();
      const removeSvg = this.page.locator('svg[aria-label*="Remove" i], svg[aria-label*="Kaldır" i]').first();
      if (await removeSvg.isVisible().catch(() => false)) {
        return { postUrl: url, status: "already_saved" };
      }
      await saveSvg.locator("xpath=..").click();
      await delay(1500);
      return { postUrl: url, status: "saved", timestamp: new Date().toISOString() };
    } catch (err) {
      throw err;
    }
  }

  /** Remove a post from saved/bookmarks. */
  async unsavePost(postUrl) {
    this._ensureReady();
    const url = postUrl.startsWith("http") ? postUrl : `https://www.instagram.com/p/${postUrl}/`;
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(3000);

      const removeSvg = this.page.locator('svg[aria-label*="Remove" i], svg[aria-label*="Kaldır" i]').first();
      if (!(await removeSvg.isVisible().catch(() => false))) {
        return { postUrl: url, status: "not_saved" };
      }
      await removeSvg.locator("xpath=..").click();
      await delay(1500);
      return { postUrl: url, status: "unsaved", timestamp: new Date().toISOString() };
    } catch (err) {
      throw err;
    }
  }

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
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  _ensureReady() {
    if (!this.isReady) {
      throw new Error("Bot is not ready. Wait for 'ready' event or call init() first.");
    }
  }

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

  async close() {
    if (this.browser) {
      await this.browser.close();
    } else if (this.context) {
      await this.context.close();
    }
    this.emit("closed");
  }
}

module.exports = InstagramBot;
