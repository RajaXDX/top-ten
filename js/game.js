/* ============================= توب تن ============================= */

let QUESTIONS = [];
let state = null;

const PASSES_TO_END = 2;   // تمريران متتاليان يُنهيان الجولة

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

function toast(msg, kind = 'info') {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2600);
}

/* ------------------------------ التحميل ------------------------------ */

async function loadQuestions() {
  try {
    const res = await fetch('data/questions.json');
    const data = await res.json();
    QUESTIONS = data.questions || [];
  } catch (e) {
    console.error('تعذّر تحميل الأسئلة:', e);
    QUESTIONS = [];
  }

  const sel = $('questionPick');
  sel.innerHTML = '<option value="">🎲 سؤال عشوائي</option>' +
    QUESTIONS.map(q => `<option value="${esc(q.id)}">${esc(q.title)}</option>`).join('');

  $('qCount').textContent = QUESTIONS.length;
}

/* ------------------------------ البدء ------------------------------ */

function startGame() {
  const p1 = $('p1Name').value.trim() || 'اللاعب الأول';
  const p2 = $('p2Name').value.trim() || 'اللاعب الثاني';
  const pickId = $('questionPick').value;
  const seconds = parseInt($('turnSeconds').value, 10) || 0;

  if (!QUESTIONS.length) return toast('ما فيه أسئلة محمّلة', 'error');

  const q = pickId
    ? QUESTIONS.find(x => x.id === pickId)
    : QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];

  state = {
    q,
    players: [{ name: p1, score: 0 }, { name: p2, score: 0 }],
    turn: 0,
    // ⚠️ نسخة مرتّبة بالمركز: البيانات قد تصل غير مرتّبة، والعرض يعتمد الترتيب
    slots: [...q.answers].sort((a, b) => a.rank - b.rank)
      .map(a => ({ ...a, found: false, by: null })),
    passes: 0,
    seconds,
    left: seconds,
    timer: null,
    over: false
  };

  showScreen('screen-game');
  renderGame();
  $('answerInput').focus();
  startTimer();
}

/* ------------------------------ المؤقّت ------------------------------ */

/*
  ⚠️ يُصفَّر ويُعاد تشغيله عند **كل** تبديل دور، ويُفرَّغ عند نهاية الجولة.
  مؤقّت لا يُفرَّغ يبقى يعدّ في الخلفية ويسرق دوراً من الجولة التالية —
  نفس الفخّ الذي وقع في تحدي رجا (البند 29).
*/
function startTimer() {
  clearTimer();
  if (!state || !state.seconds || state.over) return;

  state.left = state.seconds;
  updateTimerUI();
  state.timer = setInterval(() => {
    state.left--;
    updateTimerUI();
    if (state.left <= 0) {
      clearTimer();
      toast(`⏰ انتهى وقت ${state.players[state.turn].name}`, 'warn');
      passTurn(true);
    }
  }, 1000);
}

function clearTimer() {
  if (state?.timer) { clearInterval(state.timer); state.timer = null; }
}

function updateTimerUI() {
  const el = $('timer');
  if (!state?.seconds) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = state.left;
  el.classList.toggle('urgent', state.left <= 5);
}

/* ------------------------------ اللعب ------------------------------ */

function submitAnswer(e) {
  e?.preventDefault();
  if (!state || state.over) return;

  const input = $('answerInput');
  const raw = input.value.trim();
  if (!raw) return;

  const match = bestMatch(raw, state.slots);

  // ⚠️ المكرّر لا يستهلك الدور: ليس تخميناً خاطئاً، ومعاقبته تُغضب بلا سبب
  if (match && state.slots[match.index].found) {
    toast(`«${state.slots[match.index].name}» مكشوفة من قبل`, 'warn');
    input.value = '';
    return;
  }

  input.value = '';

  if (!match) {
    toast('لا، مو من القائمة', 'error');
    passTurn();
    return;
  }

  const slot = state.slots[match.index];
  slot.found = true;
  slot.by = state.turn;

  // النقاط = رقم المركز: المراكز المتأخّرة أصعب تذكّراً فتستحقّ أكثر
  const pts = slot.rank;
  state.players[state.turn].score += pts;
  state.passes = 0;

  toast(`✅ المركز ${slot.rank} — ${pts} ${pts > 10 ? 'نقطة' : 'نقاط'}`, 'success');
  flashSlot(match.index);

  if (state.slots.every(s => s.found)) return endRound('اكتملت القائمة 🎉');
  passTurn();
}

function passTurn(fromTimeout = false) {
  if (!state || state.over) return;
  state.turn = 1 - state.turn;
  renderGame();
  $('answerInput').focus();
  startTimer();
}

function skipTurn() {
  if (!state || state.over) return;
  state.passes++;
  if (state.passes >= PASSES_TO_END) return endRound('مرّر اللاعبان');
  toast('مرّرت الدور', 'warn');
  passTurn();
}

function endRound(reason) {
  clearTimer();
  state.over = true;

  const [a, b] = state.players;
  const winner = a.score === b.score ? null : (a.score > b.score ? a : b);

  $('endReason').textContent = reason;
  $('endTitle').textContent = winner ? `🏆 فاز ${winner.name}` : '🤝 تعادل';
  $('endScores').innerHTML = state.players.map(p =>
    `<div class="escore"><span>${esc(p.name)}</span><strong>${p.score}</strong></div>`).join('');

  const missed = state.slots.filter(s => !s.found);
  $('endMissed').innerHTML = missed.length
    ? `<h3>ما ذكرتوها (${missed.length})</h3>` + missed.map(s =>
        `<div class="mrow"><span class="mrank">${s.rank}</span>${esc(s.name)}</div>`).join('')
    : '<p class="all-found">كشفتم القائمة كاملة 👏</p>';

  showScreen('screen-end');
}

/* ------------------------------ العرض ------------------------------ */

function renderGame() {
  const s = state;
  $('qTitle').textContent = s.q.title;
  $('qNote').textContent = s.q.note || '';
  $('qNote').hidden = !s.q.note;

  $('scoreboard').innerHTML = s.players.map((p, i) => `
    <div class="pscore${i === s.turn ? ' is-turn' : ''}">
      <span class="pname">${esc(p.name)}</span>
      <strong class="pval">${p.score}</strong>
      ${i === s.turn ? '<span class="turn-tag">دوره</span>' : ''}
    </div>`).join('');

  $('slots').innerHTML = s.slots.map((slot, i) => {
    if (!slot.found) {
      return `<li class="slot" data-i="${i}">
                <span class="srank">${slot.rank}</span>
                <span class="sdots">• • • • •</span>
                <span class="spts">${slot.rank}</span>
              </li>`;
    }
    return `<li class="slot is-found by-${slot.by}" data-i="${i}">
              <span class="srank">${slot.rank}</span>
              <span class="sname">${esc(slot.name)}</span>
              <span class="spts">+${slot.rank}</span>
            </li>`;
  }).join('');

  const found = s.slots.filter(x => x.found).length;
  $('progress').textContent = `${found} / 10`;
}

function flashSlot(i) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`.slot[data-i="${i}"]`);
    if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 700); }
  });
}

/* ------------------------------ الإقلاع ------------------------------ */

function backToSetup() {
  clearTimer();
  state = null;
  showScreen('screen-setup');
}

function playAgain() {
  clearTimer();
  startGame();
}

document.addEventListener('DOMContentLoaded', () => {
  loadQuestions();
  $('startBtn').addEventListener('click', startGame);
  $('answerForm').addEventListener('submit', submitAnswer);
  $('skipBtn').addEventListener('click', skipTurn);
  $('endRoundBtn').addEventListener('click', () => endRound('أُنهيت الجولة'));
  $('againBtn').addEventListener('click', playAgain);
  $('setupBtn').addEventListener('click', backToSetup);
  $('year').textContent = new Date().getFullYear();
});
