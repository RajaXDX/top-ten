/* ===================== اتصال Supabase — توب تن ===================== */
/*
  نفس مشروع «تحدي رجا» — وكل جداول توب تن مسبوقة بـ tt_ فلا تتقاطع معه.
  المفتاح العام (publishable) منشور عمداً: هو مصمّم ليُقرأ من المتصفح،
  والحماية في قاعدة البيانات لا فيه (راجع supabase-top-ten.sql).
*/

const SUPABASE_URL = 'https://rqcltlleqpppeywxbkpo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Wtm3EsnJl5CGa8or1egt1g_ZLj_qw6N';

let supa = null;

function initSupabase() {
  if (typeof supabase === 'undefined') {
    console.error('مكتبة Supabase لم تُحمَّل');
    return false;
  }
  // لا نحفظ جلسة ولا نجدّد رمزاً: توب تن بلا حسابات، والعضوية بـ token
  // الجهاز (راجع js/net.js). حفظ الجلسة هنا يكتب في localStorage بلا فائدة.
  supa = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } }
  });
  return true;
}
