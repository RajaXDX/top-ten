/*
  فحص بنك الأسئلة — يُشغَّل: node test-bank.js

  يفحص ثلاثة أشياء لا تظهر بقراءة الملف بالعين:
  1. البنية: 10 إجابات بمراكز 1..10 بلا تكرار، ومعرّف فريد لكل سؤال
  2. **الالتباس داخل القائمة**: هل يطابق اسمُ إجابةٍ إجابةً أخرى في نفس
     القائمة؟ لو حصل فاللاعب الذي يكتب الاسم الصحيح تُرفض إجابته
     (حارس `bestMatch`) — وهذا أسوأ خطأ ممكن.
  3. **الأسماء والمرادفات تُقبل فعلاً**: كل صيغة مكتوبة في البيانات يجب أن
     تصل إلى صاحبتها. مرادف لا يُقبل هو مرادف كاذب.
*/

const fs = require('fs');
const path = require('path');
const { bestMatch, canonical } = require('./js/matching.js');

const bank = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/questions.json'), 'utf8'));
const questions = bank.questions;

let fail = 0;
const bad = (msg) => { console.log('  ✗ ' + msg); fail++; };

/* ---------------------------- 1. البنية ---------------------------- */

const ids = new Set();
for (const q of questions) {
  if (ids.has(q.id)) bad(`معرّف مكرّر: ${q.id}`);
  ids.add(q.id);

  if (!q.title || !q.topic) bad(`${q.id}: عنوان أو موضوع ناقص`);
  if (q.answers.length !== 10) bad(`${q.id}: ${q.answers.length} إجابة لا 10`);

  const ranks = q.answers.map(a => a.rank).sort((x, y) => x - y);
  if (ranks.join(',') !== '1,2,3,4,5,6,7,8,9,10') bad(`${q.id}: مراكز خاطئة (${ranks})`);

  const names = q.answers.map(a => canonical(a.name));
  if (new Set(names).size !== names.length) bad(`${q.id}: اسمان متطابقان بعد التطبيع`);
}

/* --------------------- 2 و 3: المطابقة الفعلية --------------------- */

for (const q of questions) {
  for (const ans of q.answers) {
    const forms = [ans.name, ...(ans.aliases || [])];
    for (const form of forms) {
      const m = bestMatch(form, q.answers);
      if (!m) {
        bad(`${q.id}: «${form}» لا تصل لأي إجابة (المقصود: ${ans.name})`);
      } else if (m.answer.rank !== ans.rank) {
        bad(`${q.id}: «${form}» تذهب لـ«${m.answer.name}» بدل «${ans.name}»`);
      }
    }
  }
}

/* ---------------------------- التقرير ---------------------------- */

const answers = questions.reduce((n, q) => n + q.answers.length, 0);
const aliases = questions.reduce((n, q) =>
  n + q.answers.reduce((k, a) => k + (a.aliases || []).length, 0), 0);
const topics = [...new Set(questions.map(q => q.topic))];

console.log(`\n${questions.length} قائمة · ${answers} إجابة · ${aliases} مرادفاً · ${topics.length} موضوعاً`);
console.log('المواضيع: ' + topics.map(t => `${t} (${questions.filter(q => q.topic === t).length})`).join(' · '));
console.log(fail ? `\n❌ ${fail} مشكلة` : '\n✅ البنك سليم');
process.exit(fail ? 1 : 0);
