const $ = id => document.getElementById(id);
const input = $('videoInput'), video = $('preview'), editor = $('editor'), notice = $('notice');
let objectUrl = null, clips = [], duration = 0, installPrompt = null;
let worker = null, workerReady = false, workerLoading = false, pendingAudio = null;
let aiBusy = false;

function time(s) {
  s = Math.max(0, Number(s) || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function setAiStatus(message) { $('aiStatus').textContent = message; }

input.addEventListener('change', () => {
  const f = input.files?.[0];
  if (!f) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(f);
  video.src = objectUrl;
  $('fileName').textContent = f.name;
  $('clipTitle').value = f.name.replace(/\.[^.]+$/, '') + ' moment';
  editor.classList.remove('hidden');
  $('startTime').value = 0;
  $('endTime').value = 15;
  clips = [];
  render();
  setAiStatus('AI runs in a background worker. For analysis, select a separate audio-only file (MP3, WAV or M4A) to avoid decoding heavy 4K video on this laptop.');
  notice.textContent = 'Video loaded locally. Manual clipping still uses the video. AI transcription uses a separate audio file to keep the page responsive.';
});
video.addEventListener('loadedmetadata', () => {
  duration = video.duration || 0;
  $('durationLabel').textContent = time(duration);
  $('endTime').value = Math.min(15, duration).toFixed(1);
  $('startTime').max = duration;
  $('endTime').max = duration;
});
$('removeVideo').onclick = () => {
  video.pause(); video.removeAttribute('src'); video.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null; editor.classList.add('hidden'); input.value = ''; clips = []; render();
};
$('urlBtn').onclick = () => alert('Direct URL importing is not included yet. Upload a video you own or are authorized to use.');
$('mode').onchange = () => { $('categories').style.display = $('mode').value === 'guided' ? 'flex' : 'none'; };
$('addClip').onclick = () => {
  const start = Math.max(0, Number($('startTime').value) || 0);
  const end = Math.min(duration, Number($('endTime').value) || 0);
  if (end <= start) { notice.textContent = 'End time must be later than start time.'; return; }
  clips.push({ id: Date.now() + Math.random(), title: $('clipTitle').value || 'Untitled moment', start, end, category: 'Manual cut' });
  render(); notice.textContent = 'Clip added. Choose Download to render it in your browser.';
};
$('clearClips').onclick = () => { clips = []; render(); };

const KEYWORDS = {
  'Funny moments': ['haha', 'hahaha', 'laugh', 'laughing', 'funny', 'joke', 'lol', 'what the', 'oh my god', 'bro'],
  'Crazy gameplay': ["let's go", 'lets go', 'clutch', 'headshot', 'insane', 'crazy', 'victory', 'winner', 'one shot', 'got him'],
  'Unexpected moments': ['no way', 'wait what', 'what just', 'oh', 'whoa', 'seriously', 'how did', 'what happened'],
  'Reactions': ['oh my god', 'what', 'no way', 'wow', 'damn', 'are you kidding', "i can't believe", 'bro'],
  'Memorable dialogue': ['remember', 'listen', 'the truth', 'never forget', 'i told you', 'you know what', 'because']
};

function ensureWorker() {
  if (worker) return;
  worker = new Worker('./ai-worker.js', { type: 'module' });
  worker.onmessage = event => {
    const d = event.data || {};
    if (d.type === 'status') setAiStatus(d.message);
    if (d.type === 'model-progress') {
      const pct = Number.isFinite(d.progress) ? ` ${Math.round(d.progress)}%` : '';
      setAiStatus(`Downloading ${d.file}${pct}. First download can be large; this runs in the background.`);
    }
    if (d.type === 'ready') {
      workerReady = true; workerLoading = false;
      setAiStatus('Whisper Tiny is ready. Select an audio file and press Find moments.');
      if (pendingAudio) runAudioTranscription(pendingAudio);
    }
    if (d.type === 'transcribe-progress') setAiStatus(d.message || 'Transcribing…');
    if (d.type === 'transcript') {
      aiBusy = false;
      $('detectBtn').disabled = false;
      $('detectBtn').textContent = '✦ Find moments';
      $('transcriptText').textContent = d.text || 'No speech was recognised.';
      $('transcriptPanel').classList.remove('hidden');
      const suggestions = makeSuggestions(d.chunks || [], pendingAudio?.duration || duration);
      suggestions.forEach((s, i) => clips.push({
        id: Date.now() + i + Math.random(), title: s.title,
        start: s.start, end: s.end, category: `AI suggestion · ${s.category}`
      }));
      render();
      setAiStatus(`Transcription complete. ${suggestions.length} keyword-based clip suggestions added. Review each suggestion; these are not verified funny moments.`);
      notice.textContent = suggestions.length
        ? 'AI transcript and candidate clips are ready. The suggestions use speech keywords only, so review them before exporting.'
        : 'Transcription finished, but no matching keyword highlights were found. You can still create manual cuts.';
      pendingAudio = null;
    }
    if (d.type === 'error') {
      aiBusy = false; workerLoading = false; pendingAudio = null;
      $('detectBtn').disabled = false;
      $('detectBtn').textContent = '✦ Find moments';
      setAiStatus('AI worker reported an error.');
      notice.textContent = `AI error: ${d.message}. Try a shorter MP3/WAV audio file or reload the page.`;
    }
  };
  worker.onerror = e => {
    aiBusy = false; workerLoading = false;
    $('detectBtn').disabled = false; $('detectBtn').textContent = '✦ Find moments';
    setAiStatus('AI background worker failed to start.');
    notice.textContent = `Worker error: ${e.message || 'Could not start AI worker'}. Refresh the page and try again.`;
  };
}

function loadWorker() {
  ensureWorker();
  if (workerReady || workerLoading) return;
  workerLoading = true;
  setAiStatus('Starting background AI worker and loading Whisper Tiny…');
  worker.postMessage({ type: 'load' });
}

$('chooseAudioBtn').onclick = () => $('audioInput').click();
$('audioInput').addEventListener('change', () => {
  const file = $('audioInput').files?.[0];
  if (!file) return;
  if (file.size > 80 * 1024 * 1024) {
    notice.textContent = 'For this laptop-friendly test, choose audio under 80 MB.';
    $('audioInput').value = '';
    return;
  }
  $('audioFileName').textContent = `Selected AI audio: ${file.name}`;
  pendingAudio = { file, duration: 0 };
  setAiStatus('Audio selected. Click Find moments to transcribe it in the background.');
  notice.textContent = 'For best results, choose audio extracted from the same video loaded above. The separate audio file avoids decoding a 4K video during AI analysis.';
});

$('detectBtn').onclick = async () => {
  if (aiBusy) return;
  if (!input.files?.[0]) { notice.textContent = 'Choose a video first so suggested timestamps can be clipped from it.'; return; }
  const file = $('audioInput').files?.[0];
  if (!file) {
    notice.textContent = 'Please select an audio-only file (MP3, WAV or M4A) using Choose audio for AI. A 4K video can overload a slow laptop during audio extraction.';
    $('audioInput').click();
    return;
  }
  aiBusy = true; $('detectBtn').disabled = true; $('detectBtn').textContent = '◌ Analysing…';
  try {
    setAiStatus('Decoding the selected audio file…');
    const decoded = await decodeAudioFile(file);
    pendingAudio = { audio: decoded.audio, duration: decoded.duration };
    if (!workerReady) {
      ensureWorker(); workerLoading = true;
      setAiStatus('Starting the background worker and downloading Whisper Tiny. You can still use the page while it loads.');
      worker.postMessage({ type: 'load' });
    } else runAudioTranscription(pendingAudio);
  } catch (err) {
    aiBusy = false; $('detectBtn').disabled = false; $('detectBtn').textContent = '✦ Find moments';
    setAiStatus('Could not read the audio file.');
    notice.textContent = `Audio error: ${err.message || err}. Try MP3 or WAV.`;
  }
};

async function decodeAudioFile(file) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('Web Audio is not supported in this browser.');
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    const mono = new Float32Array(decoded.length);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const channel = decoded.getChannelData(ch);
      for (let i = 0; i < decoded.length; i++) mono[i] += channel[i] / decoded.numberOfChannels;
    }
    const ratio = decoded.sampleRate / 16000;
    const out = new Float32Array(Math.floor(mono.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const pos = i * ratio, left = Math.floor(pos), frac = pos - left;
      const right = Math.min(left + 1, mono.length - 1);
      out[i] = mono[left] * (1 - frac) + mono[right] * frac;
    }
    return { audio: out, duration: decoded.duration };
  } finally { await ctx.close(); }
}

function runAudioTranscription(data) {
  if (!data?.audio) { aiBusy = false; return; }
  setAiStatus('Whisper is transcribing in a background worker. The page should remain responsive; this may take a while on a slow laptop.');
  const audio = data.audio;
  worker.postMessage({ type: 'transcribe', audioBuffer: audio.buffer }, [audio.buffer]);
}

function makeSuggestions(chunks, totalDuration) {
  const selected = $('mode').value === 'guided'
    ? [...$('categories').querySelectorAll('input:checked')].map(x => x.value)
    : Object.keys(KEYWORDS);
  const pool = [];
  for (const chunk of chunks) {
    const text = (chunk.text || '').trim();
    if (!text) continue;
    const low = text.toLowerCase();
    const matched = selected.filter(cat => KEYWORDS[cat].some(k => low.includes(k)));
    const emphasis = (text.match(/[!?]/g) || []).length;
    let score = matched.length * 2 + Math.min(emphasis, 3) * 0.3;
    if (text.split(/\s+/).length >= 6) score += 0.2;
    if (!matched.length) score = 0.25;
    const start = Math.max(0, Number(chunk.start) - 5);
    const end = Math.min(totalDuration, Math.max(Number(chunk.end) + 7, start + 8));
    if (end - start < 5) continue;
    pool.push({ start, end, title: text.slice(0, 62) || 'AI moment', category: matched[0] || 'Dialogue review', score });
  }
  pool.sort((a, b) => b.score - a.score);
  const result = [];
  for (const item of pool) {
    if (result.every(x => Math.abs(x.start - item.start) > 10)) result.push(item);
    if (result.length >= 8) break;
  }
  return result;
}

function render() {
  $('clipCount').textContent = clips.length;
  const list = $('clipList');
  if (!clips.length) { list.innerHTML = '<div class="empty">Your selected moments will appear here.</div>'; return; }
  list.innerHTML = '';
  clips.forEach(c => {
    const el = document.createElement('div'); el.className = 'clip';
    const info = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = c.title;
    const small = document.createElement('small'); small.textContent = `${time(c.start)} – ${time(c.end)}  ·  ${c.category}`;
    info.append(strong, small);
    const actions = document.createElement('div'); actions.className = 'clip-actions';
    const previewBtn = document.createElement('button'); previewBtn.textContent = 'Preview'; previewBtn.onclick = () => { video.currentTime = c.start; video.play(); };
    const del = document.createElement('button'); del.textContent = 'Remove'; del.onclick = () => { clips = clips.filter(x => x.id !== c.id); render(); };
    const dl = document.createElement('button'); dl.className = 'download'; dl.textContent = 'Download'; dl.onclick = () => exportClip(c);
    actions.append(previewBtn, del, dl); el.append(info, actions); list.append(el);
  });
}
async function exportClip(c) {
  if (!video.src) return;
  const vertical = $('format').value === 'vertical' || $('format').value === 'both';
  const landscape = $('format').value === 'landscape' || $('format').value === 'both';
  if (vertical) await recordClip(c, 'vertical');
  if (landscape) await recordClip(c, 'landscape');
}
function recordClip(c, orientation) {
  return new Promise(async resolve => {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    canvas.width = orientation === 'vertical' ? 720 : 1280;
    canvas.height = orientation === 'vertical' ? 1280 : 720;
    const stream = canvas.captureStream(30);
    try { video.captureStream().getAudioTracks().forEach(t => stream.addTrack(t)); } catch (e) {}
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(x => MediaRecorder.isTypeSupported(x));
    if (!mime) { notice.textContent = 'This browser cannot export WebM video. Try current Chrome.'; resolve(); return; }
    const rec = new MediaRecorder(stream, { mimeType: mime }), chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: mime }), url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = `vice-city-${orientation}-${Math.floor(c.start)}-${Math.floor(c.end)}.webm`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      video.pause(); stream.getTracks().forEach(t => t.stop()); resolve();
    };
    video.pause(); video.currentTime = c.start;
    await new Promise(r => video.addEventListener('seeked', r, { once: true }));
    rec.start(); video.play();
    let raf;
    const draw = () => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (vw && vh) {
        const targetRatio = canvas.width / canvas.height, srcRatio = vw / vh;
        let sx = 0, sy = 0, sw = vw, sh = vh;
        if (srcRatio > targetRatio) { sw = vh * targetRatio; sx = (vw - sw) / 2; }
        else { sh = vw / targetRatio; sy = (vh - sh) / 2; }
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      }
      if (!video.paused && video.currentTime < c.end) raf = requestAnimationFrame(draw);
    };
    draw();
    const stop = () => { cancelAnimationFrame(raf); if (rec.state !== 'inactive') rec.stop(); };
    const poll = () => { if (video.currentTime >= c.end || video.ended) { video.pause(); stop(); } else if (rec.state !== 'inactive') setTimeout(poll, 100); };
    poll();
    video.addEventListener('pause', () => { if (rec.state !== 'inactive' && video.currentTime < c.end) stop(); }, { once: true });
  });
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('installBtn').classList.remove('hidden'); });
$('installBtn').onclick = async () => { if (installPrompt) { installPrompt.prompt(); installPrompt = null; $('installBtn').classList.add('hidden'); } };
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
