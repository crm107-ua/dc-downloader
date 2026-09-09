const { spawn } = require('child_process');
const fs = require('fs');

function run(command, args, options = {}) {
  const { onStdout, onStderr, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...spawnOptions,
    });

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        if (typeof onStdout === 'function') onStdout(text);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        if (typeof onStderr === 'function') onStderr(text);
      });
    }

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = (stderr || stdout || '').trim().slice(-2000);
        reject(new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}

async function probeDuration(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('No se pudo leer la duración del video.');
  }
  return duration;
}

function parseFfmpegProgress(chunk, durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) return null;
  const match = /out_time_ms=(\d+)/.exec(chunk);
  if (!match) {
    if (/progress=end/.test(chunk)) return 100;
    return null;
  }
  const outMs = Number(match[1]);
  if (!Number.isFinite(outMs)) return null;
  return Math.min(100, (outMs / 1000 / durationSeconds) * 100);
}

/**
 * Compress input so output is strictly under maxBytes.
 * @param {(ratio: number, meta: { attempt: number, attempts: number }) => void} [onProgress]
 */
async function compressToLimit(inputPath, outputPath, maxBytes, onProgress) {
  const duration = await probeDuration(inputPath);
  const audioBitrateKbps = 96;
  const targetBytes = Math.floor(maxBytes * 0.95);
  const totalBitrateKbps = Math.max(
    80,
    Math.floor((targetBytes * 8) / duration / 1000)
  );
  let videoBitrateKbps = Math.max(48, totalBitrateKbps - audioBitrateKbps);

  const attempts = [
    { videoBitrateKbps, scale: null },
    { videoBitrateKbps: Math.max(48, Math.floor(videoBitrateKbps * 0.65)), scale: '1280:720' },
    { videoBitrateKbps: Math.max(40, Math.floor(videoBitrateKbps * 0.4)), scale: '854:480' },
    { videoBitrateKbps: Math.max(32, Math.floor(videoBitrateKbps * 0.25)), scale: '640:360' },
  ];

  let lastError = null;

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const args = [
      '-y',
      '-i',
      inputPath,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
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
      '-movflags',
      '+faststart',
      '-pix_fmt',
      'yuv420p',
      '-progress',
      'pipe:1',
      '-nostats',
    ];

    if (attempt.scale) {
      args.push('-vf', `scale=${attempt.scale}:force_original_aspect_ratio=decrease`);
    }

    args.push(outputPath);

    try {
      let buffer = '';
      await run('ffmpeg', args, {
        onStdout: (text) => {
          buffer += text;
          const parts = buffer.split(/\r?\n/);
          buffer = parts.pop() || '';
          for (const line of parts) {
            const local = parseFfmpegProgress(`${line}\n`, duration);
            if (local == null || typeof onProgress !== 'function') continue;
            // Distribute progress across attempts so retries still move the bar
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

      const size = fs.statSync(outputPath).size;
      if (size <= maxBytes) {
        if (typeof onProgress === 'function') onProgress(100, { attempt: i + 1, attempts: attempts.length });
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
};
