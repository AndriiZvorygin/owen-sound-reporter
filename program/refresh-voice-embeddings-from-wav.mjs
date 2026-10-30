#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = '/home/htaf/pyac/pyash';
const DEFAULT_VOICES = path.join(ROOT, 'world/voices');

function usage() {
  return [
    'Usage: node program/refresh-voice-embeddings-from-wav.mjs [voices_dir] [include_speaker_keys]',
    'Example: node ... /home/htaf/pyac/pyash/world/voices 0',
    'Notes:',
    '- include_speaker_keys=0 (default): only named voices (not speaker_###).',
    '- include_speaker_keys=1: process all wav files.',
  ].join('\n');
}

function ensureDir(dirPath) {
  const st = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`voices directory not found: ${dirPath}`);
}

function isTruthy(v) {
  return /^(1|true|yes)$/iu.test(String(v || '').trim());
}

function safeIsoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function readPyaMap(filePath) {
  const out = {};
  const text = fs.readFileSync(filePath, 'utf8');
  const re = /^\s*su name (.+?) ob (.+?) ya\s*$/gmu;
  let m;
  while ((m = re.exec(text))) {
    const key = String(m[1] || '').trim();
    const body = String(m[2] || '').trim();
    if (body.startsWith('text ')) {
      const q = body.slice(5).trim();
      try { out[key] = JSON.parse(q); } catch { out[key] = q.replace(/^"|"$/gu, ''); }
    } else if (body.startsWith('num ')) {
      const n = Number(body.slice(4).trim());
      if (Number.isFinite(n)) out[key] = n;
    } else if (body.startsWith('bool ')) {
      out[key] = body.slice(5).trim().toLowerCase() === 'truth';
    }
  }
  return out;
}

function writePyaMap(filePath, data) {
  const lines = ['su name speaker metadata be map def'];
  const keys = Object.keys(data).sort();
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      lines.push(`su name ${key} ob num ${String(value)} ya`);
      continue;
    }
    if (typeof value === 'boolean') {
      lines.push(`su name ${key} ob bool ${value ? 'truth' : 'lie'} ya`);
      continue;
    }
    lines.push(`su name ${key} ob text ${JSON.stringify(String(value ?? ''))} ya`);
  }
  lines.push('prah', '');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

function ffprobeDuration(filePath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { encoding: 'utf8' }).trim();
    const n = Number(out);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function trimVoiceWav({ inputWav, outputWav }) {
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inputWav,
    '-af',
    // Remove only leading/trailing silence, keep interior pauses.
    'silenceremove=start_periods=1:start_duration=0.20:start_threshold=-35dB:stop_periods=1:stop_duration=0.30:stop_threshold=-35dB',
    '-ac', '1',
    '-ar', '16000',
    outputWav,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

function rebuildEmbeddings({ jobs }) {
  const payloadPath = path.join(os.tmpdir(), `voice-embed-jobs-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({ jobs }, null, 2), 'utf8');
  const py = `
import json
import numpy as np
import torch, wave
import torch.nn.functional as F
from pathlib import Path
import torchaudio

if not hasattr(torchaudio, "list_audio_backends"):
    def _list_audio_backends():
        return []
    torchaudio.list_audio_backends = _list_audio_backends

from speechbrain.inference.speaker import SpeakerRecognition

def load_wav(path, target_sr=16000):
    with wave.open(str(path), "rb") as r:
        ch = int(r.getnchannels())
        sw = int(r.getsampwidth())
        sr = int(r.getframerate())
        n = int(r.getnframes())
        pcm = r.readframes(n)
    if sw == 1:
        a = np.frombuffer(pcm, dtype=np.uint8).astype(np.float32)
        a = (a - 128.0) / 128.0
    elif sw == 2:
        a = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        a = np.frombuffer(pcm, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise RuntimeError(f"unsupported wav sample width: {sw}")
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    wav = torch.from_numpy(a).float()
    if sr != target_sr:
        wav3 = wav.unsqueeze(0).unsqueeze(0)
        new_len = max(1, int(round(wav3.shape[-1] * float(target_sr) / float(sr))))
        wav = F.interpolate(wav3, size=new_len, mode="linear", align_corners=False).squeeze(0).squeeze(0)
    return wav

data = json.loads(Path("${payloadPath}").read_text(encoding="utf-8"))
jobs = data.get("jobs", [])
device = "cuda" if torch.cuda.is_available() else "cpu"
model = SpeakerRecognition.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    savedir=str(Path("${ROOT}") / "world" / "temporary" / "speaker" / "speechbrain-ecapa"),
    run_opts={"device": device},
)

for j in jobs:
    wav = load_wav(j["wav"]).unsqueeze(0)
    emb = model.encode_batch(wav, normalize=False).detach().to("cpu").numpy().astype(np.float32).reshape(-1)
    if emb.size == 0:
        raise RuntimeError(f"empty embedding for {j['wav']}")
    np.save(j["npy"], emb)
print(f"rebuilt_embeddings={len(jobs)} device={device}")
`;

  const res = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  fs.rmSync(payloadPath, { force: true });
  if (res.status !== 0) {
    throw new Error(`embedding rebuild failed: ${res.stderr || res.stdout || 'unknown error'}`);
  }
  return String(res.stdout || '').trim();
}

function main() {
  const voicesDirArg = process.argv[2] || DEFAULT_VOICES;
  const includeSpeakerKeysArg = process.argv[3] || '0';
  const voicesDir = path.resolve(process.cwd(), voicesDirArg);
  ensureDir(voicesDir);

  const includeSpeakerKeys = isTruthy(includeSpeakerKeysArg);
  const names = fs.readdirSync(voicesDir)
    .filter((n) => n.endsWith('.wav'))
    .map((n) => path.basename(n, '.wav'))
    .filter((k) => includeSpeakerKeys || !/^speaker_\d+$/iu.test(k))
    .sort();

  if (!names.length) {
    process.stdout.write('[voice-refresh] no eligible wav files found\n');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-refresh-'));
  const jobs = [];
  const changed = [];

  try {
    for (const key of names) {
      const wavPath = path.join(voicesDir, `${key}.wav`);
      const npyPath = path.join(voicesDir, `${key}.npy`);
      const pyaPath = path.join(voicesDir, `${key}.pya`);
      if (!fs.existsSync(wavPath) || !fs.existsSync(npyPath) || !fs.existsSync(pyaPath)) continue;

      const beforeDur = ffprobeDuration(wavPath);
      const trimmedPath = path.join(tmpDir, `${key}.trimmed.wav`);
      trimVoiceWav({ inputWav: wavPath, outputWav: trimmedPath });
      const afterDur = ffprobeDuration(trimmedPath);

      // Keep the original if trim accidentally removes too much.
      const useTrimmed = afterDur >= 0.6 && afterDur <= (beforeDur + 0.2);
      if (useTrimmed) fs.copyFileSync(trimmedPath, wavPath);

      jobs.push({ key, wav: wavPath, npy: npyPath });
      changed.push({
        key,
        duration_before_s: Number(beforeDur.toFixed(3)),
        duration_after_s: Number((useTrimmed ? afterDur : beforeDur).toFixed(3)),
        trimmed_applied: useTrimmed,
      });
    }

    const rebuildLog = rebuildEmbeddings({ jobs });
    process.stdout.write(`[voice-refresh] ${rebuildLog}\n`);

    const now = safeIsoNow();
    for (const item of changed) {
      const pyaPath = path.join(voicesDir, `${item.key}.pya`);
      const meta = readPyaMap(pyaPath);
      meta.updated_at = now;
      meta.sample_count = 1;
      meta.origin = 'repair_trimmed_wav_reembed';
      meta.speaker = item.key;
      if (!meta.name) meta.name = item.key;
      writePyaMap(pyaPath, meta);
      process.stdout.write(
        `[voice-refresh] ${item.key} dur ${item.duration_before_s}s -> ${item.duration_after_s}s trimmed=${item.trimmed_applied ? 'yes' : 'no'}\n`
      );
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
}
