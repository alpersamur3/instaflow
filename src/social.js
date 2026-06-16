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
};
