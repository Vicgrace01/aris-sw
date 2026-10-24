/* ---------- Language state ---------- */

const LANG_KEY = 'aris-lang';
let currentLang = localStorage.getItem(LANG_KEY) || 'sw';

const LABELS = {
  sw: {
    diagnosis: 'Utambuzi',
    immediate: 'Hatua za haraka',
    doNot: 'Usifanye',
    escalate: 'Peleka kwa afisa ugani ikiwa',
    refusal: 'Jibu',
    noAdvice: 'Hakuna ushauri uliopatikana.',
    loadingAnalyze: 'Inachambua tatizo…',
    loadingListen: 'Inabadilisha sauti kuwa maandishi…',
    listening: 'Inarekodi…',
    greeting: 'Habari! Mimi ni ARIS-SW, mshauri wako wa kilimo. Uliza swali lolote kuhusu kilimo chakula, au bonyeza kitufe cha maikrofoni na zungumza kwa Kiswahili.',
    placeholder: 'Andika swali lako hapa...',
    error: 'Hitilafu',
    recordedAudio: '[Sauti iliyorekodiwa]',
    listenPlay: 'Sikiliza kwa Kiswahili',
    stopRecording: '■',
    startRecording: '🎤'
  },
  en: {
    diagnosis: 'Diagnosis',
    immediate: 'Immediate actions',
    doNot: 'Do NOT',
    escalate: 'Escalate if',
    refusal: 'Response',
    noAdvice: 'No advice returned.',
    loadingAnalyze: 'Analyzing problem…',
    loadingListen: 'Transcribing audio…',
    listening: 'Recording…',
    greeting: 'Hello! I am ARIS-SW, your agricultural advisor. Ask about food crops, or click the microphone and speak in Swahili.',
    placeholder: 'Type your question here...',
    error: 'Error',
    recordedAudio: '[Recorded audio]',
    listenPlay: 'Listen in Swahili',
    stopRecording: '■',
    startRecording: '🎤'
  }
};

function t(key) { return LABELS[currentLang][key] || LABELS.en[key] || key; }

function setLanguage(lang) {
  if (!LABELS[lang]) return;
  currentLang = lang;
  localStorage.setItem(LANG_KEY, lang);
  document.documentElement.lang = lang;

  document.querySelectorAll('.lang-toggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === lang);
  });
  document.getElementById('headerSub').textContent = lang === 'sw'
    ? 'Mshauri wa Kilimo · Swahili Agricultural Advisor'
    : 'Agricultural Advisor · Swahili Voice Assistant';
  document.getElementById('greeting').textContent = t('greeting');
  document.getElementById('textInput').placeholder = t('placeholder');

  rerenderTriageBar();
  replayTTS();
}

document.querySelectorAll('.lang-toggle button').forEach(btn => {
  btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
});

/* ---------- DOM refs ---------- */

const chat = document.getElementById('chat');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
const triageBar = document.getElementById('triageBar');

let currentSessionId = null;
let pendingQuestions = [];
let lastAdvisory = null;
let lastAdvisoryMessageId = null;
let lastAudioUrl = null;

/* ---------- Input ---------- */

textInput.addEventListener('input', () => { sendBtn.disabled = !textInput.value.trim(); });
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && textInput.value.trim()) submitText();
});
sendBtn.addEventListener('click', submitText);

async function submitText() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  sendBtn.disabled = true;
  await sendToServer(text);
}

/* ---------- Voice ---------- */

let mediaRecorder;
let chunks = [];

micBtn.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => e.data.size && chunks.push(e.data);
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      micBtn.classList.remove('recording');
      micBtn.textContent = t('startRecording');
      addUserBubble(t('recordedAudio'));
      const loadingId = addLoadingBubble(t('loadingListen'));
      try {
        const form = new FormData();
        form.append('audio', new Blob(chunks, { type: mediaRecorder.mimeType }), 'input.wav');
        const res = await fetch('/api/stt', { method: 'POST', body: form });
        const data = await res.json();
        removeBubble(loadingId);
        if (!res.ok || !data.text) throw new Error(data.message || 'No speech detected');
        await sendToServer(data.text);
      } catch (e) {
        removeBubble(loadingId);
        addErrorBubble(e.message);
      }
    };
    mediaRecorder.start();
    micBtn.classList.add('recording');
    micBtn.textContent = t('stopRecording');
  } catch (e) {
    addErrorBubble('Microphone: ' + e.message);
  }
});

/* ---------- Chat send ---------- */

async function sendToServer(text) {
  addUserBubble(text);
  const loadingId = addLoadingBubble(t('loadingAnalyze'));
  clearTriageBar();

  try {
    const body = { input: text };
    if (currentSessionId) body.sessionId = currentSessionId;

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    removeBubble(loadingId);

    if (!res.ok) throw new Error(data.message || data.error || 'Unknown error');

    if (data.sessionId) currentSessionId = data.sessionId;
    lastAdvisory = data.advisory;
    lastAdvisoryMessageId = data.advisoryMessageId;
    renderAdvisory(data.advisory, data.advisoryMessageId);

    pendingQuestions = data.pendingQuestions || [];
    renderTriageBar();

    if (data.advisory?.record_kind !== 'refusal') {
      requestTTS(data.advisory, data.advisoryMessageId);
    }
  } catch (e) {
    removeBubble(loadingId);
    addErrorBubble(e.message);
  }
}

/* ---------- Language-aware helpers ---------- */

function pick(swField, enField, fallbackMarker = true) {
  if (currentLang === 'sw') {
    if (swField) return { text: swField, marked: false };
    if (enField) return { text: enField, marked: fallbackMarker };
    return { text: '', marked: false };
  }
  return { text: enField || swField || '', marked: false };
}

function markFallback({ text, marked }) {
  if (!text) return '';
  return marked ? `${esc(text)}<span class="lang-fallback">EN</span>` : esc(text);
}

/* ---------- Rendering ---------- */

function renderAdvisory(a, messageId) {
  const id = messageId || 'msg-' + Date.now();
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = id;

  const sections = [];

  if (a.record_kind === 'refusal') {
    const reason = pick(a.refusal?.reason_sw, a.refusal?.reason_en);
    if (reason.text) sections.push(section(t('refusal'), markFallback(reason)));
  } else {
    const label = pick(a.diagnosis?.primary?.label_sw, a.diagnosis?.primary?.label);
    if (label.text) sections.push(section(t('diagnosis'), markFallback(label)));

    const immediate = (a.advice?.immediate || [])
      .map(x => pick(x.action_sw, x.action_en))
      .filter(p => p.text);
    if (immediate.length) {
      sections.push(section(t('immediate'), `<ul>${immediate.map(p => `<li>${markFallback(p)}</li>`).join('')}</ul>`));
    }

    const doNot = (a.advice?.do_not || [])
      .map(x => pick(x.text_sw, x.text_en))
      .filter(p => p.text);
    if (doNot.length) {
      sections.push(section(t('doNot'), `<ul class="dont">${doNot.map(p => `<li>${markFallback(p)}</li>`).join('')}</ul>`));
    }

    const trigger = pick(a.escalation?.trigger_sw, a.escalation?.trigger_en);
    if (trigger.text) {
      sections.push(section(t('escalate'), `<span class="escalate">${markFallback(trigger)}</span>`));
    }
  }

  if (!sections.length) sections.push(section(t('refusal'), esc(t('noAdvice'))));

  div.innerHTML = `<div class="avatar">AS</div><div class="bubble">${sections.join('')}</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function section(label, html) {
  return `<div class="section"><div class="label">${label}</div><div class="value">${html}</div></div>`;
}

function renderTriageBar() {
  triageBar.innerHTML = '';
  if (!pendingQuestions.length) {
    triageBar.classList.remove('active');
    return;
  }
  triageBar.classList.add('active');
  for (const q of pendingQuestions) {
    const btn = document.createElement('button');
    btn.className = 'triage-chip';
    const text = currentLang === 'sw' ? (q.ask_sw || q.ask_en) : (q.ask_en || q.ask_sw);
    btn.textContent = text;
    if (q.why) btn.title = q.why;
    btn.onclick = async () => {
      clearTriageBar();
      await sendToServer(text);
    };
    triageBar.appendChild(btn);
  }
}

function rerenderTriageBar() { renderTriageBar(); }

function clearTriageBar() {
  pendingQuestions = [];
  triageBar.innerHTML = '';
  triageBar.classList.remove('active');
}

/* ---------- Bubbles ---------- */

function addUserBubble(text) {
  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = `<div class="avatar">W</div><div class="bubble">${esc(text)}</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function addErrorBubble(msg) {
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.innerHTML = `<div class="avatar">AS</div><div class="bubble" style="color:#ff6b6b">${t('error')}: ${esc(msg)}</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function addLoadingBubble(label) {
  const id = 'load-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = id;
  div.innerHTML = `<div class="avatar">AS</div><div class="bubble"><div class="loading"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="loading-text">${esc(label)}</span></div></div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return id;
}

function removeBubble(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

/* ---------- TTS ---------- */

async function requestTTS(advisory, messageId) {
  const parts = [
    advisory.diagnosis?.primary?.label_sw || advisory.diagnosis?.primary?.label,
    ...(advisory.advice?.immediate || []).map(x => x.action_sw || x.action_en),
    ...(advisory.advice?.do_not || []).map(x => x.text_sw || x.text_en),
    advisory.escalation?.trigger_sw || advisory.escalation?.trigger_en,
  ].filter(Boolean);

  if (!parts.length) return;
  const text = parts.join('. ');

  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    attachPlayButton(messageId, url);
  } catch { /* optional */ }
}

function attachPlayButton(messageId, url) {
  const bubble = document.querySelector(`#${messageId} .bubble`);
  if (!bubble) return;
  const existing = bubble.querySelector('.play-btn');
  if (existing) existing.remove();
  const btn = document.createElement('button');
  btn.className = 'play-btn';
  btn.textContent = '🔊 ' + t('listenPlay');
  btn.onclick = () => new Audio(url).play();
  bubble.appendChild(btn);
  lastAudioUrl = url;
}

function replayTTS() {
  if (lastAdvisoryMessageId && lastAudioUrl) {
    const bubble = document.querySelector(`#${lastAdvisoryMessageId} .bubble`);
    if (!bubble) return;
    const btn = bubble.querySelector('.play-btn');
    if (btn) btn.textContent = '🔊 ' + t('listenPlay');
  }
}

/* ---------- Utility ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Initial paint ---------- */

setLanguage(currentLang);