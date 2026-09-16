/**
 * User-facing yt-dlp / download errors (no cookie setup instructions, no Python noise).
 */
function formatDownloadError(raw) {
  let msg = String(raw || 'Error desconocido al descargar.').trim();

  if (msg.startsWith('yt-dlp exited with code')) {
    const idx = msg.indexOf(':');
    msg = idx >= 0 ? msg.slice(idx + 1).trim() : msg;
  }

  msg = msg
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^Deprecated Feature:/i.test(t)) return false;
      if (/Please update to Python/i.test(t)) return false;
      if (/Use --cookies-from-browser/i.test(t)) return false;
      if (/Use --cookies for the authentication/i.test(t)) return false;
      if (/See\s+https:\/\/github.com\/yt-dlp/i.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();

  if (/comfortable for some audiences|Log in for access/i.test(msg)) {
    return 'TikTok no permite descargar este vídeo (contenido restringido o privado).';
  }
  if (/authentication is required|login required|Log into an account/i.test(msg)) {
    return 'El enlace requiere acceso con cuenta y no se puede descargar.';
  }
  if (/Plataforma no soportada/i.test(msg)) return msg;

  return msg.slice(0, 1500) || 'Error desconocido al descargar.';
}

module.exports = {
  formatDownloadError,
};
