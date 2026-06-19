<div align="center">

# 🌊 InstaFlow

**Headless Instagram automation for Node.js — powered by Playwright.**  
No API key. No OAuth. Just a real browser session, human-like behaviour, and a clean async API.

[![npm version](https://img.shields.io/npm/v/instaflow?color=CB3837&logo=npm)](https://www.npmjs.com/package/instaflow)
[![npm downloads](https://img.shields.io/npm/dm/instaflow?color=blue)](https://www.npmjs.com/package/instaflow)
[![license](https://img.shields.io/npm/l/instaflow?color=green)](LICENSE)
[![node](https://img.shields.io/node/v/instaflow)](package.json)

**🌐 English** · [Türkçe](README.tr.md)

</div>

---

## ✨ Features

| Category | Actions |
|---|---|
| **Publishing** | Post photo/video, upload story, edit profile (name/bio/website/avatar), delete post |
| **Engagement** | Like, unlike, comment, save, unsave |
| **Social** | Follow, unfollow, send DM, view & react to story |
| **Scraping** | Profile stats, post stats, comments, followers/following, search, hashtag posts, inbox |
| **Reels** | Scrape the reels feed, enriched reel stats + cover thumbnail, best-effort reel video download |
| **Session** | Export raw cookies (e.g. for `yt-dlp`) |
| **Safety** | Built-in rate limiter, human-like delays, anti-detection stealth, persistent sessions |

---

## 📦 Installation

```bash
npm install instaflow
npx playwright install chromium
```

> Only the Chromium browser binary is needed.

---

## 🚀 Quick Start

```js
const InstaFlow = require('instaflow');

const bot = new InstaFlow({
  sessionDir: './my-session',   // persists login — no re-auth needed
  headless: true,
  humanize: true,               // random human-like delays between actions
});

bot.on('ready', async () => {
  // Get your own profile stats
  const me = await bot.getMyStats();
  console.log(`@${me.username} — ${me.followers} followers`);

  // Like a post
  await bot.likePost('https://www.instagram.com/p/SHORTCODE/');

  // Post a photo with caption
  await bot.post('Hello from InstaFlow 🌊', {
    media: ['./photo.jpg'],
  });

  await bot.close();
});

bot.init();
```

---

## 🔐 Authentication

### Persistent Session (recommended)

The easiest way — log in once via browser, then reuse the session forever:

```js
const bot = new InstaFlow({
  sessionDir: './sessions/my_account',
  headless: false,   // show browser for first login
});
```

Launch the bot, log in manually in the browser window that opens, then switch `headless: true` for all future runs. The session is stored in `sessionDir` and survives restarts.

### Credential Login

```js
const bot = new InstaFlow({
  username: 'your_username',
  password: 'your_password',
  sessionDir: './sessions/my_account',  // saves session after first login
});
```

### Cookie Auth

```js
const bot = new InstaFlow({
  cookies: {
    sessionid:  'xxxx',
    csrftoken:  'yyyy',
    ds_user_id: 'zzzz',
  },
});
```

---

## 📖 API Reference

All methods are `async` and resolve when the action completes.

### `bot.init()` → `InstaFlow`
Launch the browser and authenticate. Emits `ready` when done.

### `bot.close()`
Close browser and release all resources.

---

### Read — Profile

#### `bot.getMyStats()` → `ProfileStats`
Returns the logged-in account's stats (followers, following, posts, bio, avatar).

#### `bot.getProfile(username)` → `ProfileStats`
Returns public profile stats for any account. Uses Instagram's `web_profile_info` JSON API as the primary source (DOM scrape as fallback), so full name, bio, counts, verified badge and external URL are accurate.

```js
const profile = await bot.getProfile('nasa');
// { username, fullName, bio, followers, following, posts, avatarUrl, isPrivate, isVerified, externalUrl }
```

---

### Read — Posts & Comments

#### `bot.getUserPosts(username, count?)` → `{ posts, count }`
Scrape up to `count` (default 12) post URLs + shortcodes from a profile grid.

#### `bot.getPostStats(postUrl)` → `PostStats`
Return likes, comment count, caption, author, and publish date for a post.

#### `bot.getPostComments(postUrl, count?)` → `Comment[]`
Scrape up to `count` comments with username + text + timestamp.

---

### Read — Social Graph

#### `bot.getFollowers(username, count?)` → `User[]`
#### `bot.getFollowing(username, count?)` → `User[]`
Scrape followers / following lists. Returns `{ username, avatar, fullName }[]`.

---

### Read — Discovery

#### `bot.search(query)` → `{ users, hashtags, places }`
Global search — returns user suggestions, hashtag suggestions, and place results.

#### `bot.searchUsers(query)` → `User[]`
Search users only.

#### `bot.getHashtagPosts(hashtag, count?)` → `Post[]`
Scrape the top posts under a hashtag.

---

### Read — Inbox

#### `bot.getInbox(count?)` → `{ threads }`
List DM threads with last-message preview.

#### `bot.getMessages(threadId, count?)` → `{ messages }`
Read messages in a specific thread.

---

### Read — Reels

#### `bot.getReelsFeed(count?)` → `Reel[]`
Advance through the real reels feed (`instagram.com/reels/`) and collect reel shortcodes. Returns `{ shortcode, type: 'reel', url }[]`.

#### `bot.getReelStats(postUrl)` → `ReelStats`
Enriched stats for a reel (or any post): cover **thumbnail** (suitable for multimodal AI analysis), play/view count, likes, comments, caption, author, and the raw `videoSrc` when present.

```js
const reel = await bot.getReelStats('https://www.instagram.com/reel/SHORTCODE/');
// { author, caption, thumbnail, videoSrc, plays, likes, comments, publishedAt }
```

#### `bot.downloadReel(postUrl, destPath)` → `{ path, url, bytes }`
Best-effort download of a reel's video file to `destPath`. Instagram serves reels via MSE/blob + ranged CDN, so success isn't guaranteed — it tries the `og:video` progressive MP4, then the `<video>` source, then the largest captured `.mp4` network response.

---

### Write — Publishing

#### `bot.post(caption, options?)` → `PostResult`
Publish a photo or video post.

```js
await bot.post('Check this out! #photography', {
  media: ['./photo.jpg'],      // local file path(s)
});
```

#### `bot.postStory(mediaPath)` → `StoryResult`
Publish a story from a local image or video file. Instagram removed story creation from the desktop website, so this spins up a short-lived **mobile-emulated** browser context (seeded with your current session cookies), publishes via the mobile **create (+) → Story** flow, and tears it down — your main session is untouched. (You'll briefly see a second Chromium window when `headless: false`.)

#### `bot.setupProfile(options)` → `ProfileEditResult`
Update profile metadata on the account-edit page. Every field is optional — only the ones you pass are touched.

```js
await bot.setupProfile({
  name:    'InstaFlow Bot',
  bio:     'Automated with 🌊 InstaFlow',
  website: 'https://example.com',
  avatar:  './new-avatar.jpg',   // local image path
});
// → { name, bio, website, avatar, saved, timestamp }  (booleans report what was applied)
```

#### `bot.deletePost(postUrl)` → `Result`
Delete one of your own posts/reels (opens the post's **…** menu → Delete → confirm).

```js
await bot.deletePost('https://www.instagram.com/p/SHORTCODE/');
// → { success: true, postUrl, timestamp }
```

---

### Write — Engagement

#### `bot.likePost(postUrl)` → `Result`
#### `bot.unlikePost(postUrl)` → `Result`
Like / remove like from a post.

#### `bot.savePost(postUrl)` → `Result`
#### `bot.unsavePost(postUrl)` → `Result`
Bookmark / remove bookmark from a post.

#### `bot.comment(postUrl, text)` → `CommentResult`
Post a comment on a post.

#### `bot.searchAndLike(hashtag, count?)` → `{ hashtag, liked, requested }`
Scrape the top posts under a hashtag and like up to `count` of them (default 5), with randomized delays between likes.

---

### Write — Social

#### `bot.followUser(username)` → `Result`
#### `bot.unfollowUser(username)` → `Result`
Follow / unfollow an account.

#### `bot.sendDM(username, message)` → `DMResult`
Send a direct message to a user.

#### `bot.viewStory(username)` → `Result`
Open and watch a user's currently-active story (registers as a view).

#### `bot.reactToStory(username, emoji)` → `Result`
React to a user's active story with an emoji.

---

### Utility

#### `bot.getRateLimitStatus()` → `RateLimitStatus`
See hourly / daily usage vs configured caps for every action type.

#### `bot.getCookies()` → `Cookie[]`
Return the current session cookies in Playwright format — handy for exporting an authenticated session to external tools like `yt-dlp`.

---

## ⚙️ Configuration

```js
const bot = new InstaFlow({
  // Auth
  sessionDir: './sessions/account',
  username:   'your_username',
  password:   'your_password',

  // Browser
  headless:   true,
  timeout:    60000,   // ms per page action

  // Proxy (optional)
  proxy: {
    host:     'proxy.example.com',
    port:     8080,
    protocol: 'http',      // or 'socks5'
    username: 'user',
    password: 'pass',
  },

  // Behaviour
  humanize: true,   // random delays between actions

  // Rate limits (override defaults)
  rateLimits: {
    like:    { hour: 20, day: 100 },
    comment: { hour: 10, day: 40  },
    follow:  { hour: 5,  day: 20  },
    // post | story | like | comment | follow | unfollow | dm
  },
});
```

**Default rate limits:**

| Action | Per hour | Per day |
|--------|----------|---------|
| post | 3 | 10 |
| story | 5 | 15 |
| like | 30 | 150 |
| comment | 15 | 60 |
| follow | 10 | 40 |
| unfollow | 10 | 40 |
| dm | 10 | 40 |

---

## 📡 Events

```js
bot.on('ready',            ()       => console.log('Bot is ready'));
bot.on('loginRequired',    ()       => console.log('Need to log in'));
bot.on('error',            (err)    => console.error('Error:', err));
bot.on('rateLimitHit',     (info)   => console.warn('Rate limit:', info));
bot.on('actionBlocked',    (info)   => console.warn('Blocked:', info));
bot.on('challengeRequired',()       => console.warn('Challenge triggered'));
bot.on('postLiked',        (result) => console.log('Liked:', result));
bot.on('postCommented',    (result) => console.log('Commented:', result));
bot.on('userFollowed',     (result) => console.log('Followed:', result));
bot.on('userUnfollowed',   (result) => console.log('Unfollowed:', result));
bot.on('postPublished',    (result) => console.log('Published:', result));
bot.on('postFailed',       (info)   => console.warn('Post failed:', info));
bot.on('storyPublished',   (result) => console.log('Story up:', result));
bot.on('storyFailed',      (info)   => console.warn('Story failed:', info));
bot.on('profileSetup',     (result) => console.log('Profile updated:', result));
bot.on('postDeleted',      (result) => console.log('Post deleted:', result));
bot.on('dmSent',           (result) => console.log('DM sent:', result));
```

---

## 🛡️ Anti-Detection

InstaFlow uses several techniques to reduce detection risk:

- **Stealth flags** — `--disable-blink-features=AutomationControlled`, patched `navigator.webdriver`
- **Persistent Chrome profile** — same fingerprint across runs, no fresh-browser tells
- **Human delays** — configurable random pauses between interactions (`humanize: true`)
- **Rate limiting** — built-in hourly/daily caps prevent sudden bursts
- **Real browser** — Playwright drives Chromium, indistinguishable from a real user session

> ⚠️ This library is intended for personal use, research, and testing. Using automation on Instagram may violate their Terms of Service. Use responsibly and at your own risk.

---

## 🗂️ Project Structure

```
instaflow/
├── index.js          # Entry: InstagramBot class + mixin assembly (module.exports)
├── src/              # Implementation, split by concern
│   ├── constants.js  # User-agent, viewport, default rate limits
│   ├── utils.js      # delay() and shared helpers
│   ├── auth.js       # init / login / close (browser lifecycle)
│   ├── safety.js     # humanize, rate limiting, block detection, guards
│   ├── content.js    # post / story / profile editing (publishing)
│   ├── engagement.js # comment / like / save / bulk hashtag like
│   ├── social.js     # follow / unfollow / DM / story interactions
│   └── insights.js   # profile / post / reel scraping, search, inbox, download
├── example.js        # Basic usage example
├── example_publish.js
├── example_interaction.js
├── tests/
│   ├── run.js        # Test orchestrator (node tests/run.js)
│   └── test_*.js
└── sessions/         # Chrome profile directories (gitignored)
```

> The public API is a single class (`require('instaflow')`). Internally it's
> composed from the `src/` modules via `Object.assign(prototype, ...)`, so every
> method shares the same `this` (page, context, rate-limiter state).

---

## 🤝 Contributing

Pull requests are welcome. For major changes, please open an issue first.

```bash
git clone https://github.com/alpersamur3/instaflow.git
cd instaflow
npm install
npx playwright install chromium
node tests/run.js
```

---

## 📄 License

[MIT](LICENSE) © 2026 alpersamur3
