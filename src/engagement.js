"use strict";

const { delay } = require("./utils");

/**
 * Engagement: comment, like / unlike, save / unsave, and bulk hashtag liking.
 * Mixed into InstagramBot.prototype.
 */
module.exports = {
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
  },

  /**
   * Reply to a specific comment on a post — a threaded reply that @mentions the
   * commenter. Pairs with the mention listener: when someone @mentions you in a
   * comment, reply right under it. Posts via Instagram's web comment endpoint
   * (reliable), so it also returns the new reply's id.
   *
   * @param {string} postUrl - post URL or shortcode
   * @param {string|number|object} target - the comment id to reply to, or a
   *   commenter USERNAME / comment TEXT to look it up by (or `{ commentId }` /
   *   `{ username }` / `{ text }`). A `mentioned` event object works directly
   *   (uses its `commentId`, else `from`).
   * @param {string} text - reply text
   * @returns {Promise<{success:boolean,postUrl:string,repliedToCommentId:string,commentId:string,text:string,timestamp:string}>}
   */
  async replyToComment(postUrl, target, text) {
    this._ensureReady();
    this._checkRateLimit("comment");
    const url = postUrl.startsWith("http") ? postUrl : `https://www.instagram.com/p/${postUrl}/`;
    const m = url.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    const shortcode = m ? m[2] : postUrl;
    const mediaId = this._shortcodeToMediaId(shortcode);

    if (!this.page.url().includes("instagram.com")) {
      await this.page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
      await delay(1200);
    }

    try {
      // Resolve the comment id to reply to.
      let commentId = null;
      const direct = (target && typeof target === "object")
        ? (target.commentId || target.comment_id || target.id)
        : target;
      if (direct != null && /^\d+$/.test(String(direct))) {
        commentId = String(direct);
      } else {
        const needle = (typeof target === "string" ? target : (target && (target.username || target.text)) || "").replace(/^@/, "");
        if (!needle) throw new Error("replyToComment: provide a comment id, commenter username, or comment text");
        commentId = await this.page.evaluate(async ({ mid, needle }) => {
          const r = await fetch(`/api/v1/media/${mid}/comments/?can_support_threading=true&permalink_enabled=false`,
            { headers: { "x-ig-app-id": "936619743392459" }, credentials: "include" });
          if (!r.ok) return null;
          const j = await r.json();
          const lc = needle.toLowerCase();
          const comments = j.comments || [];
          const c = comments.find(x => ((x.user && x.user.username) || "").toLowerCase() === lc)
                 || comments.find(x => (x.text || "").toLowerCase().includes(lc));
          return c ? c.pk : null;
        }, { mid: mediaId, needle });
        if (!commentId) throw new Error(`replyToComment: no comment matching "${needle}" found on this post`);
      }

      // Post the reply via the web comment endpoint.
      const res = await this.page.evaluate(async ({ mid, cid, text }) => {
        const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
        const r = await fetch(`/api/v1/web/comments/${mid}/add/`, {
          method: "POST",
          headers: { "x-ig-app-id": "936619743392459", "x-csrftoken": csrf, "content-type": "application/x-www-form-urlencoded" },
          credentials: "include",
          body: new URLSearchParams({ comment_text: text, replied_to_comment_id: String(cid) }).toString(),
        });
        let j = null; try { j = await r.json(); } catch (_) {}
        return { status: r.status, ok: j && j.status === "ok", id: j && j.id, message: j && j.message };
      }, { mid: mediaId, cid: commentId, text });

      if (!res.ok) {
        throw new Error(`replyToComment: failed (status ${res.status}${res.message ? " — " + res.message : ""})`);
      }

      const result = { success: true, postUrl: url, repliedToCommentId: commentId, commentId: res.id, text, timestamp: new Date().toISOString() };
      this._recordAction("comment");
      this.emit("commentReplied", result);
      return result;
    } catch (err) {
      this.emit("commentFailed", { postUrl: url, text, error: err.message });
      throw err;
    }
  },

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
  },

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
  },

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
  },

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
  },

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
};
