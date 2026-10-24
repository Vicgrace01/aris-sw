const chat = document.getElementById('chat');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
const triageBar = document.getElementById('triageBar');
const voiceNotePanel = document.getElementById('voiceNotePanel');
const inputBar = document.getElementById('inputBar');

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
    greeting: 'Habari! Mimi ni ARIS-SW, mshauri wako wa kilimo. Uliza swali lolote kuhusu kilimo chakula, au bonyeza kitufe cha maikrofoni na zungumza kwa Kiswahili.',
    placeholder: 'Andika swali lako hapa...',
    error: 'Hitilafu',
    recordedAudio: '[Sauti iliyorekodiwa]',
    listenPlay: 'Sikiliza kwa Kiswahili',
    convertingAudio: 'Inabadilisha sauti...',
    audioFailed: 'Sauti haikuweza kubadilishwa',
    noSpeech: 'Hakuna sauti iliyotambuliwa'
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
    greeting: 'Hello! I am ARIS-SW, your agricultural advisor. Ask about food crops, or click the microphone and speak in Swahili.',
    placeholder: 'Type your question here...',
    error: 'Error',
    recordedAudio: '[Recorded audio]',
    listenPlay: 'Listen in Swahili',
    convertingAudio: 'Converting audio...',
    audioFailed: 'Could not convert audio',
    noSpeech: 'No speech detected'
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
  const hs = document.getElementById('headerSub');
  if (hs) hs.textContent = lang === 'sw'
    ? 'Mshauri wa Kilimo · Swahili Agricultural Advisor'
    : 'Agricultural Advisor · Swahili Voice Assistant';
  const g = document.getElementById('greeting');
  if (g) g.textContent = t('greeting');
  if (textInput) textInput.placeholder = t('placeholder');
  renderTriageBar();
  replayTTS();
}

document.querySelectorAll('.lang-toggle button').forEach(btn => {
  btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
});

let currentSessionId = null;
let pendingQuestions = [];
let lastAdvisoryMessageId = null;
let lastAudioUrl = null;

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

/* ============================================================
   VOICE NOTE RECORDING
   Flow: click mic → volume bars + timer → click stop →
         preview player + discard + send → send uploads to STT
   ============================================================ */

let mediaRecorder = null;
let recordedChunks = [];
let audioContext = null;
let analyser = null;
let volumeAnimationId = null;
let timerIntervalId = null;
let recordingStartTime = 0;
let previewBlob = null;
let previewUrl = null;

micBtn.addEventListener('click', startVoiceRecording);

async function startVoiceRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = e => { if (e.data.size) recordedChunks.push(e.data); };

    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(tr => tr.stop());
      cancelAnimationFrame(volumeAnimationId);
      clearInterval(timerIntervalId);
      if (audioContext && audioContext.state !== 'closed') audioContext.close();
      finalizeRecording();
    };

    mediaRecorder.start();
    showRecordingUI();
    startVolumeMeter();
    startRecordingTimer();
  } catch (e) {
    addErrorBubble('Microphone: ' + e.message);
  }
}

function showRecordingUI() {
  inputBar.hidden = true;
  voiceNotePanel.hidden = false;
  voiceNotePanel.innerHTML = `
    <div class="volume-bars" id="volumeBars"></div>
    <span class="recording-timer" id="recordingTimer">0:00</span>
    <button class="rec-action-btn stop-rec-btn" id="stopRecBtn" title="Stop">■</button>
  `;
  const bars = document.getElementById('volumeBars');
  for (let i = 0; i < 30; i++) {
    const bar = document.createElement('div');
    bar.className = 'volume-bar';
    bars.appendChild(bar);
  }
  document.getElementById('stopRecBtn').addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  });
}

function startVolumeMeter() {
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const bars = document.querySelectorAll('.volume-bar');

  function draw() {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
    analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
    const avg = sum / dataArray.length;
    const level = Math.min(1, avg / 100);

    bars.forEach((bar, i) => {
      const wobble = 0.6 + Math.random() * 0.4;
      const h = Math.max(3, level * 32 * wobble);
      bar.style.height = h + 'px';
      bar.style.opacity = level < 0.02 ? '0.25' : '1';
    });

    volumeAnimationId = requestAnimationFrame(draw);
  }
  draw();
}

function startRecordingTimer() {
  recordingStartTime = Date.now();
  timerIntervalId = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const el = document.getElementById('recordingTimer');
    if (el) el.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }, 200);
}

async function finalizeRecording() {
  if (recordedChunks.length === 0) {
    resetToInputBar();
    return;
  }
  showPreviewUI(null); // show "converting" state

  const webmBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
  let wavBlob = null;
  try {
    wavBlob = await convertToWav(webmBlob);
  } catch (e) {
    console.error('WAV conversion failed:', e);
  }

  if (!wavBlob) {
    addErrorBubble(t('audioFailed'));
    resetToInputBar();
    return;
  }

  previewBlob = wavBlob;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(previewBlob);
  showPreviewUI(previewUrl);
}

function showPreviewUI(url) {
  voiceNotePanel.innerHTML = `
    <button class="rec-action-btn play-preview-btn" id="playPreviewBtn" disabled>▶</button>
    <span class="preview-timer" id="previewTimer">${url ? '0:00' : '…'}</span>
    <audio id="previewAudio" ${url ? `src="${url}"` : ''}></audio>
    <div style="flex:1"></div>
    <button class="rec-action-btn discard-btn" id="discardBtn" title="Discard">✕</button>
    <button class="rec-action-btn send-voice-btn" id="sendVoiceBtn" title="Send" ${url ? '' : 'disabled'}>➤</button>
  `;

  const audio = document.getElementById('previewAudio');
  const playBtn = document.getElementById('playPreviewBtn');
  const timerEl = document.getElementById('previewTimer');
  const discardBtn = document.getElementById('discardBtn');
  const sendVoiceBtn = document.getElementById('sendVoiceBtn');

  if (url) {
    audio.addEventListener('loadedmetadata', () => {
      const d = audio.duration || 0;
      const m = Math.floor(d / 60);
      const s = Math.floor(d % 60);
      timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
      playBtn.disabled = false;
    });

    playBtn.addEventListener('click', () => {
      if (audio.paused) {
        audio.play();
        playBtn.textContent = '⏸';
        playBtn.classList.add('playing');
      } else {
        audio.pause();
        playBtn.textContent = '▶';
        playBtn.classList.remove('playing');
      }
    });

    audio.addEventListener('ended', () => {
      playBtn.textContent = '▶';
      playBtn.classList.remove('playing');
    });
  }

  discardBtn.addEventListener('click', () => {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    previewBlob = null;
    resetToInputBar();
  });

  sendVoiceBtn.addEventListener('click', () => {
    if (previewBlob) sendVoiceNote();
  });
}

async function sendVoiceNote() {
  const loadingId = addLoadingBubble(t('loadingListen'));
  try {
    const form = new FormData();
    form.append('audio', previewBlob, 'input.wav');
    const res = await fetch('/api/stt', { method: 'POST', body: form });
    const data = await res.json();
    removeBubble(loadingId);

    if (!res.ok) {
      throw new Error(data.message || data.error || t('noSpeech'));
    }
    if (!data.text || !data.text.trim()) {
      throw new Error(t('noSpeech'));
    }

    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    previewBlob = null;
    resetToInputBar();
    await sendToServer(data.text);
  } catch (e) {
    removeBubble(loadingId);
    addErrorBubble(e.message);
    // keep preview so user can discard and retry
  }
}

function resetToInputBar() {
  voiceNotePanel.hidden = true;
  voiceNotePanel.innerHTML = '';
  inputBar.hidden = false;
}

/* ============================================================
   WAV encoding — matches Speech Studio behaviour:
   native sample rate, mono, no amplification
   ============================================================ */

async function convertToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  const wavBuffer = encodeWav(audioBuffer);
  await ctx.close();
  return new Blob([wavBuffer], { type: 'audio/wav' });
}

function encodeWav(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;  // native, no downsample
  const numChannels = 1;                       // mono
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = audioBuffer.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;

  let offset = 44;
  for (let i = 0; i < audioBuffer.length; i++) {
    let sample = ch1 ? (ch0[i] + ch1[i]) / 2 : ch0[i];
    sample = Math.max(-1, Math.min(1, sample || 0));
    sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    view.setInt16(offset, sample, true);
    offset += 2;
  }

  return buffer;
}

/* ============================================================
   Chat flow
   ============================================================ */

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

function clearTriageBar() {
  pendingQuestions = [];
  triageBar.innerHTML = '';
  triageBar.classList.remove('active');
}

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
  } catch {}
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

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

setLanguage(currentLang);