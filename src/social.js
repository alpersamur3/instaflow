"use strict";

const { delay } = require("./utils");

// ── Shared browser-side trimmers ────────────────────────────────────────────
// Injected into page.evaluate() (and eval'd there) so the message listener,
// getMessages and getInbox all normalize Instagram direct items the same way.
// RAW_TRIM is a named function expression so it can recurse into quoted
// (replied_to_message) items.
const RAW_TRIM = `function __trim(it){
  if(!it) return null;
  return {
    itemType: it.item_type,
    itemId: it.item_id,
    userId: String(it.user_id),
    ts: it.timestamp,
    text: it.text || null,
    sentByViewer: !!it.is_sent_by_viewer,
    clipCode: (it.clip && it.clip.clip && it.clip.clip.code) || null,
    reelShareCode: (it.reel_share && it.reel_share.media && it.reel_share.media.code) || null,
    reelShareText: (it.reel_share && it.reel_share.text) || null,
    mediaShareCode: (it.media_share && it.media_share.code) || null,
    replied: it.replied_to_message ? __trim(it.replied_to_message) : null
  };
}`;

const USER_TRIM = `function __utrim(u){
  return {
    pk: String(u.pk), username: u.username, full_name: u.full_name || null,
    profile_pic_url: u.profile_pic_url || null, is_verified: !!u.is_verified,
    is_private: !!u.is_private, account_type: u.account_type || null,
    has_highlight_reels: !!u.has_highlight_reels, friendship_status: u.friendship_status || null
  };
}`;

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
   * React to a specific DM message with an emoji (❤️ 😂 😮 😢 😡 👍 are the quick
   * reactions; others are best-effort via the picker). Instagram Web sends DM
   * reactions over its realtime channel, not a REST endpoint, so this drives the
   * thread UI: hover the message → "React" → pick the emoji.
   *
   * @param {string} threadId - thread id (from getInbox/getMessages or a message's `threadId`)
   * @param {string|object} [target] - the message TEXT to react to, a `{ text }`
   *   object, or a `messageReceived` message (its `text` is used). Omit / pass
   *   nothing to react to the last incoming text message in the thread.
   * @param {string} [emoji="❤️"]
   * @returns {Promise<{success:boolean,threadId:string,emoji:string,message:string,timestamp:string}>}
   */
  async reactToMessage(threadId, target, emoji = "❤️") {
    this._ensureReady();
    if (typeof emoji !== "string" || !emoji) emoji = "❤️";

    // Resolve the text of the message to react to.
    let text = null;
    if (typeof target === "string") text = target;
    else if (target && typeof target === "object" && target.text) text = target.text;
    if (!text) {
      const m = await this.getMessages(threadId, 5);
      const rev = [...m.messages].reverse();
      const pick = rev.find(x => !x.fromSelf && x.text) || rev.find(x => x.text);
      if (!pick) throw new Error("reactToMessage: no text message to react to — pass the message text explicitly (media-only messages aren't supported).");
      text = pick.text;
    }

    try {
      await this.page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: "domcontentloaded" });
      await delay(4000);
      await this._dismissDialogs();

      // Hover the message bubble to reveal its action controls.
      const bubble = this.page.getByText(text, { exact: false }).last();
      if (!(await bubble.count() > 0)) {
        throw new Error(`reactToMessage: message containing "${text.slice(0, 30)}" not found in thread ${threadId}`);
      }
      await bubble.scrollIntoViewIfNeeded().catch(() => {});
      await bubble.hover();
      await delay(900);

      // Click "React to message …".
      const reactBtn = this.page.locator(
        '[aria-label^="React to message"], [aria-label*="React to message" i], ' +
        '[aria-label*="tepki ver" i], div[role="button"][aria-label*="react" i]'
      ).first();
      await reactBtn.waitFor({ state: "visible", timeout: 8000 });
      await reactBtn.click({ force: true });
      await delay(900);

      // Pick the emoji from the quick bar; fall back to the full picker.
      let reacted = false;
      const quick = this.page.locator(`[role="button"]:has-text("${emoji}"), button:has-text("${emoji}")`).first();
      if (await quick.count() > 0 && await quick.isVisible().catch(() => false)) {
        await quick.click({ force: true });
        reacted = true;
      } else {
        const more = this.page.locator('[aria-label*="more" i][role="button"], [aria-label="Choose an emoji"], div[role="button"]:has-text("+")').first();
        if (await more.count() > 0) { await more.click({ force: true }).catch(() => {}); await delay(800); }
        const any = this.page.locator(`[role="button"]:has-text("${emoji}"), button:has-text("${emoji}")`).first();
        if (await any.count() > 0 && await any.isVisible().catch(() => false)) { await any.click({ force: true }); reacted = true; }
      }
      if (!reacted) throw new Error(`reactToMessage: could not select emoji ${emoji} (not in the quick bar).`);
      await delay(1500);

      const result = { success: true, threadId, emoji, message: text.slice(0, 60), timestamp: new Date().toISOString() };
      this.emit("messageReacted", result);
      return result;
    } catch (err) {
      this.emit("messageReactFailed", { threadId, error: err.message });
      throw err;
    }
  },

  /** Build the public `sender` object from a trimmed inbox user record. @private */
  _buildSender(u, lastSeenMicro) {
    if (!u) return null;
    const fs = u.friendship_status;
    return {
      username: u.username,
      fullName: u.full_name || null,
      avatar: u.profile_pic_url || null,
      isVerified: !!u.is_verified,
      isPrivate: !!u.is_private,
      accountType: u.account_type || null,
      hasHighlights: !!u.has_highlight_reels,
      friendship: fs ? {
        following: !!fs.following, followedBy: !!fs.followed_by,
        isBestie: !!fs.is_bestie, muting: !!fs.muting,
        blocking: !!fs.blocking, restricted: !!fs.is_restricted,
      } : null,
      lastActiveAt: lastSeenMicro ? Math.round(Number(lastSeenMicro) / 1000) : null,
    };
  },

  /**
   * Normalize a trimmed raw direct item into a public message object. Recurses
   * into a quoted/replied item to fill `repliedTo`. @private
   */
  _normalizeItem(raw, umap) {
    if (!raw) return null;
    let type = raw.itemType, text = raw.text, media = null;
    if (raw.clipCode) {
      type = "reel"; media = { type: "reel", shortcode: raw.clipCode, url: `https://www.instagram.com/reel/${raw.clipCode}/` };
    } else if (raw.reelShareCode) {
      type = "reel"; text = raw.reelShareText || text;
      media = { type: "reel", shortcode: raw.reelShareCode, url: `https://www.instagram.com/reel/${raw.reelShareCode}/` };
    } else if (raw.mediaShareCode) {
      type = "post"; media = { type: "post", shortcode: raw.mediaShareCode, url: `https://www.instagram.com/p/${raw.mediaShareCode}/` };
    }
    const u = umap[raw.userId];
    const tsMs = Math.round((raw.ts || 0) / 1000);
    return {
      itemId: raw.itemId,
      from: (u && u.username) || (raw.sentByViewer ? "(self)" : raw.userId),
      fromId: raw.userId,
      fromSelf: !!raw.sentByViewer,
      type, text, media,
      repliedTo: raw.replied ? this._normalizeItem(raw.replied, umap) : null,
      timestamp: tsMs,
      sentAt: tsMs ? new Date(tsMs).toISOString() : null,
    };
  },

  /** Fetch inbox thread summaries (for activity detection + getInbox previews). @private */
  async _fetchInboxSummary(page, limit) {
    return page.evaluate(async ({ lim, trimSrc, utrimSrc }) => {
      const __trim = eval("(" + trimSrc + ")");
      const __utrim = eval("(" + utrimSrc + ")");
      const r = await fetch(`/api/v1/direct_v2/inbox/?persistentBadging=true&limit=${lim}`,
        { headers: { "x-ig-app-id": "936619743392459" }, credentials: "include" });
      if (!r.ok) return [];
      const j = await r.json();
      return ((j.inbox && j.inbox.threads) || []).map(t => ({
        threadId: t.thread_id,
        threadTitle: t.thread_title || null,
        users: (t.users || []).map(__utrim),
        lastSeenAt: t.last_seen_at || {},
        latestItemId: (t.items && t.items[0] && t.items[0].item_id) || null,
        latestItem: (t.items && t.items[0]) ? __trim(t.items[0]) : null,
      }));
    }, { lim: limit, trimSrc: RAW_TRIM, utrimSrc: USER_TRIM });
  },

  /** Fetch a thread's full message history (trimmed raw items + users). @private */
  async _fetchThreadRaw(page, threadId, limit) {
    return page.evaluate(async ({ tid, lim, trimSrc, utrimSrc }) => {
      const __trim = eval("(" + trimSrc + ")");
      const __utrim = eval("(" + utrimSrc + ")");
      const r = await fetch(`/api/v1/direct_v2/threads/${encodeURIComponent(tid)}/?limit=${lim}`,
        { headers: { "x-ig-app-id": "936619743392459" }, credentials: "include" });
      if (!r.ok) return null;
      const j = await r.json();
      const th = j.thread;
      if (!th) return null;
      return {
        users: (th.users || []).map(__utrim),
        lastSeenAt: th.last_seen_at || {},
        rawItems: (th.items || []).map(__trim),
      };
    }, { tid: threadId, lim: limit, trimSrc: RAW_TRIM, utrimSrc: USER_TRIM });
  },

  /**
   * Start polling the DM inbox and emit events for new messages. Burst-safe: the
   * inbox only previews ~2 items/thread, so when a thread shows new activity the
   * full thread is fetched and **every** new message is processed (none dropped).
   *
   * Two events fire per poll:
   *   - `messageReceived` — once per new message (in order)
   *   - `userMessages`     — once per thread/person, with all of that thread's new
   *                          messages batched: { threadId, threadTitle, from,
   *                          fromId, sender, messages:[…] }
   *
   * Each message is normalized:
   *   { threadId, threadTitle, itemId, from, fromId, fromSelf, type, text, media,
   *     repliedTo, timestamp, sentAt, sender }
   * `media` (shared reels/posts) → { type, shortcode, url } (pass to analyzeReel);
   * `repliedTo` is the quoted message (same shape) or null; `sentAt` is an ISO
   * date-time; `sender` is the cheap profile (+bio/followers/story with
   * `enrichSender`).
   *
   * @param {object} [options]
   * @param {number}  [options.interval=6000]      - poll period (ms)
   * @param {number}  [options.limit=20]           - threads to scan per poll
   * @param {number}  [options.threadLimit=25]     - messages fetched per active thread
   * @param {boolean} [options.includeSelf=false]  - also emit your own messages
   * @param {boolean} [options.emitExisting=false] - emit the current backlog on start
   * @param {boolean} [options.enrichSender=false] - add bio/followers/story to sender
   */
  async startMessageListener(options = {}) {
    this._ensureReady();
    if (this._msgTimer) return this; // already running

    const interval = options.interval || 6000;
    const limit = options.limit || 20;
    const threadLimit = options.threadLimit || 25;
    const includeSelf = !!options.includeSelf;
    const emitExisting = !!options.emitExisting;
    const enrichSender = !!options.enrichSender;

    this._msgSeen = new Set();
    this._threadLatest = {};
    this._msgSinceTs = emitExisting ? 0 : Date.now();
    this._msgPage = await this.context.newPage();
    await this._msgPage.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" }).catch(() => {});

    let seeded = false;
    const poll = async () => {
      if (this._msgPolling || !this._msgPage) return;
      this._msgPolling = true;
      try {
        const summaries = await this._fetchInboxSummary(this._msgPage, limit);

        // First poll with default options: remember each thread's latest item so
        // only genuinely new activity triggers a (deep) fetch — no startup storm.
        if (!seeded && !emitExisting) {
          for (const s of summaries) if (s.latestItemId) this._threadLatest[s.threadId] = s.latestItemId;
          this._msgSinceTs = Date.now();
          seeded = true;
          return;
        }
        seeded = true;

        for (const s of summaries) {
          if (!s.latestItemId) continue;
          if (this._threadLatest[s.threadId] === s.latestItemId) continue; // no change
          this._threadLatest[s.threadId] = s.latestItemId;

          // New activity → fetch the full thread so no burst message is missed.
          const raw = await this._fetchThreadRaw(this._msgPage, s.threadId, threadLimit);
          if (!raw) continue;
          const umap = {};
          raw.users.forEach(u => { umap[u.pk] = u; });

          const newMsgs = [];
          for (const ri of raw.rawItems) {
            if (this._msgSeen.has(ri.itemId)) continue;
            this._msgSeen.add(ri.itemId);
            const tsMs = Math.round((ri.ts || 0) / 1000);
            if (!emitExisting && tsMs <= this._msgSinceTs) continue; // pre-start history
            const msg = this._normalizeItem(ri, umap);
            msg.threadId = s.threadId;
            msg.threadTitle = s.threadTitle;
            const ls = raw.lastSeenAt[ri.userId];
            msg.sender = umap[ri.userId] ? this._buildSender(umap[ri.userId], ls && ls.timestamp) : null;
            if (msg.fromSelf && !includeSelf) continue;
            newMsgs.push(msg);
          }
          if (!newMsgs.length) continue;
          newMsgs.sort((a, b) => a.timestamp - b.timestamp);

          if (enrichSender) {
            const seen = {};
            for (const m of newMsgs) {
              if (!m.sender || seen[m.fromId]) continue;
              await this._enrichSender(m.sender, m.fromId).catch(() => {});
              seen[m.fromId] = m.sender;
            }
            // share the enriched object with same-sender messages in this batch
            for (const m of newMsgs) if (m.sender && seen[m.fromId]) Object.assign(m.sender, seen[m.fromId]);
          }

          for (const m of newMsgs) this.emit("messageReceived", m);

          const primary = (raw.users || []).find(u => String(u.pk) === String(newMsgs[0].fromId)) || raw.users[0];
          const pls = primary && raw.lastSeenAt[primary.pk];
          this.emit("userMessages", {
            threadId: s.threadId,
            threadTitle: s.threadTitle,
            from: primary ? primary.username : s.threadTitle,
            fromId: primary ? primary.pk : (newMsgs[0] && newMsgs[0].fromId),
            sender: primary ? this._buildSender(primary, pls && pls.timestamp) : (newMsgs[0] && newMsgs[0].sender),
            messages: newMsgs,
          });
        }
      } catch (_) { /* transient (navigation / network) — retry next tick */ }
      finally { this._msgPolling = false; }
    };

    await poll();                          // seed (or emit backlog with emitExisting)
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
  },

  /** Normalize a raw activity-inbox story into a public notification object. @private */
  _normalizeNotification(s) {
    const a = (s && s.args) || {};
    const text = a.text || "";
    if (!text && !a.profile_name) return null;
    let kind = "other";
    if (/mentioned you/i.test(text) || /bir yorumda senden bahsetti|yorumda bahsetti/i.test(text)) kind = "mention";
    else if (/commented|replied|yorum yaptı|yanıtladı/i.test(text)) kind = "comment";
    else if (/liked|beğendi/i.test(text)) kind = "like";
    else if (/started following|followed you|seni takip etmeye başladı|takip etti/i.test(text)) kind = "follow";
    else if (/tagged you|seni etiketledi|bir gönderide etiketledi/i.test(text)) kind = "tag";

    // Related media → post url. First from a media id (possibly "mediaid_userid"),
    // else by scanning the args for an embedded /p/ or /reel/ permalink.
    let media = null;
    const mid = a.media && (a.media.id || a.media.pk);
    if (mid) {
      const code = this._mediaIdToShortcode(mid);
      media = { id: String(mid).split("_")[0], shortcode: code, url: code ? `https://www.instagram.com/p/${code}/` : null };
    }
    if (!media) {
      const blob = JSON.stringify(a);
      const pm = blob.match(/\/(p|reel|reels)\/([A-Za-z0-9_-]{5,})/);
      if (pm) media = { id: null, shortcode: pm[2], url: `https://www.instagram.com/${pm[1] === "p" ? "p" : "reel"}/${pm[2]}/` };
    }
    const tsMs = Math.round((a.timestamp || 0) * 1000);
    return {
      id: s.pk || a.aytm_notif_id || `${a.profile_id || "x"}_${a.timestamp || ""}`,
      kind,
      type: s.type,
      storyType: s.story_type,
      from: a.profile_name || null,
      fromId: a.profile_id || null,
      text,
      media,
      timestamp: tsMs,
      sentAt: tsMs ? new Date(tsMs).toISOString() : null,
    };
  },

  /**
   * Watch the activity/notifications feed and emit events for new ones — most
   * usefully when someone **@mentions you in a comment**. Each poll opens the
   * notifications page (which loads the data over an authenticated GraphQL call)
   * and parses the captured response.
   *
   * Emits:
   *   - `notification` — for every new notification (any kind)
   *   - `mentioned`    — only comment mentions / @-tags (a subset), with the
   *                      related post in `media` (pass to analyzePost/analyzeReel)
   *
   * Each payload: { id, kind, type, storyType, from, fromId, text, media, timestamp, sentAt }
   * where `kind` is 'mention' | 'comment' | 'like' | 'follow' | 'tag' | 'other'
   * and `media` (when present) is { id, shortcode, url }.
   *
   * @param {object} [options]
   * @param {number}  [options.interval=20000]     - poll period (ms)
   * @param {boolean} [options.emitExisting=false] - emit the current backlog on start
   * @param {boolean} [options.mentionsOnly=false] - skip non-mention notifications entirely
   */
  async startMentionListener(options = {}) {
    this._ensureReady();
    if (this._notifTimer) return this;

    const interval = options.interval || 20000;
    const emitExisting = !!options.emitExisting;
    const mentionsOnly = !!options.mentionsOnly;

    this._notifSeen = new Set();
    this._notifSinceTs = emitExisting ? 0 : Date.now();
    this._notifPage = await this.context.newPage();

    let seeded = false;
    const poll = async () => {
      if (this._notifPolling || !this._notifPage) return;
      this._notifPolling = true;
      try {
        // Capture the activity-inbox GraphQL response that the page itself fires.
        let captured = null;
        const onResp = async (resp) => {
          try {
            if (!/graphql\/query/.test(resp.url())) return;
            const b = await resp.text();
            if (b.includes("xdt_activity_inbox")) captured = b;
          } catch (_) {}
        };
        this._notifPage.on("response", onResp);
        await this._notifPage.goto("https://www.instagram.com/notifications/", { waitUntil: "domcontentloaded" }).catch(() => {});
        for (let i = 0; i < 12 && !captured; i++) await delay(700);
        this._notifPage.off("response", onResp);
        if (!captured) return;

        let j; try { j = JSON.parse(captured); } catch (_) { return; }
        const inbox = j.data && j.data.xdt_activity_inbox;
        if (!inbox) return;
        const stories = [...(inbox.new_stories || []), ...(inbox.old_stories || [])];
        const notifs = stories.map(s => this._normalizeNotification(s)).filter(Boolean);
        notifs.sort((a, b) => a.timestamp - b.timestamp);

        for (const nt of notifs) {
          if (this._notifSeen.has(nt.id)) continue;
          this._notifSeen.add(nt.id);
          if (!seeded && !emitExisting) continue;
          if (!emitExisting && nt.timestamp <= this._notifSinceTs) continue;
          const isMention = nt.kind === "mention" || nt.kind === "comment" || nt.kind === "tag";
          if (mentionsOnly && !isMention) continue;
          this.emit("notification", nt);
          if (isMention) this.emit("mentioned", nt);
        }
        seeded = true;
      } catch (_) { /* transient — retry next tick */ }
      finally { this._notifPolling = false; }
    };

    await poll();                          // seed (or emit backlog)
    this._notifTimer = setInterval(poll, interval);
    this.emit("mentionListenerStarted", { interval });
    return this;
  },

  /** Stop the mention/notification listener and close its background tab. */
  async stopMentionListener() {
    if (this._notifTimer) { clearInterval(this._notifTimer); this._notifTimer = null; }
    if (this._notifPage) { await this._notifPage.close().catch(() => {}); this._notifPage = null; }
    this._notifPolling = false;
    this.emit("mentionListenerStopped");
  }
};
