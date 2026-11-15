import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2';

// Keep inference away from the page's main thread. Single-threaded WASM is
// deliberately chosen for compatibility with ordinary browsers/laptops.
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;

let transcriber = null;

self.onmessage = async (event) => {
  const data = event.data || {};
  try {
    if (data.type === 'load') {
      if (!transcriber) {
        self.postMessage({ type: 'status', message: 'Loading Whisper Tiny in background…' });
        transcriber = await pipeline(
          'automatic-speech-recognition',
          'onnx-community/whisper-tiny',
          {
            dtype: 'q8',
            device: 'wasm',
            progress_callback: (p) => {
              if (p && p.status === 'progress') {
                self.postMessage({
                  type: 'model-progress',
                  file: p.file || 'AI model',
                  progress: Number.isFinite(p.progress) ? p.progress : null
                });
              } else if (p && p.status) {
                self.postMessage({ type: 'status', message: `Preparing AI model: ${p.status}` });
              }
            }
          }
        );
      }
      self.postMessage({ type: 'ready' });
      return;
    }

    if (data.type === 'transcribe') {
      if (!transcriber) throw new Error('AI model is not loaded yet.');
      const audio = new Float32Array(data.audioBuffer);
      const sampleRate = 16000;
      const chunkSeconds = 20;
      const chunkSamples = chunkSeconds * sampleRate;
      const total = audio.length;
      const allChunks = [];
      const allText = [];

      for (let start = 0; start < total; start += chunkSamples) {
        const end = Math.min(total, start + chunkSamples);
        const part = audio.slice(start, end);
        self.postMessage({
          type: 'transcribe-progress',
          completed: end,
          total,
          message: `Transcribing audio ${Math.ceil(end / sampleRate)}s / ${Math.ceil(total / sampleRate)}s…`
        });
        const result = await transcriber(part, {
          return_timestamps: true,
          chunk_length_s: 20,
          stride_length_s: 3
        });
        if (result && result.text) allText.push(result.text.trim());
        for (const chunk of (result && result.chunks) || []) {
          const ts = chunk.timestamp || chunk.timestamps;
          if (Array.isArray(ts) && Number.isFinite(ts[0])) {
            const localStart = Number(ts[0]);
            const localEnd = Number.isFinite(ts[1]) ? Number(ts[1]) : localStart + 3;
            allChunks.push({
              start: start / sampleRate + localStart,
              end: start / sampleRate + localEnd,
              text: (chunk.text || '').trim()
            });
          }
        }
      }
      self.postMessage({ type: 'transcript', text: allText.join(' ').trim(), chunks: allChunks });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
  }
};
