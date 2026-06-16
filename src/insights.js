"use strict";

const fs = require("fs");
const { delay } = require("./utils");

/**
 * Read-only insights: profiles, posts, reels, comments, social graph, search,
 * inbox and reel media download.
 * Mixed into InstagramBot.prototype.
 */
module.exports = {
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
  },

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
  },

  /** Convenience: get the bot's own profile stats (uses configured username). */
  async getMyStats() {
    if (!this.username) {
      throw new Error("No `username` configured on the bot instance");
    }
    return await this.getProfile(this.username);
  },

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
  },

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
  },

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
  },

  /**
   * Get enriched stats for a Reel (or any post): thumbnail (cover frame),
   * play/view count, likes, comments, caption, author, and the raw video src
   * when present. The thumbnail is suitable for multimodal analysis.
   * @param {string} postUrl - reel/post URL or shortcode
   */
  async getReelStats(postUrl) {
    this._ensureReady();
    const url = postUrl.startsWith("http")
      ? postUrl
      : `https://www.instagram.com/reel/${postUrl}/`;

    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await delay(3500);

    const data = await this.page.evaluate(() => {
      const out = {};
      const meta = (p) => {
        const el = document.querySelector(`meta[property="${p}"]`);
        return el ? el.getAttribute("content") : null;
      };
      out._ogImage = meta("og:image");
      out._ogDesc = meta("og:description");

      const video = document.querySelector("video");
      const source = video ? video.querySelector("source") : null;
      out._videoSrc = video ? (video.getAttribute("src") || (source && source.src) || null) : null;
      out._poster = video ? video.getAttribute("poster") : null;

      const article = document.querySelector("article") || document.body;
      const text = article.innerText || "";

      const playMatch = text.match(/([\d.,]+\s*[kmKMbB]?)\s*(views|plays|izlenme|g[öo]r[üu]nt[üu]lenme|g[öo]sterim|oynat)/i);
      out._playsRaw = playMatch ? playMatch[1] : null;

      const likeMatch = text.match(/([\d.,]+\s*[kmKMbB]?)\s*(likes|be[ğg]eni|be[ğg]endi|like)/i);
      out._likesRaw = likeMatch ? likeMatch[1] : null;

      const cMatch = text.match(/View all\s*([\d.,]+\s*[kmKMbB]?)\s*comments/i)
                  || text.match(/([\d.,]+\s*[kmKMbB]?)\s*yorum/i);
      out._commentsRaw = cMatch ? cMatch[1] : null;

      const timeEl = article.querySelector("time");
      out._time = timeEl ? (timeEl.getAttribute("datetime") || timeEl.innerText) : null;

      const authorEl = article.querySelector('header a[href^="/"]')
                    || document.querySelector('a[href^="/"][role="link"]');
      out._author = authorEl ? authorEl.getAttribute("href").replace(/\//g, "") : null;

      return out;
    });

    return {
      postUrl: url,
      author: data._author,
      caption: data._ogDesc,
      thumbnail: data._ogImage || data._poster,
      videoSrc: data._videoSrc,
      plays: this._parseCount(data._playsRaw),
      likes: this._parseCount(data._likesRaw),
      comments: this._parseCount(data._commentsRaw),
      publishedAt: data._time,
      timestamp: new Date().toISOString(),
    };
  },

  /**
   * Best-effort download of a Reel's video file to `destPath`. Instagram serves
   * reels via MSE/blob + ranged CDN, so success is not guaranteed; tries the
   * <video> currentSrc, then the largest captured .mp4 network response.
   * @param {string} postUrl
   * @param {string} destPath
   */
  async downloadReel(postUrl, destPath) {
    this._ensureReady();
    const url = postUrl.startsWith("http") ? postUrl : `https://www.instagram.com/reel/${postUrl}/`;
    const seen = [];
    const onResp = (resp) => {
      try {
        const u = resp.url();
        const ct = resp.headers()["content-type"] || "";
        if (/\.mp4/i.test(u) || ct.includes("video/mp4")) {
          seen.push({ url: u, len: Number(resp.headers()["content-length"] || 0) });
        }
      } catch {}
    };
    this.page.on("response", onResp);
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await delay(2500);
      await this.page.evaluate(() => {
        const v = document.querySelector("video");
        if (v) { v.muted = true; const p = v.play && v.play(); if (p && p.catch) p.catch(() => {}); }
      });
      await delay(4000);
    } finally {
      this.page.off("response", onResp);
    }

    const tryFetch = async (u) => {
      if (!u || u.startsWith("blob:")) return null;
      const arr = await this.page.evaluate(async (link) => {
        try { const r = await fetch(link); const b = await r.arrayBuffer(); return Array.from(new Uint8Array(b)); }
        catch { return null; }
      }, u);
      return arr && arr.length > 10000 ? Buffer.from(arr) : null;
    };

    const ogVideo = await this.page.evaluate(() => {
      const m = document.querySelector('meta[property="og:video"], meta[property="og:video:secure_url"]');
      return m ? m.getAttribute("content") : "";
    });
    let srcUrl = await this.page.evaluate(() => {
      const v = document.querySelector("video");
      return v ? (v.currentSrc || v.src || "") : "";
    });
    // og:video is a full progressive mp4 (most reliable). currentSrc is often a
    // blob/MSE stream and captured .mp4 responses are fragmented segments.
    let buf = await tryFetch(ogVideo);
    if (buf) srcUrl = ogVideo;
    if (!buf) buf = await tryFetch(srcUrl);
    if (!buf) {
      seen.sort((a, b) => b.len - a.len);
      for (const c of seen) { buf = await tryFetch(c.url); if (buf) { srcUrl = c.url; break; } }
    }
    if (!buf) throw new Error("Reel videosu indirilemedi (blob/CDN korumalı).");
    fs.writeFileSync(destPath, buf);
    return { path: destPath, url: srcUrl, bytes: buf.length };
  },

  /** Return current session cookies (Playwright format) — e.g. to export for yt-dlp. */
  async getCookies() {
    this._ensureReady();
    return this.context.cookies();
  },

  /**
   * Scrape the real Reels feed (instagram.com/reels/) by advancing through it and
   * collecting reel shortcodes. Returns [{ shortcode, type:'reel', url }].
   * @param {number} count
   */
  async getReelsFeed(count = 12) {
    this._ensureReady();
    await this.page.goto("https://www.instagram.com/reels/", { waitUntil: "domcontentloaded" });
    await delay(5000);
    // Focus the feed so ArrowDown advances reels.
    try {
      const vp = this.page.viewportSize() || { width: 1280, height: 720 };
      await this.page.mouse.click(Math.round(vp.width / 2), Math.round(vp.height / 2));
    } catch (_) { /* ignore */ }

    const found = new Set();
    let noNew = 0;
    const maxIter = count * 3 + 8;
    for (let i = 0; i < maxIter && found.size < count && noNew < 12; i++) {
      const codes = await this.page.evaluate(() => {
        const out = [];
        // Matches both /reel/<code> and /reels/<code> (current feed URL); codes are 8+ chars.
        const push = (s) => {
          const m = (s || "").match(/\/reels?\/([A-Za-z0-9_-]{8,})/);
          if (m && m[1].toLowerCase() !== "audio") out.push(m[1]);
        };
        push(location.pathname);
        document.querySelectorAll('a[href*="/reel/"]').forEach((a) => push(a.getAttribute("href")));
        return out;
      });
      const before = found.size;
      codes.forEach((c) => c && found.add(c));
      noNew = found.size === before ? noNew + 1 : 0;
      if (found.size >= count) break;
      await this.page.keyboard.press("ArrowDown").catch(() => {});
      await this.page.mouse.wheel(0, 1200).catch(() => {});
      await delay(2800);
    }

    return Array.from(found).slice(0, count).map((code) => ({
      shortcode: code,
      type: "reel",
      url: `https://www.instagram.com/reel/${code}/`,
    }));
  },

  /**
   * Get a list of followers for a given user. Requires the account to be public
   * (or the bot to be following it).
   * @param {string} username
   * @param {number} count - Maximum entries to collect
   */
  async getFollowers(username, count = 50) {
    return await this._scrapeFollowList(username, "followers", count);
  },

  /** Get a list of accounts the user follows. */
  async getFollowing(username, count = 50) {
    return await this._scrapeFollowList(username, "following", count);
  },

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
  },

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
  },

  /** Backwards-compat alias used in the plan API. */
  async searchUsers(query) {
    const res = await this.search(query);
    return res.users;
  },

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
  },

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
  },

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
};
