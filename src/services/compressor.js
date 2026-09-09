const { spawn } = require('child_process');
const fs = require('fs');

const DEFAULT_TIMEOUT_MS = 90 * 1000;

function run(command, args, options = {}) {
  const { onStdout, onStderr, timeoutMs = DEFAULT_TIMEOUT_MS, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...spawnOptions,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish(
          reject,
          new Error(`${command} exceeded timeout (${Math.round(timeoutMs / 1000)}s)`)
        );
      }, timeoutMs);
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout = (stdout + text).slice(-50000);
        if (typeof onStdout === 'function') onStdout(text);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr = (stderr + text).slice(-50000);
        if (typeof onStderr === 'function') onStderr(text);
      });
    }

    child.on('error', (err) => {
      finish(reject, err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
      } else {
        const detail = (stderr || stdout || '').trim().slice(-2000);
        finish(
          reject,
          new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ''}`)
        );
      }
    });
  });
}

async function probeDuration(filePath) {
  const { stdout } = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ],
    { timeoutMs: 20000 }
  );
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('No se pudo leer la duración del video.');
  }
  return duration;
}

function parseTimestampToSeconds(value) {
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const parts = value.split(':');
  if (parts.length < 2) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return null;
}

function parseFfmpegProgress(chunk, durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) return null;
  if (/progress=end/.test(chunk)) return 100;

  const us = /out_time_us=(\d+)/.exec(chunk);
  if (us) {
    const seconds = Number(us[1]) / 1e6;
    if (Number.isFinite(seconds)) return Math.min(100, (seconds / durationSeconds) * 100);
  }

  const ms = /out_time_ms=(\d+)/.exec(chunk);
  if (ms) {
    const raw = Number(ms[1]);
    if (!Number.isFinite(raw)) return null;
    const seconds = raw > durationSeconds * 2000 ? raw / 1e6 : raw / 1e3;
    return Math.min(100, (seconds / durationSeconds) * 100);
  }

  const ot = /out_time=([0-9:.]+)/.exec(chunk);
  if (ot) {
    const seconds = parseTimestampToSeconds(ot[1]);
    if (seconds != null) return Math.min(100, (seconds / durationSeconds) * 100);
  }

  return null;
}

function pickScale(durationSeconds) {
  // Longer clips start smaller so encode stays quick under the 10MB cap
  if (durationSeconds > 180) return '640:360';
  if (durationSeconds > 60) return '854:480';
  return '1280:720';
}

/**
 * Fast path to Discord size limit: skip encode when already small,
 * otherwise ultrafast x264 with early downscale (2 attempts max).
 */
async function compressToLimit(inputPath, outputPath, maxBytes, onProgress) {
  const duration = await probeDuration(inputPath);
  const inputSize = fs.statSync(inputPath).size;

  // Already under limit — remux/copy, no heavy encode
  if (inputSize <= maxBytes) {
    if (typeof onProgress === 'function') onProgress(20, { attempt: 1, attempts: 1 });
    try {
      await run(
        'ffmpeg',
        [
          '-y',
          '-i',
          inputPath,
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          outputPath,
        ],
        { timeoutMs: 45000 }
      );
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size <= maxBytes) {
        if (typeof onProgress === 'function') onProgress(100, { attempt: 1, attempts: 1 });
        return {
          outputPath,
          sizeBytes: fs.statSync(outputPath).size,
          durationSeconds: duration,
        };
      }
    } catch {
      // Fall through to re-encode
    }
    fs.copyFileSync(inputPath, outputPath);
    if (typeof onProgress === 'function') onProgress(100, { attempt: 1, attempts: 1 });
    return {
      outputPath,
      sizeBytes: fs.statSync(outputPath).size,
      durationSeconds: duration,
    };
  }

  const audioBitrateKbps = 64;
  const targetBytes = Math.floor(maxBytes * 0.92);
  const totalBitrateKbps = Math.max(
    70,
    Math.floor((targetBytes * 8) / duration / 1000)
  );
  const videoBitrateKbps = Math.max(40, totalBitrateKbps - audioBitrateKbps);
  const primaryScale = pickScale(duration);

  const attempts = [
    {
      videoBitrateKbps,
      scale: primaryScale,
      preset: 'ultrafast',
    },
    {
      videoBitrateKbps: Math.max(32, Math.floor(videoBitrateKbps * 0.55)),
      scale: duration > 60 ? '480:270' : '640:360',
      preset: 'ultrafast',
    },
  ];

  let lastError = null;
  const attemptTimeoutMs = Math.min(90000, Math.max(25000, Math.ceil(duration * 1200)));

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const args = [
      '-y',
      '-threads',
      '0',
      '-i',
      inputPath,
      '-vf',
      `scale=${attempt.scale}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      attempt.preset,
      '-tune',
      'fastdecode',
      '-x264-params',
      'ref=1:bframes=0:rc-lookahead=0:aq-mode=0:me=dia:subme=0:trellis=0:weightp=0',
      '-b:v',
      `${attempt.videoBitrateKbps}k`,
      '-maxrate',
      `${attempt.videoBitrateKbps}k`,
      '-bufsize',
      `${attempt.videoBitrateKbps * 2}k`,
      '-c:a',
      'aac',
      '-b:a',
      `${audioBitrateKbps}k`,
      '-ac',
      '2',
      '-ar',
      '44100',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-nostats',
      outputPath,
    ];

    try {
      let buffer = '';
      await run('ffmpeg', args, {
        timeoutMs: attemptTimeoutMs,
        onStdout: (text) => {
          buffer += text;
          const parts = buffer.split(/\r?\n/);
          buffer = parts.pop() || '';
          for (const line of parts) {
            const local = parseFfmpegProgress(`${line}\n`, duration);
            if (local == null || typeof onProgress !== 'function') continue;
            const base = (i / attempts.length) * 100;
            const span = 100 / attempts.length;
            onProgress(base + (local / 100) * span, {
              attempt: i + 1,
              attempts: attempts.length,
            });
          }
        },
      });

      if (typeof onProgress === 'function') {
        onProgress(((i + 1) / attempts.length) * 100, {
          attempt: i + 1,
          attempts: attempts.length,
        });
      }

      if (!fs.existsSync(outputPath)) {
        lastError = new Error('FFmpeg no generó archivo de salida.');
        continue;
      }

      const size = fs.statSync(outputPath).size;
      if (size <= maxBytes) {
        if (typeof onProgress === 'function') {
          onProgress(100, { attempt: i + 1, attempts: attempts.length });
        }
        return {
          outputPath,
          sizeBytes: size,
          durationSeconds: duration,
        };
      }
      lastError = new Error(
        `Compresión quedó en ${(size / 1024 / 1024).toFixed(2)}MB (límite ${(maxBytes / 1024 / 1024).toFixed(0)}MB)`
      );
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('No se pudo comprimir el video bajo el límite.');
}

module.exports = {
  compressToLimit,
  probeDuration,
  run,
  parseFfmpegProgress,
};
