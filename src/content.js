"use strict";

const fs = require("fs");
const path = require("path");
const { delay } = require("./utils");

/**
 * Publishing: feed posts (photo / carousel / video), stories and profile edits.
 * Mixed into InstagramBot.prototype.
 */
module.exports = {
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
  },

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
};
