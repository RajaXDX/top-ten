/* ===================== مطابقة الإجابات العربية ===================== */
/*
  قلب اللعبة. اللاعب يكتب من ذاكرته، لا يختار من قائمة — فالمطابقة هي
  الفرق بين لعبة ممتعة ولعبة تُغضب.

  خطأ من نوعين، وكلفتهما ليست متساوية:
  · **رفض إجابة صحيحة** — اللاعب يعرف أنه محقّ ويخسر دوره. مُحبط، ويُفقد
    الثقة باللعبة فوراً.
  · **قبول إجابة خاطئة** — يمرّ غالباً بلا أن ينتبه أحد.
  لذلك التساهل مقصود، مع حاجز واحد صارم: لا نقبل إجابةً تُشبه **إجابةً
  أخرى في نفس القائمة** أكثر مما تشبه المقصودة (راجع `bestMatch`).
*/

/* ------------------------------ التطبيع ------------------------------ */

const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL  = /ـ/g;

/*
  ⚠️ الترتيب مقصود: نحذف التشكيل **قبل** توحيد الحروف، وإلا بقيت الهمزة
  المركّبة على حرف مشكّل بلا توحيد.
*/
function normalizeArabic(s) {
  return String(s ?? '')
    .replace(TASHKEEL, '')
    .replace(TATWEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')   // ترقيم وشرطات ← مسافة
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/*
  ⚠️ **لا قائمة كلمات محذوفة — جُرّبت وكانت كارثية.**

  كانت `STOP_WORDS` تحذف الكلمات «غير المميّزة» (دولة، جمهورية، مملكة،
  ولايات…) لتقبل «دولة الصين» على «الصين». والنتيجة في قائمة أقوى الدول:

      «الولايات المتحدة» ← تُحذف «ولايات» ← تبقى «متحده»
      «المملكة المتحدة»  ← تُحذف «مملكه»  ← تبقى «متحده»
      → متطابقتان بدرجة **1.0**

  فمن يكتب «المملكة المتحدة» يأخذ نقاط أمريكا. الكلمة التي ظننتها حشواً
  هي بالضبط الكلمة المميّزة، والحذف أتلف الفرق الوحيد بين الإجابتين.
  التغطية الجزئية في `scoreAgainst` تكفي لحالة «دولة الصين» بلا حذف شيء.

  ⚠️ و«ال» التعريف تُحذف من أول الكلمة لا من وسطها، وبشرط طول > 3 حتى لا
  تُفرَّغ كلمة قصيرة.
*/
function stripArabicArticle(word) {
  return word.length > 3 && word.startsWith('ال') ? word.slice(2) : word;
}

function tokens(s) {
  return normalizeArabic(s)
    .split(' ')
    .map(stripArabicArticle)
    .filter(Boolean);
}

function canonical(s) {
  return tokens(s).join(' ');
}

/* ------------------------------ التشابه ------------------------------ */

// مسافة ليفنشتاين بسطرين — تكفي لسلاسل قصيرة ولا تحتاج مصفوفة كاملة
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  const d = editDistance(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

/*
  عتبة التشابه تتناسب مع طول الكلمة.

  ⚠️ عتبة ثابتة تفشل في الطرفين: 0.8 على كلمة من 4 أحرف تسمح بخطأ حرف
  واحد — و«مصر» و«قطر» تشابههما 0.67 فتقتربان خطراً؛ وعلى كلمة من 15 حرفاً
  تسمح بثلاثة أخطاء وهو كرم زائد. فالكلمة القصيرة تتطلّب تطابقاً شبه تام.
*/
function similarEnough(a, b) {
  const len = Math.max(a.length, b.length);
  if (len <= 4) return a === b;              // قصيرة: تطابق تام
  const allowed = len <= 7 ? 1 : len <= 12 ? 2 : 3;
  return editDistance(a, b) <= allowed;
}

/* ------------------------------ المطابقة ------------------------------ */

/*
  هل يطابق ما كتبه اللاعب هذه الإجابة (باسمها أو أي مرادف لها)؟
  يرجع درجة 0..1 — والصفر يعني لا.
*/
function scoreAgainst(input, answer) {
  const inCanon = canonical(input);
  if (!inCanon) return 0;

  const forms = [answer.name, ...(answer.aliases || [])];
  let best = 0;

  for (const form of forms) {
    const canon = canonical(form);
    if (!canon) continue;

    if (inCanon === canon) return 1;

    // تطابق تقريبي على النصّ الكامل
    if (similarEnough(inCanon, canon)) best = Math.max(best, 0.92);

    /*
      ⚠️ **الاحتواء بالكلمات لا بالنصّ**: `includes` النصّي يجعل «ان»
      تطابق «اليابان»، وحرفين يكسبان عشر نقاط. المقارنة بالكلمات الكاملة
      تمنع ذلك.
    */
    const inWords = tokens(input);
    const ansWords = tokens(form);
    if (inWords.length && ansWords.length) {
      const hit = inWords.filter(w => ansWords.some(a => similarEnough(w, a)));
      const cover = ansWords.filter(a => inWords.some(w => similarEnough(w, a))).length / ansWords.length;

      /*
        ⚠️ **التغطية شرط دائماً — ولو طابقت كل كلمات المدخل.**
        كانت القاعدة «كل كلمات المدخل طابقت + إحداها ≥ 4 أحرف» تكفي وحدها،
        فكلمة «جمهورية» تكسب نقاط «جمهورية الصين الشعبية»: طابقت كل ما
        كُتب (كلمة واحدة)، وهي طويلة. لكنها **وصف لا تعريف** — ثلثا
        الإجابة غائبان.

        📌 والأسماء القصيرة الشائعة («السعودية» لـ«المملكة العربية
        السعودية») مكانها `aliases` في بيانات السؤال، لا استثناء في
        المطابق. البيانات تحمل المعرفة، والمطابق يبقى متحفّظاً.
      */
      if (hit.length === inWords.length && cover >= 0.5 && hit.some(w => w.length >= 4)) {
        best = Math.max(best, 0.85);
      }
      if (cover >= 0.6 && hit.length) best = Math.max(best, 0.7 + cover * 0.15);
    }

    if (best < 0.9) best = Math.max(best, similarity(inCanon, canon) >= 0.86 ? 0.8 : 0);
  }
  return best;
}

/*
  أفضل إجابة تطابق ما كُتب، من بين إجابات هذا السؤال.

  ⚠️ **المقارنة على مستوى القائمة لا الإجابة الواحدة.** لو قِيست كل إجابة
  وحدها لقبلنا «الصين» على «الهند» في قائمة فيها الاثنتان متى تجاوزت
  العتبة. هنا نأخذ الأعلى، ونرفض إن كان الثاني قريباً منه جداً — لأن
  الالتباس عندئذٍ حقيقي ولا يجوز الحدس فيه.
*/
function bestMatch(input, answers) {
  const scored = answers
    .map((a, i) => ({ index: i, answer: a, score: scoreAgainst(input, a) }))
    .filter(r => r.score > 0)
    .sort((x, y) => y.score - x.score);

  if (!scored.length) return null;
  const [top, second] = scored;

  if (top.score < 0.7) return null;
  if (second && top.score - second.score < 0.06 && top.score < 1) return null;  // التباس

  return top;
}

if (typeof module !== 'undefined') {
  module.exports = { normalizeArabic, canonical, tokens, editDistance, similarity, similarEnough, scoreAgainst, bestMatch };
}
