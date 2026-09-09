const { spawn } = require('child_process');
const fs = require('fs');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
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

/**
 * Compress input so output is strictly under maxBytes.
 * Uses bitrate targeting, then a more aggressive 480p pass if needed.
 */
async function compressToLimit(inputPath, outputPath, maxBytes) {
  const duration = await probeDuration(inputPath);
  const audioBitrateKbps = 96;
  // Leave ~5% headroom under the hard cap
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

  for (const attempt of attempts) {
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
    ];

    if (attempt.scale) {
      args.push('-vf', `scale=${attempt.scale}:force_original_aspect_ratio=decrease`);
    }

    args.push(outputPath);

    try {
      await run('ffmpeg', args);
      const size = fs.statSync(outputPath).size;
      if (size <= maxBytes) {
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
