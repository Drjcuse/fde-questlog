'use strict';

/* FDE QuestLog. Vanilla JS, no build step.
   Reads data/state.json, data/quest-data.json and data/srs-queue.json.
   Writes nothing to the repo: the check-in leaves the page as a pre-filled
   GitHub Issue (or a copied token) and the nightly task applies it. */

const TREES = {
  python: 'Unaided Python & Agent Glue',
  aws: 'AWS SAA-C03',
  wargames: 'FDE War-Games'
};
const TIER_ORDER = ['quick', 'standard', 'double'];
const TIER_LABEL = { quick: 'Quick Daily', standard: 'Standard Dungeon', double: 'Double Dungeon' };
const MODIFIER_XP = 25;
const TREE_LEVEL_XP = 250;
const TREE_LEVEL_MAX = 10;

/* "cited" = published research on learning in general.
   "design" = a design decision; no study is claimed for it. */
const WHY_RULES = [
  { kind: 'cited', rule: 'Retrieval practice over reading',
    how: 'Every day opens with a 3-minute warmup of past items. No entry is "read this article".',
    basis: 'Roediger & Karpicke (2006), test-enhanced learning; Dunlosky et al. (2013), practice testing rated high utility.' },
  { kind: 'cited', rule: 'Spaced, not massed',
    how: 'Missed items come back after 1, 3, 7 and 21 days.',
    basis: 'Dunlosky et al. (2013), distributed practice rated high utility. The exact 1/3/7/21 steps are a design choice.' },
  { kind: 'cited', rule: 'Faded worked examples over cold shock',
    how: 'Trace and explain, then fix one bug, then fill missing lines, then half a skeleton, then a blank file.',
    basis: 'Sweller (2011), cognitive load theory and the worked-example effect.' },
  { kind: 'design', rule: 'Zero shame, no streak resets',
    how: 'A missed day never removes XP or levels. It arms Rested XP: the next quest pays double.',
    basis: 'Design rule. Analogous to the abstinence-violation effect (Marlatt & Gordon, 1985): one lapse read as total failure leads to quitting. Not tested on this app or on ADHD specifically.' },
  { kind: 'design', rule: 'Energy-adaptive floor',
    how: 'Three tiers on one screen: 15, 45 or 90 minutes. A 15-minute day still counts as a check-in.',
    basis: 'Design rule: lower the cost of starting on low-energy days. No study is claimed.' },
  { kind: 'design', rule: 'Immediate binary feedback',
    how: 'Every quest has a done-condition you can check yourself, and the XP bar moves when you check in.',
    basis: 'Design rule. Feedback helps learning in general; the XP animation is motivation, not evidence.' },
  { kind: 'design', rule: 'Single surface',
    how: 'Everything for the day is on this page, on phone and desktop.',
    basis: 'Design rule: fewer places to open means fewer chances to drift.' }
];

const S = {
  state: null, quest: null, queue: null,
  tier: 'quick', mods: new Set(), ratings: {}, done: {},
  timerId: null, timerLeft: 0
};

const $ = (sel, root = document) => root.querySelector(sel);

function esc(value) {
  return String(value).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

const charLevel = xp => Math.floor(Math.sqrt(xp / 100)) + 1;
const levelFloorXp = level => 100 * (level - 1) * (level - 1);
const treeLevel = xp => Math.min(TREE_LEVEL_MAX, Math.floor(xp / TREE_LEVEL_XP) + 1);

async function loadJson(name) {
  const res = await fetch(`data/${name}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`data/${name}.json returned HTTP ${res.status}`);
  return res.json();
}

/* ---------- XP ---------- */

function projectedXp() {
  const base = S.quest.tiers[S.tier].xp;
  const multiplier = S.state.rested_xp_active ? 2 : 1;
  return base * multiplier + MODIFIER_XP * S.mods.size;
}

/* ---------- Character sheet ---------- */

function renderSheet(pendingXp = 0) {
  const st = S.state;
  const total = st.total_xp + pendingXp;
  const level = charLevel(total);
  const floor = levelFloorXp(level);
  const next = levelFloorXp(level + 1);
  const pct = Math.round(((total - floor) / (next - floor)) * 100);
  const rested = st.rested_xp_active;
  const title = st.titles.length ? st.titles[st.titles.length - 1] : 'No title yet';

  const trees = Object.keys(TREES).map(key => {
    const xp = st.trees[key].xp;
    const lvl = treeLevel(xp);
    const treePct = lvl >= TREE_LEVEL_MAX ? 100 : Math.round(((xp % TREE_LEVEL_XP) / TREE_LEVEL_XP) * 100);
    return `<div>
      <div class="tree-row"><span>${esc(TREES[key])}</span><span>Lv ${lvl} · ${xp} XP</span></div>
      <div class="bar small tree-${key}"><span data-w="${treePct}"></span></div>
    </div>`;
  }).join('');

  $('#sheet').innerHTML = `
    <div class="sheet-head">
      <span class="level" id="char-level">Level ${level}</span>
      <span class="title-badge">${esc(title)}</span>
    </div>
    <div class="bar ${rested ? 'rested' : ''}" id="xp-bar"><span data-w="${pct}"></span></div>
    <div class="muted"><span id="xp-total">${total}</span> XP · ${next - total} to Level ${level + 1}${pendingXp ? ' · pending nightly sync' : ''}</div>
    ${rested ? '<span class="rested-badge" id="rested-badge">Rested XP active: next quest pays 2x</span>' : ''}
    <div class="trees">${trees}</div>
    <div class="stats muted">
      <span>Day ${S.quest.day} of 21</span>
      <span>${st.days_checked_in} of 21 checked in (target 15)</span>
    </div>`;

  requestAnimationFrame(() => {
    document.querySelectorAll('#sheet .bar > span').forEach(span => {
      span.style.width = `${span.dataset.w}%`;
    });
  });
}

/* ---------- Warmup ---------- */

function dueCards() {
  return S.queue.items.filter(item => item.due_date <= S.quest.date).slice(0, 4);
}

function renderWarmup() {
  const cards = dueCards();
  const body = cards.length
    ? cards.map(card => `
      <div class="card" data-card="${esc(card.id)}">
        <span class="tag tree-${esc(card.tree)}">${esc(card.tree)}</span>
        <p>${esc(card.q)}</p>
        <details><summary>Show answer (say yours out loud first)</summary>
          <p class="answer">${esc(card.a)}</p>
        </details>
        <div class="rate">
          <button type="button" data-rate="nailed">Nailed It</button>
          <button type="button" data-rate="shaky">Shaky</button>
          <button type="button" data-rate="blanked">Blanked</button>
        </div>
      </div>`).join('')
    : '<p class="muted">No cards due today. New cards arrive from tonight\'s build.</p>';

  $('#warmup').innerHTML = `
    <h2>1. Spaced-Retrieval Warmup · 3 min</h2>
    <p class="muted">Answer from memory before opening the answer. Rate honestly: the rating sets when the card returns.</p>
    <div class="cards">${body}</div>`;

  $('#warmup').addEventListener('click', event => {
    const btn = event.target.closest('button[data-rate]');
    if (!btn) return;
    const card = btn.closest('[data-card]');
    S.ratings[card.dataset.card] = btn.dataset.rate;
    card.querySelectorAll('button[data-rate]').forEach(b => b.classList.toggle('on', b === btn));
    renderCheckinSummary();
  });
}

/* ---------- Intel ---------- */

function renderIntel() {
  const intel = S.quest.intel;
  $('#intel').innerHTML = `
    <div class="intel">
      <h2>2. Tactical Intel · 3 min</h2>
      <h3>${esc(intel.title)}</h3>
      <ul>${intel.bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>
      <p>Source: <a id="intel-source" href="${esc(intel.source.url)}" target="_blank" rel="noopener">${esc(intel.source.title)}</a></p>
      <p class="why">Why this pays off: ${esc(intel.why)}</p>
      <div class="card">
        <p><strong>Check:</strong> ${esc(intel.question.q)}</p>
        <details><summary>Show answer</summary><p class="answer">${esc(intel.question.a)}</p></details>
        <p class="muted">This question returns in your warmup in 3 days.</p>
      </div>
    </div>`;
}

/* ---------- Quests ---------- */

function questsForTier(tier) {
  const upTo = TIER_ORDER.indexOf(tier);
  return TIER_ORDER.slice(0, upTo + 1).flatMap(name => S.quest.tiers[name].quests);
}

function codeBlock(code) {
  const lines = code.split('\n').map((line, i) =>
    `<span class="ln">${i + 1}</span>${esc(line)}`).join('\n');
  return `<pre><code>${lines}</code></pre>`;
}

function renderQuest(q) {
  return `
    <article class="quest" data-quest="${esc(q.id)}">
      <header>
        <span class="tag tree-${esc(q.tree)}">${esc(q.tree)}</span>
        <h3>${esc(q.title)}</h3>
        <span class="mins">${q.minutes} min</span>
      </header>
      <p>${esc(q.brief)}</p>
      ${q.code ? codeBlock(q.code) + '<button type="button" data-copy-code>Copy code</button>' : ''}
      <ol>${q.tasks.map(t => `<li>${esc(t)}</li>`).join('')}</ol>
      <p class="done-when"><strong>Done when:</strong> ${esc(q.done_condition)}</p>
      ${q.answer_key ? `<details><summary>Answer key (open only after you have committed to an answer)</summary>
        <ul>${q.answer_key.map(a => `<li>${esc(a)}</li>`).join('')}</ul></details>` : ''}
      <label class="done-check"><input type="checkbox" data-done="${esc(q.id)}" ${S.done[q.id] ? 'checked' : ''}> Done-condition met</label>
    </article>`;
}

function renderQuests() {
  const tabs = TIER_ORDER.map(name => {
    const t = S.quest.tiers[name];
    return `<button type="button" data-tier="${name}" class="${name === S.tier ? 'on' : ''}">
      ${TIER_LABEL[name]}<br>${t.minutes} min · ${t.xp} XP</button>`;
  }).join('');
  const tier = S.quest.tiers[S.tier];

  $('#quests').innerHTML = `
    <h2>3. Today's Quest · ${esc(S.quest.date)}</h2>
    <div class="tabs" role="tablist">${tabs}</div>
    <div class="timer">
      <span class="clock" id="clock">${fmtClock(tier.minutes * 60)}</span>
      <button type="button" id="timer-btn">Start timer</button>
    </div>
    <div id="quest-list">${questsForTier(S.tier).map(renderQuest).join('')}</div>`;
}

function bindQuests() {
  $('#quests').addEventListener('click', event => {
    const tab = event.target.closest('button[data-tier]');
    if (tab) {
      S.tier = tab.dataset.tier;
      stopTimer();
      renderQuests();
      renderCheckinSummary();
      return;
    }
    if (event.target.id === 'timer-btn') { toggleTimer(); return; }
    const copyBtn = event.target.closest('button[data-copy-code]');
    if (copyBtn) {
      const id = copyBtn.closest('[data-quest]').dataset.quest;
      const quest = questsForTier('double').find(q => q.id === id);
      copyText(quest.code, copyBtn, 'Copy code');
    }
  });
  $('#quests').addEventListener('change', event => {
    const box = event.target.closest('input[data-done]');
    if (!box) return;
    S.done[box.dataset.done] = box.checked;
    renderCheckinSummary();
  });
}

/* ---------- Timer ---------- */

function fmtClock(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function stopTimer() {
  if (S.timerId) clearInterval(S.timerId);
  S.timerId = null;
}

function toggleTimer() {
  if (S.timerId) {
    stopTimer();
    $('#timer-btn').textContent = 'Resume timer';
    return;
  }
  if (S.timerLeft <= 0) S.timerLeft = S.quest.tiers[S.tier].minutes * 60;
  $('#timer-btn').textContent = 'Pause timer';
  S.timerId = setInterval(() => {
    S.timerLeft -= 1;
    const clock = $('#clock');
    if (clock) clock.textContent = fmtClock(Math.max(0, S.timerLeft));
    if (S.timerLeft <= 0) {
      stopTimer();
      const btn = $('#timer-btn');
      if (btn) btn.textContent = 'Time. Check in below.';
    }
  }, 1000);
}

/* ---------- Check-in ---------- */

function buildPayload() {
  const tierQuests = questsForTier(S.tier);
  const done = {};
  tierQuests.forEach(q => { done[q.id] = Boolean(S.done[q.id]); });
  const payload = {
    v: 1,
    date: S.quest.date,
    day: S.quest.day,
    tier: S.tier,
    modifiers: Array.from(S.mods).sort(),
    srs: { ...S.ratings },
    done,
    stuck_on: ($('#note') ? $('#note').value : '').trim()
  };
  const score = $('#td-score') ? $('#td-score').value.trim() : '';
  const missed = $('#td-missed') ? $('#td-missed').value.trim() : '';
  if (score || missed) payload.td = { score, missed };
  return payload;
}

function issueUrl() {
  const { owner, repo } = S.state;
  const title = encodeURIComponent(`Check-In ${S.quest.date}`);
  const body = encodeURIComponent(JSON.stringify(buildPayload()));
  return `https://github.com/${owner}/${repo}/issues/new?labels=checkin&title=${title}&body=${body}`;
}

function renderCheckin() {
  $('#checkin').innerHTML = `
    <h2>4. Complete & Check In</h2>
    <div class="mods">
      <label><input type="checkbox" data-mod="neovim"> Hard Mode (+25 XP): did today's Python or CLI drill in Neovim, no AI completion</label>
      <label><input type="checkbox" data-mod="remarkable"> Architect's Ink (+25 XP): sketched today's architecture or incident from memory on the reMarkable</label>
    </div>
    <div class="field">
      <label for="note">One line: what were you stuck on?</label>
      <textarea id="note" rows="2" maxlength="300" placeholder="e.g. stuck on JSONDecodeError fallback; missed S3 gateway vs interface endpoint"></textarea>
    </div>
    <div class="field">
      <label for="td-score">Tutorials Dojo score (optional)</label>
      <input id="td-score" maxlength="20" placeholder="e.g. 12/20">
    </div>
    <div class="field">
      <label for="td-missed">Missed AWS topics or domains (optional)</label>
      <input id="td-missed" maxlength="200" placeholder="e.g. VPC endpoints, S3 storage classes">
    </div>
    <p class="projected" id="projected"></p>
    <p class="muted" id="summary"></p>
    <div class="actions">
      <a class="primary" id="submit-issue" href="#" target="_blank" rel="noopener">Submit Check-In via GitHub</a>
      <button type="button" id="copy-token">Copy 1-Line Check-In Token</button>
    </div>
    <p id="status" class="muted" role="status"></p>
    <textarea id="token-out" hidden readonly></textarea>`;

  $('#checkin').addEventListener('change', event => {
    const mod = event.target.closest('input[data-mod]');
    if (!mod) return;
    if (mod.checked) S.mods.add(mod.dataset.mod); else S.mods.delete(mod.dataset.mod);
    renderCheckinSummary();
  });
  $('#checkin').addEventListener('input', renderCheckinSummary);
  $('#submit-issue').addEventListener('click', () => {
    $('#submit-issue').href = issueUrl();
    markSubmitted('Opened GitHub. Tap "Submit new issue" there. XP is applied by tonight\'s 20:37 build.');
  });
  $('#copy-token').addEventListener('click', () => {
    const token = JSON.stringify(buildPayload());
    const out = $('#token-out');
    out.value = token;
    out.hidden = false;
    copyText(token, $('#copy-token'), 'Copy 1-Line Check-In Token');
    markSubmitted('Token copied. Paste it into a GitHub issue labelled "checkin" or a Claude chat.');
  });
  renderCheckinSummary();
}

function renderCheckinSummary() {
  const projected = $('#projected');
  if (!projected) return;
  const rested = S.state.rested_xp_active;
  const base = S.quest.tiers[S.tier].xp;
  projected.textContent = `Projected: +${projectedXp()} XP`
    + ` (${TIER_LABEL[S.tier]} ${base}${rested ? ' x2 rested' : ''}`
    + `${S.mods.size ? ` + ${MODIFIER_XP * S.mods.size} modifiers` : ''})`;
  projected.classList.toggle('rested', rested);
  const quests = questsForTier(S.tier);
  const doneCount = quests.filter(q => S.done[q.id]).length;
  const rated = Object.keys(S.ratings).length;
  $('#summary').textContent =
    `${doneCount} of ${quests.length} done-conditions ticked · ${rated} of ${dueCards().length} warmup cards rated`;
  $('#submit-issue').href = issueUrl();
}

function markSubmitted(message) {
  $('#status').textContent = message;
  renderSheet(projectedXp());
  try {
    localStorage.setItem('questlog-submitted', S.quest.date);
  } catch (err) {
    /* storage unavailable: the check-in itself is unaffected */
  }
}

async function copyText(text, button, restoreLabel) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch (err) {
    button.textContent = 'Copy blocked: select the text manually';
  }
  setTimeout(() => { button.textContent = restoreLabel; }, 2000);
}

/* ---------- Why drawer ---------- */

function renderWhy() {
  $('#why-rules').innerHTML = WHY_RULES.map(r => `
    <div class="rule">
      <h3>${esc(r.rule)}</h3>
      <p>${esc(r.how)}</p>
      <p class="basis"><span class="kind ${r.kind}">${r.kind === 'cited' ? 'Cited research' : 'Design rule'}</span>${esc(r.basis)}</p>
    </div>`).join('');
  $('#why-open').addEventListener('click', () => { $('#why').hidden = false; });
  $('#why-close').addEventListener('click', () => { $('#why').hidden = true; });
}

/* ---------- Boot ---------- */

async function boot() {
  try {
    [S.state, S.quest, S.queue] = await Promise.all([
      loadJson('state'), loadJson('quest-data'), loadJson('srs-queue')
    ]);
  } catch (err) {
    const box = $('#load-error');
    box.hidden = false;
    box.textContent = `Could not load quest data: ${err.message}`;
    return;
  }
  renderSheet();
  renderWarmup();
  renderIntel();
  renderQuests();
  bindQuests();
  renderCheckin();
  renderWhy();
  window.QL = { S, projectedXp, buildPayload, issueUrl, charLevel, treeLevel };
}

boot();
