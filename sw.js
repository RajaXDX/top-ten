/* ===================== عامل الخدمة — توب تن ===================== */
/*
  اللعبة أونلاين، فالهدف من الـ SW ليس اللعب بلا إنترنت — بل:
  · التثبيت على الشاشة الرئيسية (شرط لازم لـ PWA)
  · فتح فوري بلا انتظار الشبكة لقشرة التطبيق
  · شاشة مفهومة بدل خطأ المتصفح إن انقطع الإنترنت

  ⚠️ **لا يُلمس أي طلب لغير أصلنا**: نداءات Supabase ومكتبتها والخطوط تمرّ
  للشبكة كما هي. تخزين ردّ RPC مؤقتاً يعني عرض حالة روم قديمة على أنها
  الحاليّة — وهو أسوأ من انقطاع صريح.
*/

const VERSION = 'tt-v6';
const SHELL = [
  './',
  'index.html',
  'play.html',
  'manifest.json',
  'css/style.css?v=6',
  'css/landing.css?v=6',
  'js/matching.js?v=6',
  'js/net.js?v=6',
  'js/game.js?v=6',
  'js/supabase-config.js?v=6',
  'data/questions.json?v=6',
  'assets/icon.svg'
];

self.addEventListener('install', e => {
  // addAll تفشل كلها لو فشل ملف واحد — نضيف كلاً على حدة حتى لا يسقط
  // التثبيت بسبب أصل واحد مفقود
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Supabase والخطوط: لا تُلمس

  const isPage = req.mode === 'navigate' || req.destination === 'document';

  if (isPage) {
    // الشبكة أولاً: نسخة قديمة من الصفحة قد تحمّل ملفات لم تعد موجودة
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('play.html')))
    );
    return;
  }

  // الأصول: من الكاش فوراً، والتحديث في الخلفية للمرة القادمة
  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
