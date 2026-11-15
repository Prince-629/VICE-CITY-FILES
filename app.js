const $ = id => document.getElementById(id);
const input = $('videoInput'), video = $('preview'), editor = $('editor'), notice = $('notice');
let objectUrl = null, clips = [], duration = 0, installPrompt = null;
let worker = null, workerReady = false, workerLoading = false, pendingAudio = null;
let aiBusy = false;
let sourceVideoFile = null;
let ffmpegInstance = null;
let ffmpegLoadPromise = null;
let exportBusy = false;
const MAX_EXPORT_MB = 180;

function time(s) {
  s = Math.max(0, Number(s) || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function setAiStatus(message) { $('aiStatus').textContent = message; }

input.addEventListener('change', () => {
  const f = input.files?.[0];
  if (!f) return;
  sourceVideoFile = f;
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
  objectUrl = null; sourceVideoFile = null; editor.classList.add('hidden'); input.value = ''; clips = []; render();
};
$('urlBtn').onclick = () => alert('Direct URL importing is not included yet. Upload a video you own or are authorized to use.');
$('mode').onchange = () => { $('categories').style.display = $('mode').value === 'guided' ? 'flex' : 'none'; };
$('addClip').onclick = () => {
  const start = Math.max(0, Number($('startTime').value) || 0);
  const end = Math.min(duration, Number($('endTime').value) || 0);
  if (end <= start) { notice.textContent = 'End time must be later than start time.'; return; }
  clips.push({ id: Date.now() + Math.random(), title: $('clipTitle').value || 'Untitled moment', start, end, category: 'Manual cut' });
  render(); notice.textContent = 'Clip added. Choose Download MP4 to create an H.264/AAC MP4 file. The first export downloads the encoder.';
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
    const dl = document.createElement('button'); dl.className = 'download'; dl.textContent = 'Download MP4'; dl.onclick = () => exportClip(c);
    actions.append(previewBtn, del, dl); el.append(info, actions); list.append(el);
  });
}
function setExportStatus(message) {
  const el = $('exportStatus');
  if (el) el.textContent = message;
  setAiStatus(message);
}

async function fetchAsBlobURL(url, mimeType) {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Could not download encoder asset (${response.status}).`);
  const data = await response.arrayBuffer();
  return URL.createObjectURL(new Blob([data], { type: mimeType }));
}

async function getMp4Encoder() {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;
  ffmpegLoadPromise = (async () => {
    if (!window.FFmpegWASM || !window.FFmpegWASM.FFmpeg) {
      throw new Error('The MP4 encoder library did not load. Check your internet connection, refresh the page, and retry.');
    }
    setExportStatus('Loading the MP4 encoder. This first-time download is about 30–40 MB.');
    const ffmpeg = new window.FFmpegWASM.FFmpeg();
    ffmpeg.on('progress', ({ progress }) => {
      if (Number.isFinite(progress)) {
        const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
        setExportStatus(`Encoding MP4 in the background: ${percent}%`);
      }
    });
    ffmpeg.on('log', ({ message }) => {
      if (message && /error|failed|invalid/i.test(message)) console.warn('[VICE CITY FFmpeg]', message);
    });
    const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
    const coreURL = await fetchAsBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript');
    const wasmURL = await fetchAsBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm');
    await ffmpeg.load({ coreURL, wasmURL });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })().catch(error => { ffmpegLoadPromise = null; throw error; });
  return ffmpegLoadPromise;
}

function safeFilePart(value) {
  return String(value || 'clip').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().replace(/\s+/g, '-').slice(0, 55) || 'clip';
}

function ffmpegFilter(orientation) {
  const width = orientation === 'vertical' ? 720 : 1280;
  const height = orientation === 'vertical' ? 1280 : 720;
  // Preserve the whole source frame in front; fill the canvas with a blurred copy.
  return `[0:v:0]split=2[bgsrc][fgsrc];` +
    `[bgsrc]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},boxblur=18:2[bg];` +
    `[fgsrc]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[v]`;
}

async function renderMp4(c, orientation) {
  if (!sourceVideoFile) throw new Error('Upload your source video again before exporting.');
  const start = Math.max(0, Number(c.start));
  const end = Math.min(duration, Number(c.end));
  const clipDuration = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || clipDuration <= 0.15) {
    throw new Error('The clip end time must be later than the start time.');
  }
  if (sourceVideoFile.size > MAX_EXPORT_MB * 1024 * 1024) {
    throw new Error(`This browser MP4 exporter is limited to ${MAX_EXPORT_MB} MB per source video. Use a shorter or smaller source file.`);
  }
  const ffmpeg = await getMp4Encoder();
  const ext = (sourceVideoFile.name.match(/\.([a-z0-9]{2,5})$/i)?.[1] || 'mp4').toLowerCase();
  const allowedExt = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'].includes(ext) ? ext : 'mp4';
  const inputName = `vcf_source.${allowedExt}`;
  const outputName = `vcf_${orientation}_${Math.round(start * 10)}_${Math.round(end * 10)}.mp4`;
  setExportStatus('Copying source video into the MP4 encoder…');
  const inputBytes = new Uint8Array(await sourceVideoFile.arrayBuffer());
  await ffmpeg.writeFile(inputName, inputBytes);
  const args = [
    '-y', '-ss', start.toFixed(3), '-i', inputName, '-t', clipDuration.toFixed(3),
    '-filter_complex', ffmpegFilter(orientation),
    '-map', '[v]', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24',
    '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', '-t', clipDuration.toFixed(3), outputName
  ];
  setExportStatus(`Rendering ${orientation === 'vertical' ? '9:16 vertical' : '16:9 landscape'} MP4 (${clipDuration.toFixed(1)} seconds)…`);
  const exitCode = await ffmpeg.exec(args);
  if (exitCode !== 0) throw new Error(`MP4 encoder exited with code ${exitCode}. Try an MP4 or MOV source file.`);
  const output = await ffmpeg.readFile(outputName);
  const bytes = output instanceof Uint8Array ? output : new Uint8Array(output);
  const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], { type: 'video/mp4' });
  if (blob.size < 1024) throw new Error('The MP4 output was unexpectedly small. Please retry with a supported source video.');
  const filename = `VICE-CITY-FILES-${safeFilePart(c.title)}-${orientation}.mp4`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  try { await ffmpeg.deleteFile(inputName); } catch (_) {}
  try { await ffmpeg.deleteFile(outputName); } catch (_) {}
  return filename;
}

async function exportClip(c) {
  if (exportBusy) return;
  if (!sourceVideoFile || !video.src) { notice.textContent = 'Upload your source video again before exporting.'; return; }
  exportBusy = true;
  const buttons = [...document.querySelectorAll('.clip-actions .download')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const formats = $('format').value === 'vertical' ? ['vertical'] : $('format').value === 'landscape' ? ['landscape'] : ['vertical', 'landscape'];
    const completed = [];
    for (const orientation of formats) completed.push(await renderMp4(c, orientation));
    setExportStatus(`MP4 export complete: ${completed.join(' and ')}`);
    notice.textContent = 'Your MP4 file uses H.264 video and AAC audio. It should play in common desktop and mobile video players.';
  } catch (error) {
    console.error(error);
    setExportStatus('MP4 export could not finish.');
    notice.textContent = `MP4 export error: ${error.message || error}. Your original video has not been changed.`;
  } finally {
    exportBusy = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('installBtn').classList.remove('hidden'); });
$('installBtn').onclick = async () => { if (installPrompt) { installPrompt.prompt(); installPrompt = null; $('installBtn').classList.add('hidden'); } };
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
