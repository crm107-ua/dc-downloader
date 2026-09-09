/**
 * Shared yt-dlp format preference.
 * Prefer <=720p H.264/MP4 so download+encode stay fast and look decent.
 */
const FAST_FORMAT = [
  'bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]',
  'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]',
  'bv*[height<=720]+ba/b[height<=720]',
  'bv*[height<=480]+ba/b[height<=480]',
  'best[height<=720]/best',
].join('/');

/** YouTube-specific: avoid 1080p60/AV1 monsters that stall compression */
const YOUTUBE_FORMAT = [
  'bv*[height<=720][fps<=30][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]',
  'bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]',
  'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]',
  'bv*[height<=720]+ba/b[height<=720]',
  'bv*[height<=480]+ba/b[height<=480]',
  'best[height<=720]/best',
].join('/');

module.exports = { FAST_FORMAT, YOUTUBE_FORMAT };
