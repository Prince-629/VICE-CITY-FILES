const $ = id => document.getElementById(id);
const input = $('videoInput'), video = $('preview'), editor = $('editor'), notice = $('notice');
let objectUrl = null, clips = [], duration = 0, installPrompt = null;
let transcriber = null, transcriptReady = false, aiBusy = false;

function time(s) {
  s = Math.max(0, Number(s) || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function setAiStatus(message) {
  const el = $('aiStatus');
  if (el) el.textContent = message;
}
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
  transcriptReady = false;
  render();
  setAiStatus('AI engine not loaded. Tap Find moments to download the small Whisper model.');
  notice.textContent = 'Video loaded locally. AI analysis runs in your browser; the first model download can be large and slow.';
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
  objectUrl = null; editor.classList.add('hidden'); input.value = ''; clips = [];
  transcriptReady = false; render();
};
$('urlBtn').onclick = () => alert('Direct URL importing is not included yet. Upload a video file you own or are authorized to use.');
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

async function getTranscriber() {
  if (transcriber) return transcriber;
  setAiStatus('Loading Transformers.js and Whisper tiny model. Keep this tab open; first download may take a while.');
  const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2');
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.numThreads = 1;
  transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: p => {
      if (p.status === 'progress' && p.file) {
        const pct = p.progress ? ` ${Math.round(p.progress)}%` : '';
        setAiStatus(`Downloading AI model: ${p.file}${pct}`);
      } else if (p.status) setAiStatus(`Preparing AI model: ${p.status}`);
    }
  });
  return transcriber;
}

async function extractMonoAudio(file) {
  // Browsers cannot reliably decode an MP4/WebM video file directly with
  // decodeAudioData. Capture its audio track while the video plays instead.
  if (!video.captureStream || !window.MediaRecorder) {
    throw new Error('This Chrome version cannot capture audio from the video. Update Chrome and retry.');
  }
  const originalTime = video.currentTime;
  const wasMuted = video.muted;
  video.pause();
  video.muted = false;
  video.currentTime = 0;
  await new Promise(resolve => {
    if (video.readyState >= 2 && video.currentTime === 0) resolve();
    else video.addEventListener('seeked', resolve, { once: true });
  });
  const source = video.captureStream();
  const audioTracks = source.getAudioTracks();
  if (!audioTracks.length) {
    source.getTracks().forEach(t => t.stop());
    video.muted = wasMuted;
    throw new Error('No audio track was found in this video.');
  }
  const audioStream = new MediaStream(audioTracks);
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    .find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) {
    source.getTracks().forEach(t => t.stop());
    video.muted = wasMuted;
    throw new Error('This browser cannot record the video audio track.');
  }
  setAiStatus('Extracting audio by playing the video once. Keep this tab open…');
  const recorder = new MediaRecorder(audioStream, { mimeType: mime });
  const parts = [];
  recorder.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
  const finished = new Promise((resolve, reject) => {
    recorder.onerror = () => reject(new Error('Audio capture failed.'));
    recorder.onstop = resolve;
  });
  recorder.start(1000);
  await video.play();
  await new Promise(resolve => {
    video.addEventListener('ended', resolve, { once: true });
    video.addEventListener('error', resolve, { once: true });
  });
  video.pause();
  if (recorder.state !== 'inactive') recorder.stop();
  await finished;
  source.getTracks().forEach(t => t.stop());
  video.muted = wasMuted;
  video.currentTime = Math.min(originalTime, duration);
  const blob = new Blob(parts, { type: mime });
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('This browser does not support Web Audio.');
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const channels = decoded.numberOfChannels;
    const mono = new Float32Array(decoded.length);
    for (let ch = 0; ch < channels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < decoded.length; i++) mono[i] += data[i] / channels;
    }
    const ratio = decoded.sampleRate / 16000;
    const outLength = Math.floor(mono.length / ratio);
    const resampled = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio, left = Math.floor(pos), frac = pos - left;
      const right = Math.min(left + 1, mono.length - 1);
      resampled[i] = mono[left] * (1 - frac) + mono[right] * frac;
    }
    return { audio: resampled, seconds: decoded.duration };
  } finally {
    await ctx.close();
  }
}

function makeSuggestions(chunks, totalDuration) {
  const selected = $('mode').value === 'guided'
    ? [...$('categories').querySelectorAll('input:checked')].map(x => x.value)
    : Object.keys(KEYWORDS);
  const pool = [];
  for (const chunk of chunks || []) {
    const text = (chunk.text || '').trim();
    if (!text) continue;
    const low = text.toLowerCase();
    const matched = selected.filter(cat => KEYWORDS[cat].some(k => low.includes(k)));
    const emphatic = (text.match(/[!?]/g) || []).length;
    let score = matched.length * 2 + Math.min(emphatic, 3) * 0.3;
    if (text.split(/\s+/).length >= 6) score += 0.2;
    if (!matched.length) score = 0.25;
    const rawStart = Array.isArray(chunk.timestamp) ? chunk.timestamp[0] : chunk.timestamp?.[0];
    const rawEnd = Array.isArray(chunk.timestamp) ? chunk.timestamp[1] : chunk.timestamp?.[1];
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
    const start = Math.max(0, rawStart - 5);
    const end = Math.min(totalDuration, Math.max(rawEnd + 7, start + 8));
    if (end - start < 5) continue;
    pool.push({ start, end, title: text.slice(0, 62) || 'AI moment', category: matched[0] || 'Dialogue review', score, transcript: text });
  }
  pool.sort((a, b) => b.score - a.score);
  const result = [];
  for (const item of pool) {
    if (result.every(x => Math.abs(x.start - item.start) > 10)) result.push(item);
    if (result.length >= 8) break;
  }
  return result;
}

$('detectBtn').onclick = async () => {
  if (aiBusy) return;
  const file = input.files?.[0];
  if (!file) { notice.textContent = 'Choose a video first.'; return; }
  if (duration > 300) {
    notice.textContent = 'For this first on-device AI test, please use a video of 5 minutes or less.';
    return;
  }
  if (file.size > 120 * 1024 * 1024) {
    notice.textContent = 'This first browser AI test is limited to files under 120 MB to reduce memory problems on phones.';
    return;
  }
  aiBusy = true;
  $('detectBtn').disabled = true;
  $('detectBtn').textContent = '◌ Analysing…';
  try {
    const engine = await getTranscriber();
    const { audio, seconds } = await extractMonoAudio(file);
    setAiStatus('Whisper is transcribing the audio. On a phone this can take several minutes…');
    const result = await engine(audio, {
      chunk_length_s: 20,
      stride_length_s: 4,
      return_timestamps: true
    });
    const chunks = result.chunks || [];
    const transcript = result.text || '';
    $('transcriptText').textContent = transcript || 'No speech was recognised.';
    $('transcriptPanel').classList.remove('hidden');
    const suggestions = makeSuggestions(chunks, seconds || duration);
    suggestions.forEach((s, i) => {
      clips.push({
        id: Date.now() + i + Math.random(),
        title: s.title,
        start: s.start,
        end: s.end,
        category: `AI suggestion · ${s.category}`
      });
    });
    render();
    transcriptReady = true;
    setAiStatus(`Analysis complete. ${chunks.length} speech segments processed; ${suggestions.length} candidate clips suggested.`);
    notice.textContent = suggestions.length
      ? 'AI suggestions added to your clip list. Review each one before downloading.'
      : 'Transcription finished, but no strong keyword-based highlights were found. Review the transcript and make a manual cut.';
  } catch (err) {
    console.error(err);
    const message = err?.message || String(err);
    setAiStatus('AI analysis could not finish.');
    notice.textContent = `AI error: ${message}. Try a shorter MP4 with clear audio, and keep Chrome open.`;
  } finally {
    aiBusy = false;
    $('detectBtn').disabled = false;
    $('detectBtn').textContent = '✦ Find moments';
  }
};

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
    const previewBtn = document.createElement('button'); previewBtn.textContent = 'Preview';
    previewBtn.onclick = () => { video.currentTime = c.start; video.play(); };
    const del = document.createElement('button'); del.textContent = 'Remove';
    del.onclick = () => { clips = clips.filter(x => x.id !== c.id); render(); };
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
    const poll = () => {
      if (video.currentTime >= c.end || video.ended) { video.pause(); stop(); }
      else if (rec.state !== 'inactive') setTimeout(poll, 100);
    };
    poll();
    video.addEventListener('pause', () => { if (rec.state !== 'inactive' && video.currentTime < c.end) stop(); }, { once: true });
  });
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('installBtn').classList.remove('hidden'); });
$('installBtn').onclick = async () => { if (installPrompt) { installPrompt.prompt(); installPrompt = null; $('installBtn').classList.add('hidden'); } };
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
