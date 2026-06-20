<div align="center">

# 🌊 InstaFlow

**Node.js için başsız (headless) Instagram otomasyonu — Playwright ile.**  
API anahtarı yok. OAuth yok. Sadece gerçek bir tarayıcı oturumu, insan benzeri davranış ve temiz bir async API.

[![npm version](https://img.shields.io/npm/v/instaflow?color=CB3837&logo=npm)](https://www.npmjs.com/package/instaflow)
[![npm downloads](https://img.shields.io/npm/dm/instaflow?color=blue)](https://www.npmjs.com/package/instaflow)
[![license](https://img.shields.io/npm/l/instaflow?color=green)](LICENSE)
[![node](https://img.shields.io/node/v/instaflow)](package.json)

[English](README.md) · **🌐 Türkçe**

</div>

---

## ✨ Özellikler

| Kategori | Eylemler |
|---|---|
| **Yayınlama** | Fotoğraf/video gönderisi, hikaye yükleme, profil düzenleme (ad/bio/website/avatar), gönderi silme |
| **Etkileşim** | Beğen, beğeniyi geri al, yorum, kaydet, kaydı kaldır |
| **Sosyal** | Takip et, takipten çık, DM gönder, DM mesajlarına tepki ver, hikaye görüntüle & tepki ver |
| **Kazıma (Scraping)** | Profil istatistikleri, gönderi istatistikleri, yorumlar, takipçi/takip edilen, arama, hashtag gönderileri, gelen kutusu |
| **Reels** | Reels akışını kazı, zenginleştirilmiş reel istatistikleri + kapak küçük resmi, reel video indirme, tam reel analizi (açıklama/beğeni/yorum) |
| **Gerçek Zamanlı** | DM mesaj dinleyici — gönderen/tür/paylaşılan-medya ile `messageReceived` olayı |
| **Oturum** | Ham çerezleri dışa aktar (ör. `yt-dlp` için) |
| **Güvenlik** | Yerleşik hız sınırlayıcı, insan benzeri gecikmeler, tespit önleyici gizlilik, kalıcı oturumlar |

---

## 📦 Kurulum

```bash
npm install instaflow
npx playwright install chromium
```

> Yalnızca Chromium tarayıcı ikilisi gereklidir.

---

## 🚀 Hızlı Başlangıç

```js
const InstaFlow = require('instaflow');

const bot = new InstaFlow({
  sessionDir: './my-session',   // oturumu kalıcı kılar — yeniden giriş gerekmez
  headless: true,
  humanize: true,               // eylemler arasında rastgele insan benzeri gecikmeler
});

bot.on('ready', async () => {
  // Kendi profil istatistiklerini al
  const me = await bot.getMyStats();
  console.log(`@${me.username} — ${me.followers} takipçi`);

  // Bir gönderiyi beğen
  await bot.likePost('https://www.instagram.com/p/SHORTCODE/');

  // Açıklamalı bir fotoğraf paylaş
  await bot.post('InstaFlow ile merhaba 🌊', {
    media: ['./photo.jpg'],
  });

  await bot.close();
});

bot.init();
```

---

## 🔐 Kimlik Doğrulama

### Kalıcı Oturum (önerilen)

En kolay yol — tarayıcıdan bir kez giriş yap, sonra oturumu sonsuza dek tekrar kullan:

```js
const bot = new InstaFlow({
  sessionDir: './sessions/my_account',
  headless: false,   // ilk giriş için tarayıcıyı göster
});
```

Botu başlat, açılan tarayıcı penceresinden manuel giriş yap, ardından sonraki tüm çalıştırmalar için `headless: true` yap. Oturum `sessionDir` içinde saklanır ve yeniden başlatmalara dayanır.

### Kimlik Bilgisiyle Giriş

```js
const bot = new InstaFlow({
  username: 'kullanici_adin',
  password: 'sifren',
  sessionDir: './sessions/my_account',  // ilk girişten sonra oturumu kaydeder
});
```

### Çerez (Cookie) ile Giriş

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

## 📖 API Referansı

Tüm metotlar `async`'tir ve eylem tamamlandığında çözülür (resolve).

### `bot.init()` → `InstaFlow`
Tarayıcıyı başlatır ve kimlik doğrular. Bittiğinde `ready` olayını yayar.

### `bot.close()`
Tarayıcıyı kapatır ve tüm kaynakları serbest bırakır.

---

### Okuma — Profil

#### `bot.getMyStats()` → `ProfileStats`
Giriş yapılmış hesabın istatistiklerini döndürür (takipçi, takip edilen, gönderi, bio, avatar).

#### `bot.getProfile(username)` → `ProfileStats`
Herhangi bir hesabın herkese açık profil istatistiklerini döndürür. Instagram'ın `web_profile_info` JSON API'sini birincil kaynak olarak kullanır (DOM kazıma yedektir), bu yüzden ad, bio, sayılar, onaylı rozeti ve harici URL doğrudur.

```js
const profile = await bot.getProfile('nasa');
// { username, fullName, bio, followers, following, posts, avatarUrl, isPrivate, isVerified, externalUrl }
```

---

### Okuma — Gönderiler & Yorumlar

#### `bot.getUserPosts(username, count?)` → `{ posts, count }`
Bir profil ızgarasından `count` (varsayılan 12) kadar gönderi URL'si + kısa kodu kazır.

#### `bot.getPostStats(postUrl)` → `PostStats`
Bir gönderi için beğeni, yorum sayısı, açıklama, yazar ve yayın tarihini döndürür.

#### `bot.getPostComments(postUrl, count?)` → `Comment[]`
Kullanıcı adı + metin + zaman damgasıyla `count` kadar yorumu kazır.

---

### Okuma — Sosyal Grafik

#### `bot.getFollowers(username, count?)` → `User[]`
#### `bot.getFollowing(username, count?)` → `User[]`
Takipçi / takip edilen listelerini kazır. `{ username, avatar, fullName }[]` döndürür.

---

### Okuma — Keşif

#### `bot.search(query)` → `{ users, hashtags, places }`
Genel arama — kullanıcı önerileri, hashtag önerileri ve yer sonuçları döndürür.

#### `bot.searchUsers(query)` → `User[]`
Yalnızca kullanıcıları arar.

#### `bot.getHashtagPosts(hashtag, count?)` → `Post[]`
Bir hashtag altındaki en iyi gönderileri kazır.

---

### Okuma — Gelen Kutusu

#### `bot.getInbox(count?)` → `{ threads }`
DM konularını listeler; her biri `lastMessage` ile (tür, metin/medya, `sentAt`, gönderen).

#### `bot.getMessages(threadId, count?)` → `{ messages }`
Bir konudaki mesajları (thread API'siyle) okur. Her mesaj tam normalize — `{ itemId, from, fromId, fromSelf, type, text, media, repliedTo, timestamp, sentAt, sender }` — yani **tarih-saat** (`sentAt`) ve alıntılanan mesaj (`repliedTo`) de gelir.

---

### Okuma — Reels

#### `bot.getReelsFeed(count?)` → `Reel[]`
Gerçek reels akışında (`instagram.com/reels/`) ilerler ve reel kısa kodlarını toplar. `{ shortcode, type: 'reel', url }[]` döndürür.

#### `bot.getReelStats(postUrl)` → `ReelStats`
Bir reel (veya herhangi bir gönderi) için zenginleştirilmiş istatistikler: kapak **küçük resmi** (multimodal yapay zeka analizine uygun), oynatma/izlenme sayısı, beğeni, yorum, açıklama, yazar ve varsa ham `videoSrc`.

```js
const reel = await bot.getReelStats('https://www.instagram.com/reel/SHORTCODE/');
// { author, caption, thumbnail, videoSrc, plays, likes, comments, publishedAt }
```

#### `bot.downloadReel(postUrl, destPath)` → `{ path, url, bytes }`
Bir reel'in video dosyasını `destPath`'e en iyi çabayla indirir. Instagram reel'leri MSE/blob + aralıklı CDN ile sunduğundan başarı garanti değildir — önce `og:video` ilerlemeli MP4'ünü, sonra `<video>` kaynağını, sonra yakalanan en büyük `.mp4` ağ yanıtını dener.

#### `bot.analyzeReel(input, options?)` → `ReelAnalysis`
İleri/yapay zeka işleme için tam reel analizi — videoyu indirir ve açıklamayı, etkileşim sayılarını ve **gerçek yorumlardan** bir örneklemi döndürür (Instagram'ın media info/comments JSON API'leriyle, sayılar kesindir). `input` bir reel URL'si, kısa kod **veya paylaşılan reel taşıyan bir `messageReceived` event nesnesi** olabilir.

```js
const a = await bot.analyzeReel('https://www.instagram.com/reel/SHORTCODE/', {
  download: true,           // .mp4'ü de kaydet (varsayılan true)
  downloadDir: './reels',   // nereye kaydedileceği
  commentCount: 12,         // kaç yorum örnekleneceği
});
// {
//   url, shortcode, mediaId, author, fullName, caption,
//   likes, comments, plays, durationSec, publishedAt,
//   thumbnail, videoUrl,
//   sampleComments: [{ username, text, likes, createdAt }],
//   download: { path, bytes, url },
//   timestamp,
// }
```

`reelAnalyzed` olayını yayar.

---

### Yazma — Yayınlama

#### `bot.post(caption, options?)` → `PostResult`
Fotoğraf veya video gönderisi yayınlar.

```js
await bot.post('Şuna bir bak! #fotografcilik', {
  media: ['./photo.jpg'],      // yerel dosya yolu/yolları
});
```

#### `bot.postStory(mediaPath)` → `StoryResult`
Yerel bir görsel veya videodan hikaye yayınlar. Instagram masaüstü web sitesinden hikaye oluşturmayı kaldırdığı için, bu metot mevcut oturum çerezlerinle beslenen kısa ömürlü **mobil-emülasyonlu** bir tarayıcı bağlamı açar, mobil **oluştur (+) → Hikaye** akışıyla yayınlar ve bağlamı kapatır — ana oturumun etkilenmez. (`headless: false` iken kısa süreliğine ikinci bir Chromium penceresi görürsün.)

#### `bot.setupProfile(options)` → `ProfileEditResult`
Hesap düzenleme sayfasında profil meta verisini günceller. Her alan isteğe bağlıdır — yalnızca verdiklerine dokunulur.

```js
await bot.setupProfile({
  name:    'InstaFlow Bot',
  bio:     '🌊 InstaFlow ile otomatikleştirildi',
  website: 'https://example.com',
  avatar:  './new-avatar.jpg',   // yerel görsel yolu
});
// → { name, bio, website, avatar, saved, timestamp }  (booleanlar neyin uygulandığını bildirir)
```

#### `bot.deletePost(postUrl)` → `Result`
Kendi gönderilerinden/reel'lerinden birini siler (gönderinin **…** menüsünü açar → Sil → onayla).

```js
await bot.deletePost('https://www.instagram.com/p/SHORTCODE/');
// → { success: true, postUrl, timestamp }
```

---

### Yazma — Etkileşim

#### `bot.likePost(postUrl)` → `Result`
#### `bot.unlikePost(postUrl)` → `Result`
Bir gönderiyi beğen / beğeniyi kaldır.

#### `bot.savePost(postUrl)` → `Result`
#### `bot.unsavePost(postUrl)` → `Result`
Bir gönderiyi kaydet / kaydı kaldır.

#### `bot.comment(postUrl, text)` → `CommentResult`
Bir gönderiye yorum yapar.

#### `bot.searchAndLike(hashtag, count?)` → `{ hashtag, liked, requested }`
Bir hashtag altındaki en iyi gönderileri kazır ve `count` kadarını (varsayılan 5) beğeniler arası rastgele gecikmelerle beğenir.

---

### Yazma — Sosyal

#### `bot.followUser(username)` → `Result`
#### `bot.unfollowUser(username)` → `Result`
Bir hesabı takip et / takipten çık.

#### `bot.sendDM(username, message)` → `DMResult`
Bir kullanıcıya direkt mesaj gönderir.

#### `bot.viewStory(username)` → `Result`
Bir kullanıcının aktif hikayesini açar ve izler (görüntüleme olarak sayılır).

#### `bot.reactToStory(username, emoji)` → `Result`
Bir kullanıcının aktif hikayesine emoji ile tepki verir.

#### `bot.reactToMessage(threadId, target?, emoji?)` → `Result`
Bir DM mesajına emoji ile tepki verir (hızlı set: ❤️ 😂 😮 😢 😡 👍; varsayılan ❤️). `target` mesajın **metni**, bir `{ text }` veya bir `messageReceived` mesaj nesnesi olabilir; vermezsen thread'deki son gelen metin mesajına tepki verir. Listener ile doğal uyum:

```js
bot.on('messageReceived', (msg) => {
  if (msg.type === 'reel') bot.reactToMessage(msg.threadId, msg, '😂');
});
```

---

### Yardımcı

#### `bot.getRateLimitStatus()` → `RateLimitStatus`
Her eylem türü için saatlik / günlük kullanımı, yapılandırılmış limitlere karşı gösterir.

#### `bot.getCookies()` → `Cookie[]`
Mevcut oturum çerezlerini Playwright formatında döndürür — kimlik doğrulanmış bir oturumu `yt-dlp` gibi harici araçlara aktarmak için kullanışlıdır.

---

## 📨 Gerçek Zamanlı DM Dinleyici

DM gelen kutusunu yoklar ve gelen mesajlara anında tepki verir. **Burst-güvenli:**
inbox thread başına yalnızca ~2 mesaj önizler, bu yüzden bir thread'de yeni
hareket olunca **tüm thread çekilir** ve her yeni mesaj teslim edilir — iki
yoklama arasında birden fazla mesaj gelse bile **hiçbiri kaçmaz**.

Her yoklamada iki olay tetiklenir — hangisini istersen onu dinle:

| Olay | Ne zaman | Yük |
|---|---|---|
| `messageReceived` | her yeni mesaj için **bir kez** | tek bir normalize mesaj |
| `userMessages` | yeni mesajı olan her **thread/kişi** için bir kez | `{ threadId, threadTitle, from, fromId, sender, messages: [ … ] }` |

Yani Alper bir döngüde 3, Mehmet 2 mesaj atarsa: 5 `messageReceived` **ve** 2
`userMessages` olayı alırsın (Alper'in 3'ü bir dizi, sonra Mehmet'in 2'si).

#### `bot.startMessageListener(options?)`
Yoklamayı başlatır. Seçenekler: `interval` (ms, varsayılan 6000), `limit` (yoklama başına thread, varsayılan 20), `threadLimit` (aktif thread başına çekilen mesaj, varsayılan 25), `includeSelf` (varsayılan false), `emitExisting` (başlangıçta mevcut birikimi yay, varsayılan false), `enrichSender` (`sender`'a bio/takipçi sayıları/hikaye durumu ekler, her yeni gönderen için +1 istek, varsayılan false).

#### `bot.stopMessageListener()`
Yoklamayı durdurur ve arka plan sekmesini kapatır.

```js
// Mesaj bazlı: sana DM ile gelen her reel'i otomatik analiz et
bot.on('messageReceived', async (msg) => {
  console.log(`@${msg.from} bir ${msg.type} gönderdi — ${msg.sentAt}`);
  if (msg.repliedTo) console.log(`  ↳ şunu yanıtlıyor ${msg.repliedTo.from}: "${msg.repliedTo.text}"`);
  if (msg.media?.type === 'reel') {
    const reel = await bot.analyzeReel(msg, { download: true, downloadDir: './reels' });
    console.log(`  ↳ @${reel.author} — ${reel.likes} beğeni, ${reel.comments} yorum`);
  }
});

// Kişi bazlı: her gönderenin yeni mesajlarını tek seferde işle
bot.on('userMessages', ({ from, messages }) => {
  console.log(`@${from} ${messages.length} yeni mesaj gönderdi`);
});

bot.on('ready', () => bot.startMessageListener({ interval: 5000 }));
bot.init();
```

**`messageReceived` yükü:**

```js
{
  threadId, threadTitle,
  itemId,            // benzersiz mesaj id'si (yinelenenleri ayıklamak için)
  from, fromId,      // gönderen kullanıcı adı + id
  fromSelf,          // mesajı sen gönderdiysen true
  type,              // 'text' | 'reel' | 'post' | ham IG item_type
  text,              // metin içeriği (veya null)
  media,             // { type:'reel'|'post', shortcode, url }  — veya null
  repliedTo,         // bir yanıtsa alıntılanan mesaj (aynı yapı) — değilse null
  timestamp,         // ms
  sentAt,            // ISO tarih-saat metni
  sender: {          // kimden geldiği (ücretsiz, doğrudan gelen kutusundan)
    username, fullName /* ad-soyad */, avatar /* profil foto */, isVerified, isPrivate,
    accountType, hasHighlights,
    friendship: { following, followedBy, isBestie, muting, blocking, restricted },
    lastActiveAt,    // ms — bu sohbette son görülme (web'de canlı "online" bilgisi yok)
    // enrichSender: true ile ayrıca:
    bio, followers, following, posts, externalUrl, hasActiveStory, storyCount,
  },
}
```

> Yoklama ayrı bir arka plan sekmesinde çalışır, diğer eylemlerini asla aksatmaz. Handler'ın ağır iş yapıyorsa (indirme, gezinme), sayfa işlemlerinin çakışmaması için sıraya al (ör. bir kuyruk).

---

## ⚙️ Yapılandırma

```js
const bot = new InstaFlow({
  // Kimlik doğrulama
  sessionDir: './sessions/account',
  username:   'kullanici_adin',
  password:   'sifren',

  // Tarayıcı
  headless:   true,
  timeout:    60000,   // sayfa eylemi başına ms

  // Proxy (isteğe bağlı)
  proxy: {
    host:     'proxy.example.com',
    port:     8080,
    protocol: 'http',      // veya 'socks5'
    username: 'user',
    password: 'pass',
  },

  // Davranış
  humanize: true,   // eylemler arası rastgele gecikmeler

  // Hız limitleri (varsayılanları geçersiz kıl)
  rateLimits: {
    like:    { hour: 20, day: 100 },
    comment: { hour: 10, day: 40  },
    follow:  { hour: 5,  day: 20  },
    // post | story | like | comment | follow | unfollow | dm
  },
});
```

**Varsayılan hız limitleri:**

| Eylem | Saatlik | Günlük |
|--------|----------|---------|
| post | 3 | 10 |
| story | 5 | 15 |
| like | 30 | 150 |
| comment | 15 | 60 |
| follow | 10 | 40 |
| unfollow | 10 | 40 |
| dm | 10 | 40 |

---

## 📡 Olaylar (Events)

```js
bot.on('ready',            ()       => console.log('Bot hazır'));
bot.on('loginRequired',    ()       => console.log('Giriş gerekiyor'));
bot.on('error',            (err)    => console.error('Hata:', err));
bot.on('rateLimitHit',     (info)   => console.warn('Hız limiti:', info));
bot.on('actionBlocked',    (info)   => console.warn('Engellendi:', info));
bot.on('challengeRequired',()       => console.warn('Doğrulama tetiklendi'));
bot.on('postLiked',        (result) => console.log('Beğenildi:', result));
bot.on('postCommented',    (result) => console.log('Yorum yapıldı:', result));
bot.on('userFollowed',     (result) => console.log('Takip edildi:', result));
bot.on('userUnfollowed',   (result) => console.log('Takipten çıkıldı:', result));
bot.on('postPublished',    (result) => console.log('Yayınlandı:', result));
bot.on('postFailed',       (info)   => console.warn('Gönderi başarısız:', info));
bot.on('storyPublished',   (result) => console.log('Hikaye yayınlandı:', result));
bot.on('storyFailed',      (info)   => console.warn('Hikaye başarısız:', info));
bot.on('profileSetup',     (result) => console.log('Profil güncellendi:', result));
bot.on('postDeleted',      (result) => console.log('Gönderi silindi:', result));
bot.on('dmSent',           (result) => console.log('DM gönderildi:', result));
bot.on('messageReceived',  (msg)    => console.log('Yeni DM:', msg.from, msg.type, msg.sentAt));
bot.on('userMessages',     (grp)    => console.log(`${grp.from}: ${grp.messages.length} yeni`));
bot.on('messageReacted',   (result) => console.log('Tepki verildi:', result.emoji));
bot.on('reelAnalyzed',     (result) => console.log('Reel analiz edildi:', result.shortcode));
```

---

## 🛡️ Tespit Önleme

InstaFlow, tespit riskini azaltmak için birkaç teknik kullanır:

- **Gizlilik bayrakları** — `--disable-blink-features=AutomationControlled`, yamalanmış `navigator.webdriver`
- **Kalıcı Chrome profili** — çalıştırmalar arası aynı parmak izi, taze tarayıcı ipuçları yok
- **İnsan gecikmeleri** — etkileşimler arası yapılandırılabilir rastgele duraklamalar (`humanize: true`)
- **Hız sınırlama** — yerleşik saatlik/günlük limitler ani patlamaları önler
- **Gerçek tarayıcı** — Playwright, Chromium'u sürer; gerçek bir kullanıcı oturumundan ayırt edilemez

> ⚠️ Bu kütüphane kişisel kullanım, araştırma ve test amaçlıdır. Instagram'da otomasyon kullanmak Hizmet Şartları'nı ihlal edebilir. Sorumlu kullan ve riski sana aittir.

---

## 🗂️ Proje Yapısı

```
instaflow/
├── index.js          # Giriş: InstagramBot sınıfı + mixin birleştirme (module.exports)
├── src/              # Uygulama, sorumluluğa göre bölünmüş
│   ├── constants.js  # User-agent, viewport, varsayılan hız limitleri
│   ├── utils.js      # delay() ve paylaşılan yardımcılar
│   ├── auth.js       # init / login / close (tarayıcı yaşam döngüsü)
│   ├── safety.js     # humanize, hız sınırlama, engel tespiti, korumalar
│   ├── content.js    # gönderi / hikaye / profil düzenleme / silme (yayınlama)
│   ├── engagement.js # yorum / beğeni / kaydetme / toplu hashtag beğenme
│   ├── social.js     # takip / takipten çıkma / DM / hikaye etkileşimleri
│   └── insights.js   # profil / gönderi / reel kazıma, arama, gelen kutusu, indirme
├── example.js        # Temel kullanım örneği
├── example_publish.js
├── example_interaction.js
├── tests/
│   ├── run.js        # Test düzenleyici (node tests/run.js)
│   └── test_*.js
└── sessions/         # Chrome profil dizinleri (gitignore'lu)
```

> Genel API tek bir sınıftır (`require('instaflow')`). Dahili olarak `src/` modüllerinden `Object.assign(prototype, ...)` ile oluşturulur, böylece her metot aynı `this`'i paylaşır (page, context, hız sınırlayıcı durumu).

---

## 🤝 Katkıda Bulunma

Pull request'ler memnuniyetle karşılanır. Büyük değişiklikler için lütfen önce bir issue açın.

```bash
git clone https://github.com/alpersamur3/instaflow.git
cd instaflow
npm install
npx playwright install chromium
node tests/run.js
```

---

## 📄 Lisans

[MIT](LICENSE) © 2026 alpersamur3
