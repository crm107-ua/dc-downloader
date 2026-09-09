const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function run(command, args, options = {}) {
  const {
    onStdout,
    onStderr,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    rollingBuffer = false,
    ...spawnOptions
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...spawnOptions,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const append = (current, text) => {
      const next = current + text;
      if (!rollingBuffer) return next;
      return next.slice(-80000);
    };

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
        stdout = append(stdout, text);
        if (typeof onStdout === 'function') onStdout(text);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr = append(stderr, text);
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

/** Choose output resolution from available video bitrate for best perceived quality */
function pickScaleForBitrate(videoBitrateKbps) {
  if (videoBitrateKbps >= 1800) return '1920:1080';
  if (videoBitrateKbps >= 900) return '1280:720';
  if (videoBitrateKbps >= 450) return '854:480';
  if (videoBitrateKbps >= 250) return '640:360';
  return '480:270';
}

function makeProgressHandler(duration, onProgress, passIndex, passCount) {
  let buffer = '';
  return (text) => {
    if (typeof onProgress !== 'function') return;
    buffer += text;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || '';
    for (const line of parts) {
      const local = parseFfmpegProgress(`${line}\n`, duration);
      if (local == null) continue;
      const base = (passIndex / passCount) * 100;
      const span = 100 / passCount;
      onProgress(base + (local / 100) * span, {
        attempt: passIndex + 1,
        attempts: passCount,
      });
    }
  };
}

/**
 * Quality-first compression under maxBytes.
 * Uses 2-pass x264 when needed; prefers readable resolution for the target bitrate.
 */
async function compressToLimit(inputPath, outputPath, maxBytes, onProgress) {
  const duration = await probeDuration(inputPath);
  const inputSize = fs.statSync(inputPath).size;

  if (inputSize <= maxBytes) {
    if (typeof onProgress === 'function') onProgress(15, { attempt: 1, attempts: 1 });
    try {
      await run(
        'ffmpeg',
        ['-y', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', outputPath],
        { timeoutMs: 60000 }
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

  // Leave headroom under Discord cap
  const targetBytes = Math.floor(maxBytes * 0.94);
  const totalBitrateKbps = Math.max(160, Math.floor((targetBytes * 8) / duration / 1000));

  // Keep enough audio for clarity; rest goes to video
  const audioBitrateKbps = totalBitrateKbps >= 400 ? 128 : totalBitrateKbps >= 250 ? 96 : 64;
  const videoBitrateKbps = Math.max(100, totalBitrateKbps - audioBitrateKbps);
  const scale = pickScaleForBitrate(videoBitrateKbps);

  // Quality ladder: medium 2-pass first, then smaller scale if still oversize
  const attempts = [
    { videoBitrateKbps, scale, preset: 'medium', twoPass: true },
    {
      videoBitrateKbps: Math.max(90, Math.floor(videoBitrateKbps * 0.85)),
      scale: pickScaleForBitrate(videoBitrateKbps * 0.75),
      preset: 'medium',
      twoPass: true,
    },
    {
      videoBitrateKbps: Math.max(80, Math.floor(videoBitrateKbps * 0.7)),
      scale: pickScaleForBitrate(videoBitrateKbps * 0.55),
      preset: 'slow',
      twoPass: false,
    },
  ];

  const passLogBase = path.join(os.tmpdir(), `dc-dlp-${process.pid}-${Date.now()}`);
  let lastError = null;
  // Allow longer encodes; heartbeat keeps Discord UI alive
  const attemptTimeoutMs = Math.min(12 * 60 * 1000, Math.max(90 * 1000, Math.ceil(duration * 1500)));

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const vf = `scale=${attempt.scale}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`;
    const commonVideo = [
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-preset',
      attempt.preset,
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      `${attempt.videoBitrateKbps}k`,
      '-maxrate',
      `${Math.floor(attempt.videoBitrateKbps * 1.15)}k`,
      '-bufsize',
      `${attempt.videoBitrateKbps * 2}k`,
      '-x264-params',
      'aq-mode=3:aq-strength=0.9:ref=3:me=umh:subme=7',
    ];

    try {
      if (attempt.twoPass) {
        const passlog = `${passLogBase}-${i}`;
        // Pass 1
        await run(
          'ffmpeg',
          [
            '-y',
            '-threads',
            '0',
            '-i',
            inputPath,
            ...commonVideo,
            '-pass',
            '1',
            '-passlogfile',
            passlog,
            '-an',
            '-f',
            'null',
            process.platform === 'win32' ? 'NUL' : '/dev/null',
          ],
          {
            timeoutMs: attemptTimeoutMs,
            rollingBuffer: true,
            onStderr: makeProgressHandler(duration, onProgress, i * 2, attempts.length * 2),
          }
        );

        // Pass 2
        await run(
          'ffmpeg',
          [
            '-y',
            '-threads',
            '0',
            '-i',
            inputPath,
            ...commonVideo,
            '-pass',
            '2',
            '-passlogfile',
            passlog,
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
          ],
          {
            timeoutMs: attemptTimeoutMs,
            rollingBuffer: true,
            onStdout: makeProgressHandler(duration, onProgress, i * 2 + 1, attempts.length * 2),
          }
        );

        // Cleanup x264 pass logs
        for (const suffix of ['-0.log', '-0.log.mbtree', '.log', '.log.mbtree']) {
          try {
            fs.unlinkSync(`${passlog}${suffix}`);
          } catch {
            // ignore
          }
        }
      } else {
        await run(
          'ffmpeg',
          [
            '-y',
            '-threads',
            '0',
            '-i',
            inputPath,
            ...commonVideo,
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
          ],
          {
            timeoutMs: attemptTimeoutMs,
            rollingBuffer: true,
            onStdout: makeProgressHandler(duration, onProgress, i, attempts.length),
          }
        );
      }

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
