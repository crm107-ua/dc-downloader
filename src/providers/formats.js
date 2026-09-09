/**
 * Prefer higher-quality sources; compressor decides final size/resolution.
 * H.264/MP4 preferred for compatibility and faster decode before re-encode.
 */
const FAST_FORMAT = [
  'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[height<=1080][ext=mp4]',
  'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]',
  'bv*[height<=1080]+ba/b[height<=1080]',
  'bv*[height<=720]+ba/b[height<=720]',
  'best',
].join('/');

const YOUTUBE_FORMAT = [
  'bv*[height<=1080][fps<=60][vcodec^=avc1]+ba[ext=m4a]/b[height<=1080][ext=mp4]',
  'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[height<=1080][ext=mp4]',
  'bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]',
  'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]',
  'bv*[height<=1080]+ba/b[height<=1080]',
  'best[height<=1080]/best',
].join('/');

module.exports = { FAST_FORMAT, YOUTUBE_FORMAT };
