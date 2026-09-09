/**
 * Shared yt-dlp format preference: keep sources small so compression is fast.
 * Prefer <=720p / smaller streams; still fall back if provider lacks them.
 */
const FAST_FORMAT =
  [
    'bv*[height<=720][filesize_approx<=12M]+ba/b[height<=720][filesize_approx<=12M]',
    'bv*[height<=720]+ba/b[height<=720]',
    'bv*[height<=480]+ba/b[height<=480]',
    'wv*+ba/w',
    'best',
  ].join('/');

module.exports = { FAST_FORMAT };
