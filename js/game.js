/* ============================= توب تن ============================= */
/*
  اللعبة أونلاين فقط: لاعبان، كل واحد من جهازه، والحالة تُبثّ بينهما عبر
  js/net.js. لا يوجد وضع محلي — «دور دور على جهاز واحد» أُزيل عمداً، فكل
  ما في الشاشة الآن يفترض أن الخصم في مكان آخر.

  ⚠️ **الحالة المشتركة صغيرة عمداً.** لا نبثّ القائمة ولا نصوص الإجابات —
  فقط `qId` و**مراكز** ما كُشف ومن كشفه. الجهاز الآخر عنده نفس البنك
  فيعيد البناء. البثّ صار عشرات البايتات بدل كيلوبايتات، والأهم: لا يمكن
  لجهاز أن «يخترع» إجابة ليست في القائمة.
*/

let QUESTIONS = [];
let state = null;        // الحالة المشتركة (تأتي وتذهب عبر الشبكة)
let tickTimer = null;    // مؤقّت العرض المحلي — ليس مصدر الحقيقة
let installPrompt = null;

const PASSES_TO_END = 2;      // تمريران متتاليان يُنهيان الجولة
const TAKEOVER_MS   = 4000;   // مهلة قبل أن يُنهي الخصمُ دورَ الغائب

/* ------------------------------ أدوات ------------------------------ */

const $ = id => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function currentScreen() {
  return document.querySelector('.screen.active')?.id || '';
}

function toast(msg, kind = 'info') {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2600);
}

function questionById(id) { return QUESTIONS.find(q => q.id === id); }

const NET_ERRORS = {
  not_found: 'الروم ما عادت موجودة',
  not_member: 'ما عدت داخل هذي الروم',
  full:       'الروم مكتملة — فيها لاعبان',
  started:    'الجولة بدأت، ما تقدر تدخل الآن',
  no_schema:  'الخادم غير مهيّأ بعد (شغّل supabase-top-ten.sql)',
  bad_token:  'تعذّر التعرّف على الجهاز',
  network:    'تعذّر الاتصال — تأكد من الإنترنت',
  no_client:  'تعذّر الاتصال بالخادم',
  empty:      'ردّ فارغ من الخادم'
};
const netError = code => NET_ERRORS[code] || 'صار خطأ غير متوقّع';

/* ------------------------------ التحميل ------------------------------ */

async function loadQuestions() {
  try {
    const res = await fetch(`data/questions.json?v=6`);
    QUESTIONS = (await res.json()).questions || [];
  } catch (e) {
    console.error('تعذّر تحميل الأسئلة:', e);
    QUESTIONS = [];
  }

  // مجموعات حسب الموضوع: 42 قائمة في لائحة واحدة مسطّحة يصعب تصفّحها
  const sel = $('questionPick');
  const topics = [...new Set(QUESTIONS.map(q => q.topic || 'أخرى'))];
  sel.innerHTML = '<option value="">🎲 قائمة عشوائية</option>' +
    topics.map(t => `<optgroup label="${esc(t)}">` +
      QUESTIONS.filter(q => (q.topic || 'أخرى') === t)
        .map(q => `<option value="${esc(q.id)}">${esc(q.title)}</option>`).join('') +
      '</optgroup>').join('');

  $('qCount').textContent = QUESTIONS.length;
}

/* ------------------------- بناء الحالة واشتقاقها ------------------------- */

function newRoundState(qId, seconds) {
  return {
    phase: 'playing',
    qId,
    seconds,
    turn: Math.random() < 0.5 ? 0 : 1,   // من يبدأ: قرعة
    passes: 0,
    scores: [0, 0],
    found: [],                           // [{ rank, by }]
    deadline: seconds ? Date.now() + seconds * 1000 : 0,
    reason: ''
  };
}

/* القائمة المعروضة تُشتقّ من البنك + مراكز ما كُشف — لا تُبثّ */
function slotsOf(st) {
  const q = questionById(st.qId);
  if (!q) return [];
  return [...q.answers]
    .sort((a, b) => a.rank - b.rank)
    .map(a => {
      const hit = st.found.find(f => f.rank === a.rank);
      return { ...a, found: !!hit, by: hit ? hit.by : null };
    });
}

const isMyTurn = () => state && state.turn === netSeat;

/* ------------------------------ الشاشات ------------------------------ */

function applyRoom(room) {
  state = room.state || null;
  const phase = state?.phase || 'lobby';

  updateNetBadge();

  if (phase === 'lobby') { renderLobby(); showScreen('screen-lobby'); stopTick(); return; }

  if (phase === 'end') {
    stopTick();
    renderEnd();
    showScreen('screen-end');
    return;
  }

  if (!questionById(state.qId)) {   // بنك لم يُحمَّل بعد أو قائمة محذوفة
    toast('تعذّر إيجاد القائمة المطلوبة', 'error');
    return;
  }

  renderGame();
  if (currentScreen() !== 'screen-game') {
    showScreen('screen-game');
    focusAnswer();
  }
  startTick();
}

function renderLobby() {
  $('lobbyCode').textContent = netRoom?.code || '——————';

  const players = netRoom?.players || [];
  $('lobbyPlayers').innerHTML = [0, 1].map(seat => {
    const p = players.find(x => Number(x.seat) === seat);
    if (!p) {
      return `<div class="lp lp-empty">
                <span class="lp-avatar">؟</span>
                <span class="lp-name">بانتظار اللاعب الثاني…</span>
              </div>`;
    }
    return `<div class="lp${seat === netSeat ? ' is-you' : ''}">
              <span class="lp-avatar">${esc(p.name.slice(0, 1))}</span>
              <span class="lp-name">${esc(p.name)}${seat === netSeat ? ' <b>(أنت)</b>' : ''}</span>
              ${seat === 0 ? '<span class="lp-tag">المضيف</span>' : ''}
            </div>`;
  }).join('');

  const host = netIsHost();
  $('hostSetup').hidden = !host;
  $('guestWait').hidden = host;

  if (host) {
    const ready = netPlayerCount() >= 2;
    $('startBtn').disabled = !ready;
    $('startHint').textContent = ready ? '' : 'أرسل الكود لصاحبك — تبدأ الجولة أول ما يدخل';
  }
}

function renderGame() {
  const q = questionById(state.qId);
  $('qTitle').textContent = q.title;
  $('qNote').textContent = q.note || '';
  $('qNote').hidden = !q.note;

  $('scoreboard').innerHTML = [0, 1].map(seat => `
    <div class="pscore${seat === state.turn ? ' is-turn' : ''}${seat === netSeat ? ' is-you' : ''}">
      <span class="pname">${esc(netPlayerName(seat))}${seat === netSeat ? ' (أنت)' : ''}</span>
      <strong class="pval">${state.scores[seat]}</strong>
      ${seat === state.turn ? '<span class="turn-tag">دوره</span>' : ''}
    </div>`).join('');

  const banner = $('turnBanner');
  banner.textContent = isMyTurn() ? '🟢 دورك — اكتب إجابتك'
                                  : `⏳ دور ${netPlayerName(state.turn)}`;
  banner.classList.toggle('mine', isMyTurn());

  const slots = slotsOf(state);
  $('slots').innerHTML = slots.map((slot, i) => {
    if (!slot.found) {
      return `<li class="slot" data-i="${i}">
                <span class="srank">${slot.rank}</span>
                <span class="sdots">• • • • •</span>
                <span class="spts">${slot.rank}</span>
              </li>`;
    }
    return `<li class="slot is-found by-${slot.by === netSeat ? 'me' : 'them'}" data-i="${i}">
              <span class="srank">${slot.rank}</span>
              <span class="sname">${esc(slot.name)}</span>
              <span class="spts">+${slot.rank}</span>
            </li>`;
  }).join('');

  $('progress').textContent = `${slots.filter(s => s.found).length} / 10`;

  // ⚠️ التعطيل ليس تجميلاً: بدونه يكتب الاثنان معاً فتتصادم نسختا الحالة
  const mine = isMyTurn();
  $('answerInput').disabled = !mine;
  $('answerBtn').disabled = !mine;
  $('skipBtn').disabled = !mine;
  $('answerInput').placeholder = mine ? 'اكتب إجابتك…' : 'انتظر دورك…';
}

function renderEnd() {
  const scores = state.scores;
  const mine = scores[netSeat], theirs = scores[netSeat === 0 ? 1 : 0];

  $('endReason').textContent = state.reason || '';
  $('endTitle').textContent = mine === theirs ? '🤝 تعادل'
    : mine > theirs ? '🏆 فزت!' : `😐 فاز ${netPlayerName(netSeat === 0 ? 1 : 0)}`;

  $('endScores').innerHTML = [0, 1].map(seat => `
    <div class="escore${seat === netSeat ? ' is-you' : ''}">
      <span>${esc(netPlayerName(seat))}${seat === netSeat ? ' (أنت)' : ''}</span>
      <strong>${scores[seat]}</strong>
    </div>`).join('');

  const missed = slotsOf(state).filter(s => !s.found);
  $('endMissed').innerHTML = missed.length
    ? `<h3>ما ذكرتوها (${missed.length})</h3>` + missed.map(s =>
        `<div class="mrow"><span class="mrank">${s.rank}</span>${esc(s.name)}</div>`).join('')
    : '<p class="all-found">كشفتم القائمة كاملة 👏</p>';

  $('againBtn').hidden = !netIsHost();
  $('endWait').hidden = netIsHost();
}

function focusAnswer() {
  // ⚠️ لا نركّز على الجوال: فتح لوحة المفاتيح تلقائياً يغطّي نصف اللوحة
  if (isMyTurn() && window.innerWidth > 700) $('answerInput').focus();
}

function updateNetBadge() {
  const badge = $('netBadge');
  const inRoom = !!netRoom?.code;
  const alone = inRoom && netPlayerCount() >= 2 && !netOpponentOnline();
  badge.hidden = !alone;
  if (alone) badge.textContent = `⚠️ ${netPlayerName(netOpponentSeat())} غير متصل`;
}

/* ------------------------------ المؤقّت ------------------------------ */

/*
  ⚠️ **الوقت المشترك هو `deadline` لا عدّاد محلي.** لو عدّ كل جهاز وحده
  لانحرفا: من فتح الصفحة متأخراً يرى وقتاً أطول، ومن جُمّد تبويبه يرى وقتاً
  متوقّفاً. الختم الزمني واحد عند الاثنين، والعرض وحده محلي.
*/
function startTick() {
  stopTick();
  tickTimer = setInterval(tick, 250);
  tick();
}
function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  $('timer').hidden = true;
}

function tick() {
  if (!state || state.phase !== 'playing') return stopTick();

  const el = $('timer');
  if (!state.seconds || !state.deadline) { el.hidden = true; return; }

  const left = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
  el.hidden = false;
  el.textContent = left;
  el.classList.toggle('urgent', left <= 5);

  if (Date.now() < state.deadline) return;

  /*
    انتهى الوقت. صاحب الدور هو من ينفّذ التبديل — فلا يُنفَّذ مرتين.
    ⚠️ وإن كان صاحب الدور غائباً (أغلق الجهاز، أو جُمّد تبويبه) فالجولة
    تتجمّد للأبد. لذلك يتولّاها الخصم بعد مهلة قصيرة.
  */
  const mine = isMyTurn();
  if (mine) {
    toast('⏰ انتهى وقتك', 'warn');
    advanceTurn({ timedOut: true });
  } else if (Date.now() > state.deadline + TAKEOVER_MS) {
    toast(`⏰ انتهى وقت ${netPlayerName(state.turn)}`, 'warn');
    advanceTurn({ timedOut: true });
  }
}

/* ------------------------------ اللعب ------------------------------ */

function submitAnswer(e) {
  e?.preventDefault();
  if (!state || state.phase !== 'playing' || !isMyTurn()) return;

  const input = $('answerInput');
  const raw = input.value.trim();
  if (!raw) return;

  const slots = slotsOf(state);
  const match = bestMatch(raw, slots);

  // ⚠️ المكرّر لا يستهلك الدور: ليس تخميناً خاطئاً، ومعاقبته تُغضب بلا سبب.
  // ولا يُبثّ شيء — الحالة لم تتغيّر أصلاً.
  if (match && slots[match.index].found) {
    toast(`«${slots[match.index].name}» مكشوفة من قبل`, 'warn');
    input.value = '';
    return;
  }

  input.value = '';

  if (!match) {
    toast('لا، مو من القائمة', 'error');
    advanceTurn({});
    return;
  }

  const slot = slots[match.index];
  state.found.push({ rank: slot.rank, by: netSeat });
  state.scores[netSeat] += slot.rank;   // النقاط = رقم المركز
  state.passes = 0;

  toast(`✅ المركز ${slot.rank} — +${slot.rank}`, 'success');
  flashSlot(match.index);

  if (state.found.length === 10) return endRound('اكتملت القائمة 🎉');
  advanceTurn({});
}

function skipTurn() {
  if (!state || state.phase !== 'playing' || !isMyTurn()) return;
  state.passes++;
  if (state.passes >= PASSES_TO_END) return endRound('مرّر اللاعبان');
  toast('مرّرت الدور', 'warn');
  advanceTurn({});
}

/*
  تبديل الدور + البثّ. أي تغيير في الحالة يمرّ من هنا، فلا يبقى تغيير
  محلي لا يراه الخصم.
*/
function advanceTurn({ timedOut }) {
  if (timedOut) state.passes = 0;   // انتهاء الوقت ليس تمريراً
  state.turn = state.turn === 0 ? 1 : 0;
  state.deadline = state.seconds ? Date.now() + state.seconds * 1000 : 0;

  renderGame();
  focusAnswer();
  netPush(state, 'playing');
}

function endRound(reason) {
  stopTick();
  state.phase = 'end';
  state.reason = reason;
  state.deadline = 0;
  renderEnd();
  showScreen('screen-end');
  netPush(state, 'ended');
}

function flashSlot(i) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`.slot[data-i="${i}"]`);
    if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 700); }
  });
}

/* ------------------------------ الروم ------------------------------ */

function startRound() {
  if (!netIsHost()) return;
  if (netPlayerCount() < 2) return toast('لازم لاعبان', 'warn');
  if (!QUESTIONS.length) return toast('ما فيه قوائم محمّلة', 'error');

  const pick = $('questionPick').value;
  const q = pick ? questionById(pick)
                 : QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];

  state = newRoundState(q.id, parseInt($('turnSeconds').value, 10) || 0);
  applyRoom({ ...netRoom, state });
  netPush(state, 'playing');
}

function backToLobby() {
  if (!netIsHost()) return;
  state = { phase: 'lobby' };
  applyRoom({ ...netRoom, state });
  netPush(state, 'waiting');
}

async function createRoom() {
  const name = $('homeName').value.trim();
  if (!name) return toast('اكتب اسمك أولاً', 'warn');

  $('createBtn').disabled = true;
  const data = await netCreateRoom(name);
  $('createBtn').disabled = false;

  if (data.error) return toast(netError(data.error), 'error');
  applyRoom(data);
  toast(`كود الروم: ${data.code}`, 'success');
}

async function joinRoom() {
  const code = $('joinCode').value.trim().toUpperCase();
  const name = $('joinName').value.trim();
  if (code.length !== 6) return toast('الكود ست خانات', 'warn');
  if (!name) return toast('اكتب اسمك أولاً', 'warn');

  $('joinBtn').disabled = true;
  const data = await netJoinRoom(code, name);
  $('joinBtn').disabled = false;

  if (data.error) return toast(netError(data.error), 'error');
  applyRoom(data);
}

async function leaveRoom() {
  stopTick();
  await netLeave();
  state = null;
  $('netBadge').hidden = true;
  goHome();
}

function goHome() {
  showScreen('screen-home');
  $('homeName').value = savedName();
  refreshResumeBox();
}

/* ------------------------------ المشاركة ------------------------------ */

function roomLink() {
  return `${location.origin}${location.pathname}?room=${netRoom?.code || ''}`;
}

async function copyLink() {
  const link = roomLink();
  try {
    await navigator.clipboard.writeText(link);
    toast('نُسخ الرابط ✅', 'success');
  } catch {
    // الحافظة ممنوعة خارج HTTPS — البديل يعمل في كل مكان
    const ta = document.createElement('textarea');
    ta.value = link;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('نُسخ الرابط ✅', 'success');
  }
}

function shareRoom() {
  const text = `العب معي توب تن 🔟\nكود الروم: ${netRoom?.code}\n${roomLink()}`;
  if (navigator.share) {
    navigator.share({ title: 'توب تن', text }).catch(() => {});
  } else {
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }
}

/* ------------------------------ العودة ------------------------------ */

function refreshResumeBox() {
  const s = savedSession();
  const fresh = s && Date.now() - s.at < 6 * 3600 * 1000;
  $('resumeBox').hidden = !fresh;
  if (fresh) $('resumeCode').textContent = s.code;
}

async function resumeSession() {
  const s = savedSession();
  if (!s) return;
  $('resumeBtn').disabled = true;
  const data = await netResume(s.code);
  $('resumeBtn').disabled = false;
  if (data.error) { refreshResumeBox(); return toast(netError(data.error), 'error'); }
  applyRoom(data);
}

/* ------------------------------ التثبيت ------------------------------ */

function wireInstall() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    $('installBtn').hidden = false;
  });

  $('installBtn').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('installBtn').hidden = true;
  });

  window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW:', e));
  }
}

/* ------------------------------ الإقلاع ------------------------------ */

document.addEventListener('DOMContentLoaded', async () => {
  $('year').textContent = new Date().getFullYear();

  onRoomUpdate = applyRoom;
  onNetError = code => { toast(netError(code), 'error'); leaveRoom(); };

  if (!initSupabase()) toast('تعذّر تحميل مكتبة الاتصال', 'error');
  await loadQuestions();

  // الرئيسية
  $('homeName').value = savedName();
  $('createBtn').addEventListener('click', createRoom);
  $('joinOpenBtn').addEventListener('click', () => {
    $('joinName').value = savedName();
    showScreen('screen-join');
    $('joinCode').focus();
  });
  $('resumeBtn').addEventListener('click', resumeSession);
  $('resumeDropBtn').addEventListener('click', () => { forgetSession(); refreshResumeBox(); });

  // الدخول
  $('joinBtn').addEventListener('click', joinRoom);
  $('joinCode').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  $('joinName').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  $('homeName').addEventListener('keydown', e => { if (e.key === 'Enter') createRoom(); });

  // الروم
  $('startBtn').addEventListener('click', startRound);
  $('copyCodeBtn').addEventListener('click', copyLink);
  $('shareBtn').addEventListener('click', shareRoom);

  // اللعب
  $('answerForm').addEventListener('submit', submitAnswer);
  $('skipBtn').addEventListener('click', skipTurn);
  $('againBtn').addEventListener('click', backToLobby);

  document.querySelectorAll('[data-home]').forEach(b => b.addEventListener('click', goHome));
  document.querySelectorAll('[data-leave]').forEach(b => b.addEventListener('click', leaveRoom));

  wireInstall();

  // رابط دعوة: ?room=CODE يملأ الكود ويفتح شاشة الدخول مباشرة
  const invite = new URLSearchParams(location.search).get('room');
  if (invite) {
    history.replaceState({}, '', location.pathname);   // وإلا تكرّر عند التحديث
    $('joinCode').value = invite.toUpperCase().slice(0, 6);
    $('joinName').value = savedName();
    showScreen('screen-join');
    if (savedName()) joinRoom();
    return;
  }

  refreshResumeBox();
  const s = savedSession();
  if (s && Date.now() - s.at < 6 * 3600 * 1000) resumeSession();
});
