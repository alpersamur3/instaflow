"use strict";

const { chromium, devices } = require("playwright");
const fs = require("fs");
const path = require("path");
const { delay } = require("./utils");

/**
 * Publishing: feed posts (photo / carousel / video), stories and profile edits.
 * Mixed into InstagramBot.prototype.
 */
module.exports = {
  /**
   * Click the sidebar "Create" / "New post" (+) button to open the create menu.
   * Shared by post() and postStory(); the caller then picks the Post or Story
   * entry from the popover. Uses a JS-level click fallback for narrow viewports
   * where the link sits just outside Playwright's strict actionability check.
   * @private
   */
  async _openCreateMenu() {
    // The clickable element is the parent <a>, not the inner svg. Match by the
    // aria-label on the nested SVG (EN + TR). Case-insensitive partial matches —
    // IG localizes labels and changes casing between builds.
    const newPostSelectors = [
      'a:has(svg[aria-label*="New post" i])',
      'a:has(svg[aria-label*="Yeni Gönderi" i])',
      'a:has(svg[aria-label*="Create" i])',
      'a:has(svg[aria-label*="Oluştur" i])'
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
  },

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

      // 1. Open the Create (+) menu in the sidebar.
      await this._openCreateMenu();

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

      // 3a. Force 9:16 (portrait) crop — otherwise IG defaults videos to 1:1 and
      // they post as a square POST, not a REEL. Dismiss the reels-info (OK) modal first.
      const okModal = await findDialogBtn([/^OK$/i, /^Tamam$/i], 1);
      if (okModal) { await okModal.click({ force: true }).catch(() => {}); await delay(1200); }
      try {
        const cropSelect = this.page.locator(
          'div[role="dialog"] button:has(svg[aria-label="Select crop"]), ' +
          'div[role="dialog"] button:has(svg[aria-label="Kırpmayı seç"])',
        ).first();
        if (await cropSelect.count() > 0 && await cropSelect.isVisible().catch(() => false)) {
          await cropSelect.click({ force: true });
          await delay(1200);
          const ratio = this.page.locator(
            'div[role="dialog"] div[role="button"]:has(span:text-is("9:16"))',
          ).first();
          if (await ratio.count() > 0) {
            await ratio.click({ force: true });
            await delay(1200);
          }
        }
      } catch (e) { /* crop selection is best-effort */ }

      // 3-4. Advance through create steps (Crop → Edit → [video: Cover] → Caption).
      // Videos/reels have an EXTRA screen vs images, and need processing time, so
      // loop: click "Next" until the caption textbox appears (handles both cases).
      const captionArea =
        'div[role="dialog"] div[role="textbox"][aria-label="Write a caption..."], ' +
        'div[role="dialog"] div[role="textbox"][aria-label="Açıklama yaz..."], ' +
        'div[role="dialog"] div[role="textbox"][contenteditable="true"]';
      let captionReady = false;
      for (let step = 0; step < 8 && !captionReady; step++) {
        if (await this.page.locator(captionArea).first().isVisible().catch(() => false)) {
          captionReady = true;
          break;
        }
        // Video uploads pop a modal: "Video posts are now shared as reels" (OK) —
        // it overlays the Crop screen, so dismiss it BEFORE clicking Next.
        const okBtn = await findDialogBtn([/^OK$/i, /^Tamam$/i], 1);
        if (okBtn) { await okBtn.click({ force: true }); await delay(1500); continue; }

        const next = await findDialogBtn([/^Next$/i, /^İleri$/i], 2);
        if (next) {
          await next.click({ force: true });
          await delay(3000);
        } else {
          await delay(2500); // still processing (e.g. video) — wait and re-check
        }
      }

      // 5. Fill caption
      await this.page.waitForSelector(captionArea, { state: "visible", timeout: 20000 });
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
  },

  /**
   * Publish a Story from a local image or video file.
   *
   * Instagram removed story creation from the desktop website — the only working
   * web path is the mobile site. This method spins up a short-lived
   * mobile-emulated browser context seeded with the current session cookies,
   * opens the mobile create (+) menu, picks "Story" (which opens a native file
   * chooser), then clicks "Add to your story" to publish, and finally tears the
   * context down. The main desktop session is left untouched.
   * @param {string} mediaPath - Path to a local image or video
   */
  async postStory(mediaPath) {
    this._ensureReady();
    this._checkRateLimit("story");
    const resolvedPath = path.resolve(mediaPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Media file not found: ${resolvedPath}`);
    }

    let mobileBrowser = null;
    try {
      // Reuse the live session by copying its cookies into a fresh mobile context.
      const cookies = await this.context.cookies();

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

      mobileBrowser = await chromium.launch(launchOptions);
      const mobileCtx = await mobileBrowser.newContext({ ...devices["iPhone 13"] });
      await mobileCtx.addCookies(cookies);
      const page = await mobileCtx.newPage();
      page.setDefaultTimeout(this.timeout);

      await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
      await delay(5000);

      // Dismiss the stacked onboarding popups. On the mobile site these are
      // div[role="button"] ("Tamam"/"OK" for the messaging-tab notice,
      // "Şimdi değil"/"Not now" for save-login) and a circular X ("Kapat"/
      // "Close") on some cards. They overlay and block the story tray, so clear
      // them all — by text, by the close (X) control, and with Escape as a
      // catch-all — before touching "Your story".
      const dismissSelectors = [
        'div[role="button"]:has-text("Tamam")',
        'button:has-text("Tamam")',
        'div[role="button"]:has-text("OK")',
        'button:has-text("OK")',
        'div[role="button"]:has-text("Not now")',
        'div[role="button"]:has-text("Şimdi değil")',
        'button:has-text("Not now")',
        'div[aria-label="Kapat"]',
        'div[aria-label="Close"]',
        '[aria-label="Kapat"]',
        '[aria-label="Close"]'
      ];
      for (let round = 0; round < 6; round++) {
        let clicked = false;
        for (const sel of dismissSelectors) {
          const btn = page.locator(sel).first();
          if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
            await btn.click({ force: true }).catch(() => {});
            clicked = true;
            await delay(900);
          }
        }
        if (!clicked) break;
        await page.keyboard.press("Escape").catch(() => {});
      }

      // A persistent filechooser handler is more robust than racing a single
      // waitForEvent against the click — it sets the file whenever the chooser
      // appears, surviving retries and slow (non-headless) timing.
      let storyFileChosen = false;
      page.on("filechooser", async (fc) => {
        if (storyFileChosen) return;
        try { await fc.setFiles(resolvedPath); storyFileChosen = true; } catch (_) {}
      });

      const reachedComposer = () => page.url().includes("/create/story");

      // Open the create menu via the top-bar "+" and pick "Story". Note IG
      // mislabels that "+" button's icon as "Home"/"Ana Sayfa"; the real tell is
      // that it's an a[href="#"] (a JS action, not a navigation link). Going
      // through the create menu works whether or not an active story already
      // exists — unlike tapping the "Your story" tray bubble, which only opens
      // the uploader when there's no current story (otherwise it just views it).
      for (let attempt = 0; attempt < 3 && !storyFileChosen && !reachedComposer(); attempt++) {
        const createBtn = page.locator(
          'a[href="#"]:has(svg[aria-label="Home"]), ' +
          'a[href="#"]:has(svg[aria-label="Ana Sayfa"]), ' +
          'a[href="#"]'
        ).first();
        if (!(await createBtn.count() > 0)) {
          if (attempt === 0) throw new Error("Mobile create (+) button not found — session may be logged out.");
          break;
        }
        await createBtn.click({ force: true }).catch(() => {});
        await delay(1800);

        const storyOption = page.locator(
          'div[role="button"]:has(svg[aria-label="Story"]), ' +
          'div[role="button"]:has(svg[aria-label="Hikaye"])'
        ).first();
        if (await storyOption.count() > 0 && await storyOption.isVisible().catch(() => false)) {
          await storyOption.click({ force: true }).catch(() => {});
        }
        for (let i = 0; i < 12 && !storyFileChosen && !reachedComposer(); i++) {
          await delay(1000);
        }
      }
      if (!storyFileChosen && !reachedComposer()) {
        throw new Error("Could not open the story uploader from the mobile create (+) menu.");
      }

      // The composer lives at /create/story/. Wait for it, then publish.
      await page.waitForURL(/\/create\/story/, { timeout: 20000 }).catch(() => {});
      await delay(3000);

      const shareBtn = page.locator(
        'div[role="button"]:has-text("Add to your story"), ' +
        'div[role="button"]:has-text("Add to story"), ' +
        'div[role="button"]:has-text("Hikayene ekle"), ' +
        'button:has-text("Add to your story"), ' +
        'button:has-text("Share")'
      ).first();
      try {
        await shareBtn.waitFor({ state: "visible", timeout: 15000 });
        await shareBtn.click({ force: true });
      } catch (_) {
        // Fallback: click the affordance by its visible text.
        await page.getByText(/Add to your story|Hikayene ekle/i).first().click({ force: true });
      }

      await delay(8000); // let the upload finish

      const result = {
        success: true,
        timestamp: new Date().toISOString()
      };
      this._recordAction("story");
      this.emit("storyPublished", result);
      return result;
    } catch (err) {
      this.emit("storyFailed", { error: err.message });
      throw err;
    } finally {
      if (mobileBrowser) await mobileBrowser.close().catch(() => {});
    }
  },

  /**
   * Update authenticated profile metadata on the /accounts/edit/ page.
   * Every field is optional — only the ones you pass are touched.
   * @param {object} options
   * @param {string} [options.name]    - Display / full name
   * @param {string} [options.bio]     - Profile biography text
   * @param {string} [options.website] - External URL (where the edit form exposes it)
   * @param {string} [options.avatar]  - Local path to a new profile picture
   * @returns {Promise<{name:boolean,bio:boolean,website:boolean,avatar:boolean,saved:boolean,timestamp:string}>}
   */
  async setupProfile(options = {}) {
    this._ensureReady();

    try {
      await this.page.goto("https://www.instagram.com/accounts/edit/", { waitUntil: "domcontentloaded" });
      await delay(4000);
      await this._dismissDialogs();

      const report = { name: false, bio: false, website: false, avatar: false, saved: false };

      // Helper: clear + type into the first visible match of a selector list.
      const fillField = async (selector, value) => {
        const el = this.page.locator(selector).first();
        if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
          await el.fill("");
          await el.type(value, { delay: 30 });
          return true;
        }
        return false;
      };

      // ── Display / full name ─────────────────────────────────────────────────
      if (options.name !== undefined) {
        report.name = await fillField(
          'input[id="pepName"], input[aria-label*="Name" i], input[aria-label*="Ad" i], input[placeholder*="Name" i], input[name="first_name"]',
          options.name
        );
      }

      // ── Bio ─────────────────────────────────────────────────────────────────
      if (options.bio !== undefined) {
        const bioSelector = 'textarea[id="pepBiography"], textarea[aria-label*="Bio" i], textarea[aria-label*="Biyografi" i], textarea';
        await this.page.waitForSelector(bioSelector, { state: "visible", timeout: 10000 }).catch(() => {});
        report.bio = await fillField(bioSelector, options.bio);
      }

      // ── Website ─────────────────────────────────────────────────────────────
      if (options.website !== undefined) {
        report.website = await fillField(
          'input[id="pepWebsite"], input[placeholder="Website" i], input[aria-label*="Website" i], input[name="external_url"]',
          options.website
        );
      }

      // ── Avatar / profile picture ────────────────────────────────────────────
      if (options.avatar) {
        const resolvedPath = path.resolve(options.avatar);
        if (!fs.existsSync(resolvedPath)) {
          throw new Error(`Profile photo not found: ${resolvedPath}`);
        }

        // Click "Change Profile Photo" / "Profil Fotoğrafını Değiştir"
        const changePhotoSelectors = [
          'button:has-text("Change profile photo")', 'button:has-text("Profil Fotoğrafını Değiştir")',
          'button:has-text("Change photo")', 'button:has-text("Fotoğrafı Değiştir")',
          'div[role="button"]:has-text("Change profile photo")', 'div[role="button"]:has-text("Profil Fotoğrafını Değiştir")'
        ];
        let changeBtn = null;
        for (const selector of changePhotoSelectors) {
          const btn = this.page.locator(selector).first();
          if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
            changeBtn = btn;
            break;
          }
        }

        if (changeBtn) {
          // Clicking "Change profile photo" may open a menu whose "Upload Photo"
          // entry is the real file trigger — handle both the direct chooser and
          // the submenu case by racing the click against a filechooser event.
          try {
            const [fileChooser] = await Promise.all([
              this.page.waitForEvent("filechooser", { timeout: 8000 }),
              (async () => {
                await changeBtn.click();
                await delay(800);
                const uploadOpt = this.page.locator(
                  'button:has-text("Upload Photo"), button:has-text("Upload photo"), ' +
                  'button:has-text("Fotoğraf Yükle"), ' +
                  '[role="menuitem"]:has-text("Upload"), [role="menuitem"]:has-text("Yükle")'
                ).first();
                if (await uploadOpt.count() > 0 && await uploadOpt.isVisible().catch(() => false)) {
                  await uploadOpt.click().catch(() => {});
                }
              })()
            ]);
            await fileChooser.setFiles(resolvedPath);
            report.avatar = true;
          } catch (_) {
            // Fallback: a hidden input[type="file"] is sometimes present directly.
            const inp = this.page.locator('input[type="file"]').first();
            if (await inp.count() > 0) {
              await inp.setInputFiles(resolvedPath);
              report.avatar = true;
            }
          }
          await delay(5000); // wait for upload + auto-save
        }
      }

      // ── Submit changes ──────────────────────────────────────────────────────
      // In modern Instagram Web the Submit control is a div[role="button"]
      // wrapping a span with text "Gönder" / "Submit" (text fields only — avatar
      // changes save automatically).
      const submitSelectors = [
        'div[role="button"]:has-text("Submit")',
        'div[role="button"]:has-text("Gönder")',
        'div[role="button"]:has-text("Save")',
        'div[role="button"]:has-text("Kaydet")',
        'button[type="submit"]',
        'button:has-text("Submit")',
        'button:has-text("Gönder")'
      ].join(', ');

      const submitBtn = this.page.locator(submitSelectors).first();
      if (await submitBtn.count() > 0 && await submitBtn.isVisible().catch(() => false) &&
          (report.name || report.bio || report.website)) {
        await submitBtn.click();
        await delay(3500);
        report.saved = true;
      } else {
        report.saved = report.avatar; // avatar changes save automatically
      }

      const finalResult = { ...report, timestamp: new Date().toISOString() };
      this.emit("profileSetup", finalResult);
      return finalResult;
    } catch (err) {
      this.emit("profileSetupFailed", { error: err.message });
      throw err;
    }
  },

  /**
   * Delete one of your own posts/reels.
   * Opens the post's "More options" (…) menu, clicks Delete, and confirms.
   * @param {string} postUrl - Full URL or shortcode of a post you own
   * @returns {Promise<{success:boolean,postUrl:string,timestamp:string}>}
   */
  async deletePost(postUrl) {
    this._ensureReady();
    const url = postUrl.startsWith("http") ? postUrl : `https://www.instagram.com/p/${postUrl}/`;

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(3500);
      await this._dismissDialogs();

      // 1. Open the "…" (More options) menu on the post.
      const moreBtn = this.page.locator(
        'svg[aria-label="More options"], svg[aria-label="Seçenekler"], ' +
        'svg[aria-label="Diğer seçenekler"], svg[aria-label="More"]'
      ).first();
      await moreBtn.waitFor({ state: "visible", timeout: 12000 });
      await moreBtn.locator("xpath=ancestor::*[self::button or @role='button'][1]")
        .click({ force: true })
        .catch(async () => { await moreBtn.click({ force: true }); });
      await delay(1500);

      // 2. Click "Delete" / "Sil" in the menu.
      const deleteEntry = this.page.locator(
        'button:has-text("Delete"), button:has-text("Sil"), ' +
        'div[role="button"]:has-text("Delete"), div[role="button"]:has-text("Sil"), ' +
        '[role="menuitem"]:has-text("Delete"), [role="menuitem"]:has-text("Sil")'
      ).first();
      await deleteEntry.waitFor({ state: "visible", timeout: 8000 });
      await deleteEntry.click({ force: true });
      await delay(1800);

      // 3. Confirm in the "Delete post?" dialog (its own Delete/Sil button).
      const confirmBtn = this.page.locator(
        'div[role="dialog"] button:has-text("Delete"), div[role="dialog"] button:has-text("Sil"), ' +
        'div[role="dialog"] div[role="button"]:has-text("Delete"), div[role="dialog"] div[role="button"]:has-text("Sil"), ' +
        'button:has-text("Delete"), button:has-text("Sil")'
      ).first();
      await confirmBtn.waitFor({ state: "visible", timeout: 8000 });
      await confirmBtn.click({ force: true });
      await delay(3000);

      const result = { success: true, postUrl: url, timestamp: new Date().toISOString() };
      this.emit("postDeleted", result);
      return result;
    } catch (err) {
      this.emit("postDeleteFailed", { postUrl: url, error: err.message });
      throw err;
    }
  }
};
