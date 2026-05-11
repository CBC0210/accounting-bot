const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const VOICE_TMP_DIR = path.resolve(process.cwd(), 'data', 'voice-temp');
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const OPENAI_TRANSCRIBE_MODEL = String(process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1').trim();
const OPENAI_TRANSCRIBE_LANGUAGE = String(process.env.OPENAI_TRANSCRIBE_LANGUAGE || 'zh').trim();
const WHISPER_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS || 180000);
const FFMPEG_BIN = process.env.FFMPEG_BIN
  || (fs.existsSync('/home/linuxbrew/.linuxbrew/bin/ffmpeg') ? '/home/linuxbrew/.linuxbrew/bin/ffmpeg' : 'ffmpeg');

function fetchCompat(url, options) {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch(url, options);
  }
  return import('node-fetch').then((m) => m.default(url, options));
}

function guessFileExtension(urlOrName = '') {
  const source = String(urlOrName || '').toLowerCase();
  const match = source.match(/\.(ogg|oga|mp3|wav|m4a|webm|aac|flac)(?:$|\?)/i);
  return match ? `.${match[1]}` : '.ogg';
}

function runCommand(cmd, args, timeoutMs = WHISPER_TIMEOUT_MS) {
  const ffmpegDir = path.dirname(FFMPEG_BIN);
  const pathEntries = [
    ffmpegDir,
    '/home/linuxbrew/.linuxbrew/bin',
    process.env.PATH || '',
  ].filter(Boolean);
  const mergedPath = Array.from(new Set(pathEntries.join(':').split(':').filter(Boolean))).join(':');

  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PATH: mergedPath },
    }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || stdout || error.message || 'whisper failed').trim();
        reject(new Error(message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function transcribeAudioAttachment(attachment, options = {}) {
  const audioUrl = String(attachment?.url || '').trim();
  if (!audioUrl) return null;
  if (!OPENAI_API_KEY) {
    throw new Error('voice_transcription_failed（缺少 OPENAI_API_KEY）');
  }

  await fsp.mkdir(VOICE_TMP_DIR, { recursive: true });
  const ext = guessFileExtension(attachment?.name || audioUrl);
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const inputPath = path.join(VOICE_TMP_DIR, `${seed}${ext}`);
  const wavPath = path.join(VOICE_TMP_DIR, `${seed}.wav`);
  const errorLogPath = path.join(VOICE_TMP_DIR, 'last-whisper-error.log');

  try {
    const response = await fetchCompat(audioUrl);
    if (!response.ok) {
      throw new Error(`download audio failed: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fsp.writeFile(inputPath, buffer);

    // 先用 ffmpeg 轉成 16k mono wav，降低各種語音編碼造成的 Whisper 失敗率
    await runCommand(FFMPEG_BIN, [
      '-y',
      '-i', inputPath,
      '-ac', '1',
      '-ar', '16000',
      '-vn',
      wavPath,
    ], options.timeoutMs || WHISPER_TIMEOUT_MS);

    const wavBuffer = await fsp.readFile(wavPath);
    const form = new FormData();
    form.append('model', options.model || OPENAI_TRANSCRIBE_MODEL);
    form.append('response_format', 'json');
    if (options.language || OPENAI_TRANSCRIBE_LANGUAGE) {
      form.append('language', options.language || OPENAI_TRANSCRIBE_LANGUAGE);
    }
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), `${seed}.wav`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || WHISPER_TIMEOUT_MS);
    let apiResp;
    try {
      apiResp = await fetchCompat(`${OPENAI_BASE_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!apiResp?.ok) {
      const errText = await apiResp.text().catch(() => '');
      await fsp.writeFile(errorLogPath, errText || `OpenAI ${apiResp?.status || 'request failed'}`, 'utf8').catch(() => {});
      throw new Error(`voice_transcription_failed（詳見 ${errorLogPath}）`);
    }

    const data = await apiResp.json().catch(() => null);
    const text = String(data?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      await fsp.writeFile(errorLogPath, JSON.stringify(data || {}, null, 2), 'utf8').catch(() => {});
      throw new Error(`voice_transcription_failed（詳見 ${errorLogPath}）`);
    }
    return text;
  } finally {
    await Promise.allSettled([
      fsp.unlink(inputPath),
      fsp.unlink(wavPath),
    ]);
  }
}

module.exports = {
  transcribeAudioAttachment,
};
