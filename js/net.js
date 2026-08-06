/* ========================= طبقة الشبكة — توب تن ========================= */
/*
  كل ما يمرّ بين الجهازين يمرّ من هنا. اللعبة نفسها (game.js) لا تعرف
  Supabase إطلاقاً — تنادي `netPush(state)` وتتلقّى `onRoomUpdate(room)`.

  مساران متوازيان عمداً:

  1. **البثّ (broadcast)** — القناة `tt-CODE`. سريع (عشرات الأجزاء من
     الثانية) ولا يمسّ قاعدة البيانات ولا RLS. هذا هو المسار الطبيعي.
  2. **الكتابة في الجدول عبر RPC** — أبطأ، لكنه ما يبقى: من يحدّث الصفحة
     أو ينقطع اتصاله يستعيد الجولة من حيث كانت.

  ⚠️ **البثّ وحده لا يكفي، والجدول وحده لا يكفي.** البثّ لا يصل لمن لم يكن
  مشتركاً لحظة الإرسال (المنقطع، والداخل متأخراً)، والاستعلام وحده يفرض
  استطلاعاً كثيفاً ليبدو لحظياً. فنحن نبثّ **ونكتب** في كل تغيير، ونستطلع
  الجدول كل 4 ثوانٍ كشبكة أمان لا كمصدر أول.
*/

const TT_TOKEN_KEY   = 'tt_device_token';
const TT_SESSION_KEY = 'tt_session';       // آخر روم — للعودة التلقائية
const TT_NAME_KEY    = 'tt_player_name';

const POLL_MS      = 4000;   // شبكة الأمان
const HEARTBEAT_MS = 20000;  // إثبات الحضور (الغياب بعد 45 ثانية في SQL)

let netRoom     = null;   // آخر صورة للروم من الخادم
let netSeat     = null;   // مقعدك: 0 أو 1
let netChannel  = null;
let netPollTimer = null;
let netBeatTimer = null;
let netVersion  = 0;

/* دالة يضبطها game.js لتصلها كل صورة جديدة للروم */
let onRoomUpdate = () => {};
let onNetError   = () => {};

/* ------------------------------ الهوية ------------------------------ */

/*
  توكن الجهاز = عضويتك. يُولَّد مرة ويبقى، فتحديث الصفحة يعيدك لمقعدك
  ونقاطك بدل أن يُدخلك لاعباً ثالثاً.
  ⚠️ لا تستعمل `crypto.randomUUID` وحدها: غير متاحة على http بلا شهادة
  في بعض المتصفحات، والاختبار المحلي يمرّ على http.
*/
function deviceToken() {
  let t = localStorage.getItem(TT_TOKEN_KEY);
  if (!t) {
    t = (crypto.randomUUID ? crypto.randomUUID() :
         'tt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) +
         Math.random().toString(36).slice(2));
    localStorage.setItem(TT_TOKEN_KEY, t);
  }
  return t;
}

function savedName()      { return localStorage.getItem(TT_NAME_KEY) || ''; }
function rememberName(n)  { localStorage.setItem(TT_NAME_KEY, n); }

function savedSession() {
  try { return JSON.parse(localStorage.getItem(TT_SESSION_KEY) || 'null'); }
  catch { return null; }
}
function rememberSession(code) {
  localStorage.setItem(TT_SESSION_KEY, JSON.stringify({ code, at: Date.now() }));
}
function forgetSession() { localStorage.removeItem(TT_SESSION_KEY); }

/* ------------------------------ النداء ------------------------------ */

async function rpc(fn, args) {
  if (!supa) return { error: 'no_client' };
  try {
    const { data, error } = await supa.rpc(fn, args);
    if (error) {
      console.error(`RPC ${fn}:`, error.message);
      // 404 على الدالة يعني أن سكربت SQL لم يُشغَّل بعد — رسالة مفهومة أهم
      return { error: /function|schema cache/i.test(error.message) ? 'no_schema' : 'network' };
    }
    return data || { error: 'empty' };
  } catch (e) {
    console.error(`RPC ${fn} استثناء:`, e);
    return { error: 'network' };
  }
}

/* يُستدعى بعد كل ردّ يحمل صورة روم */
function adoptRoom(data) {
  if (!data || data.error) return data;
  netRoom = data;
  if (typeof data.you === 'number') netSeat = data.you;
  // ⚠️ نأخذ الأعلى لا الوارد: ردّ متأخر قد يحمل نسخة أقدم مما عندنا
  netVersion = Math.max(netVersion, data.version || 0);
  onRoomUpdate(netRoom);
  return data;
}

/* ------------------------------ الرومات ------------------------------ */

async function netCreateRoom(name) {
  rememberName(name);
  const data = await rpc('tt_create_room', { p_name: name, p_token: deviceToken() });
  if (data.error) return data;
  netVersion = 0;
  adoptRoom(data);
  rememberSession(data.code);
  await netConnect(data.code);
  return data;
}

async function netJoinRoom(code, name) {
  rememberName(name);
  const data = await rpc('tt_join_room', {
    p_code: code, p_name: name, p_token: deviceToken()
  });
  if (data.error) return data;
  netVersion = data.version || 0;
  adoptRoom(data);
  rememberSession(data.code);
  await netConnect(data.code);
  return data;
}

/* عودة صامتة لروم محفوظة — تفشل بهدوء إن كانت انتهت */
async function netResume(code) {
  const data = await rpc('tt_snapshot', { p_code: code, p_token: deviceToken() });
  if (data.error) { forgetSession(); return data; }
  netVersion = data.version || 0;
  adoptRoom(data);
  await netConnect(code);
  return data;
}

async function netLeave() {
  const code = netRoom?.code;
  netDisconnect();
  forgetSession();
  netRoom = null; netSeat = null; netVersion = 0;
  if (code) await rpc('tt_leave', { p_code: code, p_token: deviceToken() });
}

/* ------------------------------ الاتصال ------------------------------ */

async function netConnect(code) {
  netDisconnect();

  netChannel = supa.channel(`tt-${code}`, { config: { broadcast: { self: false } } });

  netChannel.on('broadcast', { event: 'state' }, ({ payload }) => {
    if (!payload) return;
    // ⚠️ نسخة أقدم أو مساوية تُهمَل: البثّ قد يصل بغير ترتيبه، وتطبيق
    // القديمة يُرجع الجولة خطوة للوراء أمام اللاعب.
    if ((payload.version || 0) <= netVersion) return;
    netVersion = payload.version;
    netRoom = { ...netRoom, ...payload, you: netSeat };
    onRoomUpdate(netRoom);
  });

  await netChannel.subscribe();

  clearInterval(netPollTimer);
  netPollTimer = setInterval(netPoll, POLL_MS);
  clearInterval(netBeatTimer);
  netBeatTimer = setInterval(netPoll, HEARTBEAT_MS);
}

function netDisconnect() {
  clearInterval(netPollTimer); netPollTimer = null;
  clearInterval(netBeatTimer); netBeatTimer = null;
  if (netChannel) { supa?.removeChannel(netChannel); netChannel = null; }
}

/*
  الاستطلاع يثبت الحضور أيضاً (`tt_snapshot` تكتب `seen`)، فهو نبضة
  ومزامنة في نداء واحد.
  ⚠️ لا نستطلع والصفحة في الخلفية: متصفح الجوال يجمّد المؤقتات أصلاً،
  والنداءات المتراكمة تنفجر دفعة واحدة عند العودة.
*/
async function netPoll() {
  if (!netRoom?.code || document.hidden) return;
  const data = await rpc('tt_snapshot', { p_code: netRoom.code, p_token: deviceToken() });
  if (data.error) {
    if (data.error === 'not_found' || data.error === 'not_member') {
      onNetError(data.error);
      netDisconnect();
      forgetSession();
    }
    return;
  }
  if ((data.version || 0) < netVersion) {
    // عندنا أحدث ممّا في الجدول (بثّ وصل قبل أن تُكتب الكتابة) — لا نتراجع
    netRoom = { ...data, state: netRoom.state, version: netVersion, you: netSeat };
    onRoomUpdate(netRoom);
    return;
  }
  adoptRoom(data);
}

/* عودة من الخلفية: نبضة فورية، وإلا بدا اللاعب غائباً وقد رجع */
document.addEventListener('visibilitychange', () => { if (!document.hidden) netPoll(); });

/* ------------------------------ الدفع ------------------------------ */

/*
  ترتيب مقصود: **نبثّ أولاً ثم نكتب**. البثّ هو ما يراه الخصم، والكتابة
  للبقاء. لو انتظرنا الكتابة لَتأخّر ظهور الإجابة عنده نصف ثانية بلا سبب.
*/
async function netPush(state, status) {
  if (!netRoom?.code) return;

  netVersion++;
  const payload = { state, status: status || netRoom.status, version: netVersion };

  netRoom = { ...netRoom, ...payload };
  netChannel?.send({ type: 'broadcast', event: 'state', payload });

  const data = await rpc('tt_push', {
    p_code: netRoom.code, p_token: deviceToken(),
    p_state: state, p_status: status || '', p_version: netVersion
  });

  // رُفضت لقِدَمها: الخصم كتب قبلنا. نأخذ نسخته ونعرضها بدل أن نصرّ على نسختنا.
  if (data && !data.error && data.stale) {
    netVersion = data.version || netVersion;
    adoptRoom(data);
  }
}

function netPlayerName(seat) {
  return netRoom?.players?.find(p => Number(p.seat) === Number(seat))?.name || `لاعب ${seat + 1}`;
}
function netOpponentSeat() { return netSeat === 0 ? 1 : 0; }
function netIsHost()       { return netSeat === 0; }
function netPlayerCount()  { return netRoom?.players?.length || 0; }
function netOpponentOnline() {
  const p = netRoom?.players?.find(x => Number(x.seat) === netOpponentSeat());
  return !!p?.online;
}
