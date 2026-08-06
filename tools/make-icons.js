/*
  توليد أيقونات التطبيق — `node tools/make-icons.js`

  الأيقونة نفسها موجودة SVG (assets/icon.svg)، لكن iOS لا يقبل SVG في
  `apple-touch-icon` وبعض أدوات التثبيت تطلب PNG بمقاسات صريحة. وبدل
  إضافة مكتبة رسم للمشروع (وهو مشروع بلا أي اعتماديات عمداً) نرسم الشكل
  هنا حسابياً: دوال مسافة (SDF) + ترميز PNG عبر zlib المدمج في Node.

  ⚠️ الشكل مطابق لـ assets/icon.svg يدوياً — إن غيّرت أحدهما غيّر الآخر.
*/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------------------- ترميز PNG ---------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;   // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // عمق البت
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------------------- دوال المسافة ---------------------------- */

// صندوق بأركان دائرية
function sdRoundBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// كبسولة: قطعة مستقيمة بسماكة
function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/* ---------------------------- الرسم ---------------------------- */

const BG = [0x0D, 0x0D, 0x0F];
const A1 = [0xFF, 0x8A, 0x3D];   // بداية التدرّج
const A2 = [0xFF, 0xC4, 0x6B];   // نهايته

function draw(size) {
  const S = size;
  const px = Buffer.alloc(S * S * 4);
  const SS = 3;   // تنعيم بأخذ 3×3 عيّنات لكل بكسل

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let bg = 0, glyph = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / S;
          const v = (y + (sy + 0.5) / SS) / S;

          if (sdRoundBox(u, v, .5, .5, .5, .5, .22) <= 0) bg++;

          // ١ — عمود بعلم صغير أعلاه
          const one = Math.min(
            sdSegment(u, v, .383, .262, .383, .742, .045),
            sdSegment(u, v, .295, .305, .383, .258, .045)
          );
          // ٠ — حلقة: حدّ صندوق مستدير بسماكة
          const zero = Math.abs(sdRoundBox(u, v, .63, .5, .115, .25, .115)) - .045;

          if (Math.min(one, zero) <= 0) glyph++;
        }
      }

      const total = SS * SS;
      const i = (y * S + x) * 4;
      const gA = glyph / total;
      const t = (x / S + y / S) / 2;                    // تدرّج قطري
      const gc = [0, 1, 2].map(k => A1[k] + (A2[k] - A1[k]) * t);

      for (let k = 0; k < 3; k++) px[i + k] = Math.round(BG[k] * (1 - gA) + gc[k] * gA);
      px[i + 3] = Math.round(255 * (bg / total));
    }
  }
  return encodePNG(S, S, px);
}

const out = path.join(__dirname, '..', 'assets');
for (const size of [180, 192, 512]) {
  const file = path.join(out, `icon-${size}.png`);
  fs.writeFileSync(file, draw(size));
  console.log(`assets/icon-${size}.png — ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
}
