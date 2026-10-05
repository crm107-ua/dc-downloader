/**
 * User-facing yt-dlp / download errors (no cookie setup instructions, no Python noise).
 */
function formatDownloadError(raw) {
  const original = String(raw || 'Error desconocido al descargar.').trim();

  // Match known cases on the raw string first (cookie boilerplate shares the same line).
  if (/Sign in to confirm your age|may be inappropriate for some users/i.test(original)) {
    return 'YouTube bloquea este vídeo por edad. Se intentó fuente alternativa automáticamente; si falló, el vídeo no tiene CDN/público disponible.';
  }
  if (/no hay fuente alternativa pública/i.test(original)) {
    return 'YouTube bloquea este vídeo por edad o restricción y no hay fuente alternativa pública.';
  }
  if (/comfortable for some audiences|Log in for access/i.test(original)) {
    return 'TikTok no permite descargar este vídeo (contenido restringido o privado).';
  }
  if (/Restricted Video|isn't available to everyone|can't be seen by certain audiences/i.test(original)) {
    return 'Instagram no permite descargar este vídeo (contenido restringido o privado).';
  }
  if (/instagram:user|Unable to extract data/i.test(original)) {
    return 'Ese enlace de Instagram no es un reel, post o carrusel. Pega el enlace del vídeo o la foto concreta.';
  }

  let msg = original;
  if (msg.startsWith('yt-dlp exited with code')) {
    const idx = msg.indexOf(':');
    msg = idx >= 0 ? msg.slice(idx + 1).trim() : msg;
  }

  msg = msg
    .split(/\r?\n/)
    .map((line) => {
      let t = line.trim();
      if (!t) return '';
      if (/^Deprecated Feature:/i.test(t)) return '';
      if (/Please update to Python/i.test(t)) return '';
      if (/^Use --cookies-from-browser/i.test(t)) return '';
      if (/^Use --cookies for the authentication/i.test(t)) return '';
      if (/^See\s+https:\/\/github.com\/yt-dlp/i.test(t)) return '';
      if (/^Confirm you are on the latest version/i.test(t)) return '';
      if (/^filling out the appropriate issue template/i.test(t)) return '';

      t = t.replace(/;?\s*please report this issue on\s+https?:\/\/\S+/i, '');
      t = t.replace(/,?\s*filling out the appropriate issue template\.?/i, '');
      t = t.replace(/Confirm you are on the latest version using\s+yt-dlp -U\.?/i, '');
      t = t.replace(/\s*Use --cookies-from-browser or --cookies for the authentication\.?/gi, '');
      t = t.replace(/\s*See\s+https:\/\/github\.com\/yt-dlp\/\S+/gi, '');
      t = t.replace(/https?:\/\/github\.com\/yt-dlp\/\S+/gi, '');
      t = t.replace(/^ERROR:\s*/i, '');
      t = t.replace(/^\[instagram:user\]\s*[^:]+:\s*/i, 'instagram:user: ');
      t = t.replace(/^\[Instagram\]\s*[^:]+:\s*/i, '');
      t = t.replace(/^\[([^\]]+)\]\s*/i, '');
      return t.replace(/\s{2,}/g, ' ').trim();
    })
    .filter(Boolean)
    .join('\n')
    .trim();

  if (/Descarga directa falló \(HTTP 403\)|unable to download video data:\s*HTTP Error 403|YouTube bloqueó la descarga del stream \(403\)/i.test(original)) {
    return 'YouTube bloqueó temporalmente la descarga (403). Espera un momento y vuelve a intentarlo.';
  }
  if (/HTTP Error 403:\s*Blocked|Unable to download webpage: HTTP Error 403/i.test(msg)) {
    return 'El servidor de media bloqueó la descarga (403). Prueba de nuevo o con otro enlace.';
  }
  if (/authentication is required|login required|Log into an account/i.test(msg)) {
    return 'El enlace no se pudo descargar (privado o no disponible).';
  }
  if (/Plataforma no soportada/i.test(msg)) return msg;

  const first = msg.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || msg;
  return first.slice(0, 500) || 'Error desconocido al descargar.';
}

module.exports = {
  formatDownloadError,
};
