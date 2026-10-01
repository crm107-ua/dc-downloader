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
      if (/please report this issue/i.test(t)) return false;
      if (/Confirm you are on the latest version/i.test(t)) return false;
      if (/filling out the appropriate issue template/i.test(t)) return false;
      if (/yt-dlp -U/i.test(t)) return false;
      return true;
    })
    .map((line) =>
      line
        .replace(/^ERROR:\s*/i, '')
        .replace(/^\[instagram:user\]\s*[^:]+:\s*/i, '')
        .replace(/^\[Instagram\]\s*[^:]+:\s*/i, '')
        .replace(/^\[([^\]]+)\]\s*/i, '')
        .trim()
    )
    .filter(Boolean)
    .join('\n')
    .trim();

  if (/comfortable for some audiences|Log in for access/i.test(msg)) {
    return 'TikTok no permite descargar este vídeo (contenido restringido o privado).';
  }
  if (/Restricted Video|isn't available to everyone|can't be seen by certain audiences/i.test(msg)) {
    return 'Instagram no permite descargar este vídeo (contenido restringido o privado).';
  }
  if (
    /instagram:user|Unable to extract data|Private profile|profile page/i.test(msg) ||
    /no es un reel ni un post/i.test(msg)
  ) {
    return 'Ese enlace de Instagram no es un reel, post o carrusel. Pega el enlace del vídeo o la foto concreta.';
  }
  if (/HTTP Error 403:\s*Blocked|Unable to download webpage: HTTP Error 403/i.test(msg)) {
    return 'El servidor de media bloqueó la descarga (403). Prueba de nuevo o con otro enlace.';
  }
  if (/authentication is required|login required|Log into an account/i.test(msg)) {
    return 'El enlace no se pudo descargar (privado o no disponible).';
  }
  if (/Plataforma no soportada/i.test(msg)) return msg;

  // Keep a single clean line when possible
  const first = msg.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || msg;
  return first.slice(0, 500) || 'Error desconocido al descargar.';
}

module.exports = {
  formatDownloadError,
};
