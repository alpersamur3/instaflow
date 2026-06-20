"use strict";

const fs = require("fs");
const path = require("path");
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

      // ── Primary: Instagram's web_profile_info JSON API ──────────────────────
      // Authoritative and stable (real biography, full_name and exact counts) —
      // far more reliable than scraping the rendered header, which can pick up
      // the "Notes" bubble or only the @handle. We're already on the
      // instagram.com origin, so the fetch is same-origin and uses our cookies.
      const api = await this.page.evaluate(async (handle) => {
        try {
          const r = await fetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`, {
            headers: { "x-ig-app-id": "936619743392459" },
            credentials: "include",
          });
          if (!r.ok) return null;
          const j = await r.json();
          const u = j && j.data && j.data.user;
          if (!u) return null;
          return {
            fullName: u.full_name || null,
            bio: u.biography || "",
            isPrivate: !!u.is_private,
            isVerified: !!u.is_verified,
            followers: u.edge_followed_by ? u.edge_followed_by.count : null,
            following: u.edge_follow ? u.edge_follow.count : null,
            posts: u.edge_owner_to_timeline_media ? u.edge_owner_to_timeline_media.count : null,
            avatarUrl: u.profile_pic_url_hd || u.profile_pic_url || null,
            externalUrl: u.external_url || null,
          };
        } catch (_) { return null; }
      }, normalizedUser).catch(() => null);

      if (api && (api.followers != null || api.fullName)) {
        return { username: normalizedUser, ...api, profileUrl: url, timestamp: new Date().toISOString() };
      }

      // ── Fallback: scrape the rendered DOM + meta tags ───────────────────────
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

      // Full name: prefer the og:title ("Full Name (@handle) • Instagram ..."),
      // then the DOM heading. The DOM heading is often just the @handle, so it's
      // the last resort.
      let fullName = null;
      if (data._metaTitle) {
        const t = data._metaTitle.split(/\s*\(@/)[0].trim();
        if (t && !/instagram/i.test(t)) fullName = t;
      }
      if (!fullName) fullName = data._fullName;

      // Bio: best-effort DOM scrape (strip the name + counts lines).
      let bio = (data._bioText || "").replace(data._fullName || "", "").trim();
      bio = bio.split("\n").filter(l => !/follow|takip|post|gönderi/i.test(l)).join("\n").trim();

      return {
        username: normalizedUser,
        fullName,
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

  /** Decode an Instagram shortcode (e.g. "DZy5HnRIlWY") into its numeric media id. */
  _shortcodeToMediaId(shortcode) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = 0n;
    for (const ch of shortcode) {
      const v = A.indexOf(ch);
      if (v < 0) return null;
      id = id * 64n + BigInt(v);
    }
    return id.toString();
  },

  /** Encode a numeric media id (or "mediaid_userid") back into its shortcode. */
  _mediaIdToShortcode(id) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let n;
    try { n = BigInt(String(id).split("_")[0]); } catch (_) { return null; }
    if (n <= 0n) return null;
    let s = "";
    while (n > 0n) { s = A[Number(n % 64n)] + s; n = n / 64n; }
    return s;
  },

  /**
   * Full analysis of a reel for downstream/AI processing: downloads the video and
   * returns the caption, engagement counts and a sample of real comments. Uses
   * Instagram's media info/comments JSON APIs (reliable) rather than DOM scraping.
   *
   * Designed to be driven by an incoming DM — pass the message object emitted by
   * `messageReceived` (with a shared reel) directly, or a reel URL / shortcode.
   *
   * @param {string|object} input - reel URL, shortcode, or a `messageReceived`
   *   message object whose `media` is a shared reel.
   * @param {object} [options]
   * @param {boolean} [options.download=true]  - also download the .mp4
   * @param {string}  [options.downloadDir="."] - directory for the downloaded file
   * @param {string}  [options.downloadPath]    - explicit output path (overrides dir)
   * @param {number}  [options.commentCount=12] - how many comments to sample
   * @returns {Promise<object>} { url, shortcode, author, caption, likes, comments,
   *   plays, durationSec, publishedAt, thumbnail, videoUrl, sampleComments, download }
   */
  async analyzeReel(input, options = {}) {
    this._ensureReady();
    const { download = true, downloadDir = ".", downloadPath, commentCount = 12 } = options;

    // Accept a URL/shortcode string, or a messageReceived object carrying a reel.
    let url;
    if (typeof input === "string") {
      url = input.startsWith("http") ? input : `https://www.instagram.com/reel/${input}/`;
    } else if (input && input.media && input.media.url) {
      url = input.media.url;
    } else if (input && input.url) {
      url = input.url;
    } else {
      throw new Error("analyzeReel: expected a reel URL/shortcode or a message containing a shared reel");
    }

    const m = url.match(/\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
    const shortcode = m ? m[2] : (typeof input === "string" && !input.includes("/") ? input : null);
    if (!shortcode) throw new Error("analyzeReel: could not extract a shortcode from " + url);
    const mediaId = this._shortcodeToMediaId(shortcode);

    // The media APIs are same-origin — make sure we're on instagram.com.
    if (!this.page.url().includes("instagram.com")) {
      await this.page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
      await delay(1500);
    }

    const data = await this.page.evaluate(async ({ mid, n }) => {
      const APP_ID = "936619743392459";
      const out = { info: null, comments: [] };
      try {
        const r = await fetch(`/api/v1/media/${mid}/info/`, { headers: { "x-ig-app-id": APP_ID }, credentials: "include" });
        if (r.ok) {
          const j = await r.json();
          const md = j.items && j.items[0];
          if (md) out.info = {
            author: md.user && md.user.username,
            fullName: md.user && md.user.full_name,
            likes: md.like_count,
            comments: md.comment_count,
            plays: md.play_count || md.ig_play_count || md.view_count || null,
            caption: (md.caption && md.caption.text) || "",
            takenAt: md.taken_at,
            durationSec: md.video_duration || null,
            thumbnail: md.image_versions2 && md.image_versions2.candidates && md.image_versions2.candidates[0] && md.image_versions2.candidates[0].url,
            videoUrl: md.video_versions && md.video_versions[0] && md.video_versions[0].url,
          };
        }
      } catch (_) {}
      try {
        const rc = await fetch(`/api/v1/media/${mid}/comments/?can_support_threading=true&permalink_enabled=false`, { headers: { "x-ig-app-id": APP_ID }, credentials: "include" });
        if (rc.ok) {
          const jc = await rc.json();
          out.comments = (jc.comments || []).slice(0, n).map(c => ({
            username: c.user && c.user.username,
            text: c.text,
            likes: c.comment_like_count || 0,
            createdAt: c.created_at,
          }));
        }
      } catch (_) {}
      return out;
    }, { mid: mediaId, n: commentCount });

    if (!data.info) {
      throw new Error(`analyzeReel: could not load media info for ${shortcode} (private, removed, or not a reel?)`);
    }

    // Download the .mp4 using the progressive URL from the info API (most
    // reliable); fall back to the best-effort downloadReel if needed.
    let downloadInfo = null;
    if (download) {
      const dest = downloadPath || path.join(downloadDir, `${shortcode}.mp4`);
      try {
        if (data.info.videoUrl) {
          const arr = await this.page.evaluate(async (link) => {
            try { const r = await fetch(link); const b = await r.arrayBuffer(); return Array.from(new Uint8Array(b)); }
            catch { return null; }
          }, data.info.videoUrl);
          if (arr && arr.length > 10000) {
            fs.writeFileSync(dest, Buffer.from(arr));
            downloadInfo = { path: dest, bytes: arr.length, url: data.info.videoUrl };
          }
        }
        if (!downloadInfo) downloadInfo = await this.downloadReel(url, dest);
      } catch (e) {
        downloadInfo = { error: e.message };
      }
    }

    const result = {
      url,
      shortcode,
      mediaId,
      author: data.info.author,
      fullName: data.info.fullName,
      caption: data.info.caption,
      likes: data.info.likes,
      comments: data.info.comments,
      plays: data.info.plays,
      durationSec: data.info.durationSec,
      publishedAt: data.info.takenAt ? new Date(data.info.takenAt * 1000).toISOString() : null,
      thumbnail: data.info.thumbnail,
      videoUrl: data.info.videoUrl,
      sampleComments: data.comments,
      download: downloadInfo,
      timestamp: new Date().toISOString(),
    };
    this.emit("reelAnalyzed", result);
    return result;
  },

  /** Fetch a CDN url in the page context and write it to `dest`. @private */
  async _fetchToFile(url, dest) {
    if (!url) return null;
    const arr = await this.page.evaluate(async (link) => {
      try { const r = await fetch(link); const b = await r.arrayBuffer(); return Array.from(new Uint8Array(b)); }
      catch { return null; }
    }, url);
    if (arr && arr.length > 1000) {
      fs.writeFileSync(dest, Buffer.from(arr));
      return { path: dest, bytes: arr.length };
    }
    return null;
  },

  /**
   * Full analysis of a feed post for downstream/AI processing — like analyzeReel
   * but for photo posts and **carousels**: downloads every image (and any video)
   * plus the attached **music/audio** when present, and returns the caption,
   * engagement counts and a sample of real comments. Uses Instagram's media
   * info/comments JSON APIs.
   *
   * Accepts a post URL, a shortcode, or a `messageReceived` message object whose
   * `media` is a shared post — so a DM'd post can be handed straight in.
   *
   * @param {string|object} input
   * @param {object} [options]
   * @param {boolean} [options.download=true]      - download images/videos
   * @param {boolean} [options.downloadMusic=true] - also download the audio track
   * @param {string}  [options.downloadDir="."]
   * @param {number}  [options.commentCount=12]
   * @returns {Promise<object>} { url, shortcode, mediaId, author, fullName, caption,
   *   likes, comments, plays, mediaType, isCarousel, publishedAt, music,
   *   items:[{ index, type, url, download }], sampleComments, timestamp }
   */
  async analyzePost(input, options = {}) {
    this._ensureReady();
    const { download = true, downloadMusic = true, downloadDir = ".", commentCount = 12 } = options;

    let url;
    if (typeof input === "string") {
      url = input.startsWith("http") ? input : `https://www.instagram.com/p/${input}/`;
    } else if (input && input.media && input.media.url) {
      url = input.media.url;
    } else if (input && input.url) {
      url = input.url;
    } else {
      throw new Error("analyzePost: expected a post URL/shortcode or a message containing a shared post");
    }

    const m = url.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    const shortcode = m ? m[2] : (typeof input === "string" && !input.includes("/") ? input : null);
    if (!shortcode) throw new Error("analyzePost: could not extract a shortcode from " + url);
    const mediaId = this._shortcodeToMediaId(shortcode);

    if (!this.page.url().includes("instagram.com")) {
      await this.page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
      await delay(1500);
    }

    const data = await this.page.evaluate(async ({ mid, n }) => {
      const APP = "936619743392459";
      const out = { info: null, comments: [] };
      const pickImg = (md) => (md.image_versions2 && md.image_versions2.candidates && md.image_versions2.candidates[0] && md.image_versions2.candidates[0].url) || null;
      const pickVid = (md) => (md.video_versions && md.video_versions[0] && md.video_versions[0].url) || null;
      try {
        const r = await fetch(`/api/v1/media/${mid}/info/`, { headers: { "x-ig-app-id": APP }, credentials: "include" });
        if (r.ok) {
          const j = await r.json();
          const md = j.items && j.items[0];
          if (md) {
            let items = [];
            if (md.carousel_media && md.carousel_media.length) {
              items = md.carousel_media.map(c => ({ type: c.media_type === 2 ? "video" : "image", imageUrl: pickImg(c), videoUrl: c.media_type === 2 ? pickVid(c) : null }));
            } else {
              items = [{ type: md.media_type === 2 ? "video" : "image", imageUrl: pickImg(md), videoUrl: md.media_type === 2 ? pickVid(md) : null }];
            }
            let music = null;
            const mm = md.music_metadata && md.music_metadata.music_info && md.music_metadata.music_info.music_asset_info;
            const cm = md.clips_metadata;
            if (mm) {
              music = { title: mm.title || null, artist: mm.display_artist || null, audioType: md.music_metadata.audio_type || "licensed_music", downloadUrl: mm.progressive_download_url || null };
            } else if (cm && cm.music_info && cm.music_info.music_asset_info) {
              const a = cm.music_info.music_asset_info;
              music = { title: a.title || null, artist: a.display_artist || null, audioType: "clips_music", downloadUrl: a.progressive_download_url || null };
            } else if (cm && cm.original_sound_info) {
              music = { title: cm.original_sound_info.original_audio_title || "Original audio", artist: (cm.original_sound_info.ig_artist && cm.original_sound_info.ig_artist.username) || null, audioType: "original", downloadUrl: cm.original_sound_info.progressive_download_url || null };
            }
            out.info = {
              author: md.user && md.user.username, fullName: md.user && md.user.full_name,
              mediaType: md.media_type, isCarousel: !!(md.carousel_media && md.carousel_media.length),
              likes: md.like_count, comments: md.comment_count, plays: md.play_count || md.ig_play_count || null,
              caption: (md.caption && md.caption.text) || "", takenAt: md.taken_at, items, music,
            };
          }
        }
      } catch (_) {}
      try {
        const rc = await fetch(`/api/v1/media/${mid}/comments/?can_support_threading=true&permalink_enabled=false`, { headers: { "x-ig-app-id": APP }, credentials: "include" });
        if (rc.ok) {
          const jc = await rc.json();
          out.comments = (jc.comments || []).slice(0, n).map(c => ({ username: c.user && c.user.username, text: c.text, likes: c.comment_like_count || 0, createdAt: c.created_at }));
        }
      } catch (_) {}
      return out;
    }, { mid: mediaId, n: commentCount });

    if (!data.info) {
      throw new Error(`analyzePost: could not load media info for ${shortcode} (private, removed, or unavailable?)`);
    }

    // Download every image/video, then the audio track.
    const items = data.info.items.map((it, i) => ({ index: i, type: it.type, url: it.videoUrl || it.imageUrl, _img: it.imageUrl, _vid: it.videoUrl }));
    if (download) {
      for (const it of items) {
        const ext = it.type === "video" ? "mp4" : "jpg";
        const dest = path.join(downloadDir, `${shortcode}_${it.index + 1}.${ext}`);
        try { it.download = await this._fetchToFile(it.url, dest); }
        catch (e) { it.download = { error: e.message }; }
      }
    }
    let music = data.info.music;
    if (music && downloadMusic && music.downloadUrl) {
      const dest = path.join(downloadDir, `${shortcode}_audio.mp4`);
      try { music = { ...music, download: await this._fetchToFile(music.downloadUrl, dest) }; }
      catch (e) { music = { ...music, download: { error: e.message } }; }
    }

    const result = {
      url, shortcode, mediaId,
      author: data.info.author,
      fullName: data.info.fullName,
      caption: data.info.caption,
      likes: data.info.likes,
      comments: data.info.comments,
      plays: data.info.plays,
      mediaType: data.info.mediaType,
      isCarousel: data.info.isCarousel,
      publishedAt: data.info.takenAt ? new Date(data.info.takenAt * 1000).toISOString() : null,
      music,
      items: items.map(it => ({ index: it.index, type: it.type, url: it.url, download: it.download || null })),
      sampleComments: data.comments,
      timestamp: new Date().toISOString(),
    };
    this.emit("postAnalyzed", result);
    return result;
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
   * Read the DM inbox — recent threads, each with its last message (text/type,
   * shared media, `sentAt` date-time and sender).
   * @param {number} count
   * @returns {Promise<{collected:number, threads:Array}>}
   */
  async getInbox(count = 20) {
    this._ensureReady();
    try {
      if (!this.page.url().includes("instagram.com")) {
        await this.page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
        await delay(1000);
      }
      const summaries = await this._fetchInboxSummary(this.page, count);
      const threads = summaries.map(s => {
        const umap = {};
        (s.users || []).forEach(u => { umap[u.pk] = u; });
        let lastMessage = null;
        if (s.latestItem) {
          const m = this._normalizeItem(s.latestItem, umap);
          lastMessage = {
            from: m.from, fromSelf: m.fromSelf, type: m.type, text: m.text,
            media: m.media, repliedTo: m.repliedTo, timestamp: m.timestamp, sentAt: m.sentAt,
          };
        }
        return {
          threadId: s.threadId,
          title: s.threadTitle,
          users: (s.users || []).map(u => u.username),
          url: `https://www.instagram.com/direct/t/${s.threadId}/`,
          lastMessage,
        };
      });
      return { collected: threads.length, threads: threads.slice(0, count) };
    } catch (err) {
      throw err;
    }
  },

  /**
   * Read recent messages in a specific DM thread via the thread API. Each message
   * is fully normalized: { itemId, from, fromId, fromSelf, type, text, media,
   * repliedTo, timestamp, sentAt, sender }.
   * @param {string} threadId - The id from getInbox()
   * @param {number} count
   */
  async getMessages(threadId, count = 30) {
    this._ensureReady();
    try {
      if (!this.page.url().includes("instagram.com")) {
        await this.page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
        await delay(1000);
      }
      const raw = await this._fetchThreadRaw(this.page, threadId, count);
      if (!raw) throw new Error(`Could not load DM thread ${threadId}`);

      const umap = {};
      raw.users.forEach(u => { umap[u.pk] = u; });

      const messages = raw.rawItems
        .map(ri => {
          const m = this._normalizeItem(ri, umap);
          const ls = raw.lastSeenAt[ri.userId];
          m.sender = umap[ri.userId] ? this._buildSender(umap[ri.userId], ls && ls.timestamp) : null;
          return m;
        })
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-count);

      return { threadId, collected: messages.length, messages };
    } catch (err) {
      throw err;
    }
  }
};
