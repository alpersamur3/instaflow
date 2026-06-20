"use strict";

const { delay } = require("./utils");

/**
 * Social graph: follow / unfollow, direct messages and story interactions.
 * Mixed into InstagramBot.prototype.
 */
module.exports = {
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
  },

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
  },

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
      // Open the user's profile and click "Message" — this opens an inline chat
      // overlay with a contenteditable message box. (Instagram's standalone
      // /direct/new/ composer changes frequently and dropped the old "Chat"
      // confirm step; the profile "Message" button is the stable entry point.)
      await this.page.goto(`https://www.instagram.com/${normalizedUser}/`, { waitUntil: "domcontentloaded" });
      await delay(3500);
      await this._dismissDialogs();

      const exists = await this.page.evaluate(() =>
        !document.body.innerText.includes("Sorry, this page isn't available") &&
        !document.body.innerText.includes("Üzgünüz, bu sayfaya ulaşılamıyor")
      );
      if (!exists) {
        throw new Error(`Instagram user @${normalizedUser} not found`);
      }

      const msgBtn = this.page.locator(
        'div[role="button"]:has-text("Message"), button:has-text("Message"), ' +
        'div[role="button"]:has-text("Mesaj gönder"), button:has-text("Mesaj gönder"), ' +
        'div[role="button"]:has-text("Mesaj"), button:has-text("Mesaj")'
      ).first();
      if (!(await msgBtn.count() > 0)) {
        throw new Error(`No "Message" button on @${normalizedUser}'s profile — they may not allow DMs from you.`);
      }
      await msgBtn.click({ force: true });
      await delay(4000);
      await this._dismissDialogs();

      // The chat opens inline (overlay) or at /direct/t/…; the input is a
      // contenteditable textbox (newer) or a textarea (older).
      const dmAreaSelector =
        'div[role="textbox"][contenteditable="true"], ' +
        'textarea[placeholder*="Message" i], textarea[placeholder*="Mesaj" i], ' +
        'div[aria-label*="Message" i][contenteditable="true"], ' +
        'div[aria-label*="Mesaj" i][contenteditable="true"]';
      await this.page.waitForSelector(dmAreaSelector, { state: "visible", timeout: 15000 });

      const dmArea = this.page.locator(dmAreaSelector).first();
      await dmArea.click();
      await delay(500);
      await dmArea.type(text, { delay: 50 });
      await delay(800);
      await dmArea.press("Enter");
      await delay(2500);

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
  },

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
  },

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

      // No active story → Instagram redirects away from /stories/.
      if (!this.page.url().includes("/stories/")) {
        return { username: normalizedUser, reacted: false, reason: "no_active_story" };
      }

      // Start playback if a "View story" gate is shown — the reply box only
      // mounts once the story is actually playing.
      const viewBtn = this.page.locator(
        'div[role="button"]:has-text("View story"), div[role="button"]:has-text("Hikayeyi gör")'
      ).first();
      if (await viewBtn.isVisible().catch(() => false)) {
        await viewBtn.click().catch(() => {});
        await delay(2000);
      }

      // The story reply box is a contenteditable / textarea at the bottom. If it
      // never appears (story already ended, or replies are off), bail gracefully
      // instead of throwing.
      const replySelector = 'textarea[placeholder*="Reply" i], textarea[placeholder*="Yanıtla" i], div[contenteditable="true"][aria-label*="Reply" i], div[contenteditable="true"][aria-label*="Yanıtla" i]';
      const reply = this.page.locator(replySelector).first();
      try {
        await reply.waitFor({ state: "visible", timeout: 8000 });
      } catch (_) {
        return { username: normalizedUser, reacted: false, reason: "no_reply_box" };
      }
      await reply.click();
      await delay(400);
      await reply.type(emoji, { delay: 50 });
      await delay(400);
      await reply.press("Enter");
      await delay(1500);

      const result = { username: normalizedUser, reacted: true, emoji, timestamp: new Date().toISOString() };
      this.emit("storyReacted", result);
      return result;
    } catch (err) {
      throw err;
    }
  },

  /**
   * Start polling the DM inbox and emit a `messageReceived` event for every new
   * incoming message. Each payload is a normalized object:
   *   { threadId, threadTitle, itemId, from, fromId, fromSelf, type, text, media,
   *     timestamp, sender }
   * where `type` is "text" | "reel" | "post" | (raw IG item_type), `media`
   * (shared reels/posts) is { type, shortcode, url } — feed straight into
   * `analyzeReel(msg)` — and `sender` describes who sent it:
   *   sender = { username, fullName, avatar, isVerified, isPrivate, accountType,
   *              hasHighlights, friendship:{following,followedBy,isBestie,muting,
   *              blocking,restricted}, lastActiveAt }
   * These come free from the inbox payload. With `enrichSender: true`, each new
   * sender is additionally augmented (one extra request each) with:
   *   sender += { bio, followers, following, posts, externalUrl,
   *               hasActiveStory, storyCount }
   *
   * Polling runs on a dedicated background tab so it doesn't disturb the main page.
   *
   * @param {object} [options]
   * @param {number}  [options.interval=6000]      - poll period (ms)
   * @param {number}  [options.limit=20]           - threads to scan per poll
   * @param {boolean} [options.includeSelf=false]  - also emit your own messages
   * @param {boolean} [options.emitExisting=false] - emit the current backlog on start
   * @param {boolean} [options.enrichSender=false] - add bio/followers/story to sender
   */
  async startMessageListener(options = {}) {
    this._ensureReady();
    if (this._msgTimer) return this; // already running

    const interval = options.interval || 6000;
    const limit = options.limit || 20;
    const includeSelf = !!options.includeSelf;
    const emitExisting = !!options.emitExisting;
    const enrichSender = !!options.enrichSender;

    this._msgSeen = new Set();
    this._msgPage = await this.context.newPage();
    await this._msgPage.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" }).catch(() => {});

    let seeded = false;
    const poll = async () => {
      if (this._msgPolling || !this._msgPage) return;
      this._msgPolling = true;
      try {
        const items = await this._msgPage.evaluate(async (lim) => {
          const r = await fetch(`/api/v1/direct_v2/inbox/?persistentBadging=true&limit=${lim}`,
            { headers: { "x-ig-app-id": "936619743392459" }, credentials: "include" });
          if (!r.ok) return [];
          const j = await r.json();
          const viewerId = j.viewer && j.viewer.pk ? String(j.viewer.pk) : null;
          const threads = (j.inbox && j.inbox.threads) || [];
          const out = [];
          for (const t of threads) {
            const umap = {};
            (t.users || []).forEach(u => { umap[String(u.pk)] = u; });
            for (const it of (t.items || [])) {
              const sid = String(it.user_id);
              let type = it.item_type, text = it.text || null, media = null;
              if (it.item_type === "clip" && it.clip && it.clip.clip) {
                type = "reel";
                media = { type: "reel", shortcode: it.clip.clip.code, url: `https://www.instagram.com/reel/${it.clip.clip.code}/` };
              } else if (it.item_type === "reel_share" && it.reel_share && it.reel_share.media && it.reel_share.media.code) {
                type = "reel"; text = it.reel_share.text || null;
                media = { type: "reel", shortcode: it.reel_share.media.code, url: `https://www.instagram.com/reel/${it.reel_share.media.code}/` };
              } else if (it.item_type === "media_share" && it.media_share && it.media_share.code) {
                type = "post";
                media = { type: "post", shortcode: it.media_share.code, url: `https://www.instagram.com/p/${it.media_share.code}/` };
              }
              // Sender profile (free, from the inbox users[] + last_seen_at).
              const su = umap[sid];
              const ls = t.last_seen_at && t.last_seen_at[sid];
              const fs = su && su.friendship_status;
              const sender = su ? {
                username: su.username,
                fullName: su.full_name || null,
                avatar: su.profile_pic_url || null,
                isVerified: !!su.is_verified,
                isPrivate: !!su.is_private,
                accountType: su.account_type || null,
                hasHighlights: !!su.has_highlight_reels,
                friendship: fs ? {
                  following: !!fs.following, followedBy: !!fs.followed_by,
                  isBestie: !!fs.is_bestie, muting: !!fs.muting,
                  blocking: !!fs.blocking, restricted: !!fs.is_restricted,
                } : null,
                lastActiveAt: ls && ls.timestamp ? Math.round(Number(ls.timestamp) / 1000) : null,
              } : null;
              out.push({
                threadId: t.thread_id,
                threadTitle: t.thread_title || null,
                itemId: it.item_id,
                from: (su && su.username) || (sid === viewerId ? "(self)" : sid),
                fromId: sid,
                fromSelf: !!it.is_sent_by_viewer || sid === viewerId,
                type, text, media,
                timestamp: Math.round((it.timestamp || 0) / 1000),
                sender,
              });
            }
          }
          return out;
        }, limit);

        items.sort((a, b) => a.timestamp - b.timestamp);
        for (const msg of items) {
          if (this._msgSeen.has(msg.itemId)) continue;
          this._msgSeen.add(msg.itemId);
          if (!seeded && !emitExisting) continue;          // seed silently on first poll
          if (msg.fromSelf && !includeSelf) continue;
          if (enrichSender && msg.sender && !msg.fromSelf) {
            await this._enrichSender(msg.sender, msg.fromId).catch(() => {});
          }
          this.emit("messageReceived", msg);
        }
        seeded = true;
      } catch (_) { /* transient (navigation / network) — retry next tick */ }
      finally { this._msgPolling = false; }
    };

    await poll();                          // seed the "seen" set
    this._msgTimer = setInterval(poll, interval);
    this.emit("messageListenerStarted", { interval });
    return this;
  },

  /**
   * Augment a `sender` object (from the message listener) with profile stats and
   * live story status — bio, followers, following, posts, externalUrl,
   * hasActiveStory, storyCount. Mutates `sender` in place. @private
   */
  async _enrichSender(sender, userId) {
    const page = this._msgPage || this.page;
    const extra = await page.evaluate(async ({ uname, uid }) => {
      const APP = "936619743392459";
      const r = {};
      // Profile stats (bio, follower/following/post counts, external url).
      try {
        const rp = await fetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(uname)}`,
          { headers: { "x-ig-app-id": APP }, credentials: "include" });
        if (rp.ok) {
          const j = await rp.json();
          const u = j.data && j.data.user;
          if (u) {
            r.bio = u.biography || "";
            r.followers = u.edge_followed_by ? u.edge_followed_by.count : null;
            r.following = u.edge_follow ? u.edge_follow.count : null;
            r.posts = u.edge_owner_to_timeline_media ? u.edge_owner_to_timeline_media.count : null;
            r.externalUrl = u.external_url || null;
          }
        }
      } catch (_) {}
      // Live story status.
      try {
        const rs = await fetch(`/api/v1/feed/reels_media/?reel_ids=${uid}`,
          { headers: { "x-ig-app-id": APP }, credentials: "include" });
        if (rs.ok) {
          const js = await rs.json();
          const reel = js.reels && js.reels[uid];
          const count = reel ? (reel.media_count || (reel.items ? reel.items.length : 0)) : 0;
          r.hasActiveStory = count > 0;
          r.storyCount = count;
        } else { r.hasActiveStory = false; r.storyCount = 0; }
      } catch (_) {}
      return r;
    }, { uname: sender.username, uid: String(userId) });
    Object.assign(sender, extra);
    return sender;
  },

  /** Stop the DM message listener and close its background tab. */
  async stopMessageListener() {
    if (this._msgTimer) { clearInterval(this._msgTimer); this._msgTimer = null; }
    if (this._msgPage) { await this._msgPage.close().catch(() => {}); this._msgPage = null; }
    this._msgPolling = false;
    this.emit("messageListenerStopped");
  }
};
