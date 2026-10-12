"use strict";

const { delay } = require("./utils");
const { DIRECT_INBOX_URL: INBOX_URL, LIGHT_PAGE_URL: LIGHT_PAGE } = require("./constants");

// Instagram web serves direct messages through GraphQL; the REST endpoints
// /api/v1/direct_v2/inbox/ and /threads/{id}/ now return 404. Query ids (doc_id)
// and request tokens change with Instagram deploys, so nothing is hard-coded:
// the DM page is opened once, its own requests are captured as templates and
// replayed with fetch from a same-origin page. A failed replay re-learns the
// templates from the page.
const DIRECT_QUERIES = { inbox: "PolarisDirectInboxQuery", thread: "IGDThreadDetailQuery" };
const KEEP_HEADER = /^(x-|content-type$|accept$)/i;
const RELEARN_COOLDOWN_MS = 60000;

async function waitFor(check, ms) {
  for (let waited = 0; !check() && waited < ms; waited += 250) await delay(250);
  return check();
}

function firstDataDoc(text) {
  for (const line of String(text).replace(/^for \(;;\);/, "").split("\n")) {
    try {
      const doc = JSON.parse(line);
      if (doc && (doc.data || doc.errors)) return doc;
    } catch (_) { /* not a JSON line */ }
  }
  return null;
}

/**
 * Direct messages over Instagram's web GraphQL. Mixed into InstagramBot.prototype;
 * social.js builds the inbox summary / thread fetchers on top of these.
 */
module.exports = {
  /**
   * Capture the inbox and thread query templates from the DM page's own traffic,
   * then leave the page at `returnTo` (the DM page itself for the realtime
   * listener, a light page otherwise). @private
   */
  async _learnDirectQueries(page, { returnTo = LIGHT_PAGE } = {}) {
    const found = {};
    const onRequest = req => {
      const name = req.headers()["x-fb-friendly-name"];
      const kind = Object.keys(DIRECT_QUERIES).find(k => DIRECT_QUERIES[k] === name);
      if (!kind || found[kind]) return;
      const headers = {};
      for (const [key, value] of Object.entries(req.headers())) if (KEEP_HEADER.test(key)) headers[key] = value;
      found[kind] = { url: req.url(), headers, body: req.postData() || "" };
    };
    page.on("request", onRequest);
    try {
      await page.goto(INBOX_URL, { waitUntil: "domcontentloaded" });
      if (!(await waitFor(() => found.inbox, 20000))) {
        throw new Error("Instagram DM inbox query was not observed (not logged in, or the DM page changed)");
      }
      this._directTpl = { ...(this._directTpl || {}), inbox: found.inbox };
      // The desktop layout usually opens the newest conversation by itself; if not,
      // open it once so its thread query can be observed.
      if (!(await waitFor(() => found.thread, 4000))) {
        const box = (await this._replayDirect(page, "inbox")).get_slide_mailbox_for_iris_subscription;
        const edge = box && box.threads_by_folder && (box.threads_by_folder.edges || [])[0];
        const thread = edge && edge.node && (edge.node.as_ig_direct_thread || edge.node);
        if (thread && thread.thread_key) {
          await page.goto(`https://www.instagram.com/direct/t/${thread.thread_key}/`, { waitUntil: "domcontentloaded" });
          await waitFor(() => found.thread, 15000);
        }
      }
      if (found.thread) this._directTpl.thread = found.thread;
    } finally {
      page.off("request", onRequest);
      if (page.url() !== returnTo) await page.goto(returnTo, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    return this._directTpl;
  },

  /** Replay a captured template with patched variables; returns the GraphQL `data`. @private */
  async _replayDirect(page, kind, patch = null) {
    const tpl = this._directTpl && this._directTpl[kind];
    if (!tpl) throw new Error(`Instagram ${DIRECT_QUERIES[kind]} template not available yet`);
    const res = await page.evaluate(async ({ url, headers, body, patch }) => {
      const params = new URLSearchParams(body);
      if (patch) params.set("variables", JSON.stringify(Object.assign(JSON.parse(params.get("variables") || "{}"), patch)));
      const r = await fetch(url, { method: "POST", headers, body: params.toString(), credentials: "include" });
      return { status: r.status, text: await r.text() };
    }, { url: tpl.url, headers: tpl.headers, body: tpl.body, patch });
    if (res.status !== 200) throw new Error(`Instagram ${DIRECT_QUERIES[kind]} HTTP ${res.status}`);
    const doc = firstDataDoc(res.text);
    if (!doc || !doc.data) {
      const reason = doc && doc.errors && doc.errors[0] && (doc.errors[0].message || doc.errors[0].summary);
      throw new Error(`Instagram ${DIRECT_QUERIES[kind]} returned no data${reason ? `: ${reason}` : ""}`);
    }
    return doc.data;
  },

  /**
   * Run a DM query, learning the templates first if needed. A failure re-learns
   * once (tokens and query ids rotate), at most once a minute. @private
   */
  async _directQuery(page, kind, patch = null) {
    if (!page.url().startsWith("https://www.instagram.com")) {
      await page.goto(LIGHT_PAGE, { waitUntil: "domcontentloaded" });
    }
    // A page that lives on the DM page (realtime listener) goes back there after re-learning.
    const returnTo = page.url().startsWith(INBOX_URL) ? INBOX_URL : LIGHT_PAGE;
    if (!this._directTpl || !this._directTpl[kind]) {
      this._directRelearnAt = Date.now();
      await this._learnDirectQueries(page, { returnTo });
      return this._replayDirect(page, kind, patch);
    }
    try {
      return await this._replayDirect(page, kind, patch);
    } catch (err) {
      if (this._directRelearnAt && Date.now() - this._directRelearnAt < RELEARN_COOLDOWN_MS) throw err;
      this._directRelearnAt = Date.now();
      await this._learnDirectQueries(page, { returnTo });
      return this._replayDirect(page, kind, patch);
    }
  },

  /** Unread badge (cheap REST call that still works): changes when the inbox does. @private */
  async _directBadge(page) {
    return page.evaluate(async () => {
      const r = await fetch("/api/v1/direct_v2/get_badge_count/?no_raven=1",
        { headers: { "x-ig-app-id": "936619743392459" }, credentials: "include" });
      if (!r.ok) throw new Error(`badge HTTP ${r.status}`);
      const j = await r.json();
      return `${j.seq_id}:${j.badge_count}:${j.badge_count_at_ms}`;
    });
  },

  /** GraphQL user → the trimmed user shape the listener uses. @private */
  _mapDirectUser(u) {
    return {
      pk: String(u.pk || u.id),
      username: u.username,
      full_name: u.full_name || null,
      profile_pic_url: u.profile_pic_url || null,
      is_verified: !!u.is_verified,
      is_private: !!u.is_private,
      account_type: u.account_type || null,
      has_highlight_reels: !!u.has_highlight_reels,
      friendship_status: u.friendship_status || null,
      fbid: u.interop_messaging_user_fbid ? String(u.interop_messaging_user_fbid) : null,
    };
  },

  /** GraphQL thread → { threadId, threadTitle, users, lastSeenAt, ctx } (ctx maps sender ids). @private */
  _mapDirectThread(t) {
    const users = (t.users || []).map(u => this._mapDirectUser(u));
    const viewer = t.viewer || {};
    const viewerId = String(viewer.id || t.viewer_id || "");
    const fbidToPk = {};
    users.forEach(u => { if (u.fbid) fbidToPk[u.fbid] = u.pk; });
    if (viewer.interop_messaging_user_fbid) fbidToPk[String(viewer.interop_messaging_user_fbid)] = viewerId;
    const lastSeenAt = {};
    for (const r of t.slide_read_receipts || []) {
      const pk = fbidToPk[String(r.participant_fbid)];
      if (pk) lastSeenAt[pk] = { timestamp: Number(r.watermark_timestamp_ms || 0) * 1000 };
    }
    return {
      threadId: String(t.thread_key),
      threadTitle: t.thread_title || null,
      users,
      lastSeenAt,
      ctx: { viewerId, viewerFbid: viewer.interop_messaging_user_fbid ? String(viewer.interop_messaging_user_fbid) : null, fbidToPk },
    };
  },

  /**
   * GraphQL message → the trimmed raw item shape (`ts` in microseconds, as the
   * old REST API) so _normalizeItem works unchanged. Shared reels/posts arrive as
   * an XMA card whose target_url carries the shortcode. @private
   */
  _mapDirectMessage(node, ctx) {
    if (!node) return null;
    const url = (node.content && node.content.xma && node.content.xma.target_url) || "";
    const code = pattern => { const m = url.match(pattern); return m ? m[1] : null; };
    const sender = node.sender && node.sender.user_dict;
    const senderPk = String((sender && sender.id) || ctx.fbidToPk[String(node.sender_fbid)] || node.sender_fbid || "");
    const contentType = node.content_type || "";
    return {
      itemType: contentType === "TEXT" ? "text" : (contentType.toLowerCase() || null),
      itemId: node.message_id || node.id,
      userId: senderPk,
      ts: Number(node.timestamp_ms || 0) * 1000,
      text: node.text_body || (node.content && (node.content.text_body || node.content.xma_text_body)) || null,
      sentByViewer: (ctx.viewerFbid && String(node.sender_fbid) === ctx.viewerFbid) || (!!ctx.viewerId && senderPk === ctx.viewerId),
      clipCode: code(/\/reels?\/([^/?#]+)/),
      reelShareCode: null,
      reelShareText: null,
      mediaShareCode: code(/\/(?:p|tv)\/([^/?#]+)/),
      replied: node.replied_to_message ? this._mapDirectMessage(node.replied_to_message, ctx) : null,
    };
  },
};
