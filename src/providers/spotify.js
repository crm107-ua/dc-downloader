const { matchesHost } = require('./contract');
const { YOUTUBE_FORMAT } = require('./formats');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const NO_VIDEOCLIP_MSG = 'No hay videoclip disponible para este track.';

function extractTrackId(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  // /track/ID or /intl-es/track/ID
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === 'track' && parts[i + 1]) {
      const id = parts[i + 1].replace(/[^A-Za-z0-9]/g, '');
      return id.length >= 10 ? id : null;
    }
  }
  return null;
}

function assertTrackUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('URL de Spotify inválida.');
  }
  const parts = u.pathname.split('/').filter(Boolean).map((p) => p.toLowerCase());
  const blocked = ['album', 'playlist', 'artist', 'episode', 'show', 'user', 'collection'];
  for (const b of blocked) {
    if (parts.includes(b)) {
      throw new Error('Solo tracks de Spotify (no álbumes ni playlists).');
    }
  }
  const id = extractTrackId(rawUrl);
  if (!id) {
    throw new Error('Solo tracks de Spotify (enlace /track/…).');
  }
  return id;
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRejectedVideoTitle(title) {
  const t = normalizeText(title);
  return /\b(official audio|audio oficial|lyrics?|lyric video|letra|audio only|visuali[sz]er|visualiser|visualizer|sped up|slowed|nightcore|8d audio|live session|full set|boiler room|cover|karaoke|reaction|fan made)\b/.test(
    t
  );
}

function looksLikeMusicVideo(title) {
  if (isRejectedVideoTitle(title)) return false;
  const t = normalizeText(title);
  return /\b(official music video|official video|video oficial|music video|videoclip|\bmv\b)\b/.test(t);
}

/** Strong artist+title match without MV keywords (many official uploads are just "ARTIST - Title"). */
function looksLikePrimaryUpload(title, track) {
  if (isRejectedVideoTitle(title)) return false;
  const match = titleMatchesTrack(title, track.title, track.artists);
  if (!match || !match.ok || !match.artistHit) return false;
  const yt = normalizeText(title);
  const trackN = normalizeText(track.title);
  // Prefer near-exact "artist - title" style over loose word hits.
  return yt.includes(trackN);
}

function titleMatchesTrack(ytTitle, trackTitle, artists) {
  const yt = normalizeText(ytTitle);
  const track = normalizeText(trackTitle);
  if (!yt || !track) return false;
  // Prefer titles that contain the full track name (word-ish).
  if (!yt.includes(track)) {
    // Allow track words (≥3 chars) majority match.
    const words = track.split(' ').filter((w) => w.length >= 3);
    if (!words.length) return false;
    const hit = words.filter((w) => yt.includes(w)).length;
    if (hit < Math.ceil(words.length * 0.7)) return false;
  }
  // Prefer artist present; soft requirement.
  const artistHit = (artists || []).some((a) => {
    const an = normalizeText(a);
    return an && yt.includes(an);
  });
  return { ok: true, artistHit };
}

async function fetchTrackEntity(trackId) {
  const embedUrl = `https://open.spotify.com/embed/track/${trackId}`;
  const res = await fetch(embedUrl, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) {
    throw new Error(`No se pudo leer el track de Spotify (HTTP ${res.status}).`);
  }
  const html = await res.text();
  const start = html.indexOf('"entity":{');
  if (start < 0) {
    throw new Error('No se pudo leer los metadatos del track de Spotify.');
  }
  // Walk braces from entity object.
  let i = start + '"entity":'.length;
  while (i < html.length && html[i] !== '{') i += 1;
  if (html[i] !== '{') throw new Error('Metadatos Spotify inválidos.');
  let depth = 0;
  let end = -1;
  for (let j = i; j < html.length; j += 1) {
    const ch = html[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = j + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error('Metadatos Spotify incompletos.');
  let entity;
  try {
    entity = JSON.parse(html.slice(i, end));
  } catch {
    throw new Error('No se pudo parsear el track de Spotify.');
  }
  const title = entity.title || entity.name || '';
  const artists = Array.isArray(entity.artists)
    ? entity.artists.map((a) => a && a.name).filter(Boolean)
    : [];
  const durationMs = Number(entity.duration);
  const durationSeconds = Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : null;
  return {
    id: entity.id || trackId,
    title,
    artists,
    durationSeconds,
    hasVideo: Boolean(entity.hasVideo || entity.isMusicVideo),
    videoPreviewUrl:
      entity.videoPreview && typeof entity.videoPreview.url === 'string'
        ? entity.videoPreview.url
        : null,
  };
}

const YT_SEARCH_APIS = [
  (q) => `https://pipedapi.reallyaweso.me/search?q=${encodeURIComponent(q)}&filter=videos`,
  (q) => `https://pipedapi.nosebs.ru/search?q=${encodeURIComponent(q)}&filter=videos`,
  (q) => `https://pipedapi.adminforge.de/search?q=${encodeURIComponent(q)}&filter=videos`,
  (q) => `https://invidious.nerdvpn.de/api/v1/search?q=${encodeURIComponent(q)}&type=video`,
  (q) => `https://yewtu.be/api/v1/search?q=${encodeURIComponent(q)}&type=video`,
  (q) => `https://iv.ggtyler.dev/api/v1/search?q=${encodeURIComponent(q)}&type=video`,
];

function normalizeSearchHits(items, limit) {
  const out = [];
  for (const it of items || []) {
    const id = String(it.id || it.videoId || it.url?.replace(/^.*[?&]v=/, '') || '').trim();
    const title = String(it.title || it.name || '').trim();
    const duration = Number(
      it.duration || it.lengthSeconds || it.durationSeconds || it.length_seconds
    );
    if (!id || !title || id.length < 6) continue;
    out.push({ id: id.slice(0, 20), title, duration });
    if (out.length >= limit) break;
  }
  return out;
}

async function searchYoutubeViaApis(query, limit = 8) {
  for (const build of YT_SEARCH_APIS) {
    try {
      const res = await fetch(build(query, limit), {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text || (text[0] !== '{' && text[0] !== '[')) continue;
      const payload = JSON.parse(text);
      const items = Array.isArray(payload)
        ? payload
        : payload.items || payload.videos || payload.data || [];
      const hits = normalizeSearchHits(items, limit);
      if (hits.length) return hits;
    } catch {
      // next API
    }
  }
  return [];
}

async function searchYoutubeCandidates(query, run, limit = 8) {
  // Prefer public search APIs — yt-dlp ytsearch often hits the same bot wall as watch URLs.
  const fromApi = await searchYoutubeViaApis(query, limit);
  if (fromApi.length) return fromApi;

  const { stdout } = await run(
    'yt-dlp',
    [
      '--flat-playlist',
      '--print',
      '%(id)s\t%(title)s\t%(duration)s',
      '--no-warnings',
      '--extractor-args',
      'youtube:player_client=android,web_embedded,tv,ios,web',
      `ytsearch${limit}:${query}`,
    ],
    { timeoutMs: 60000 }
  );
  return String(stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id, title, duration] = line.split('\t');
      return {
        id: String(id || '').trim(),
        title: String(title || '').trim(),
        duration: Number(duration),
      };
    })
    .filter((r) => r.id && r.title);
}

/**
 * Videoclip length must be roughly the Spotify track length.
 * Rejects 15–30s smart-preview clips and multi-hour mixes.
 */
function durationCloseEnough(candidateSec, trackSec) {
  const cand = Number(candidateSec);
  const track = Number(trackSec);
  if (!Number.isFinite(cand) || cand <= 0) return false;
  if (cand < 45 || cand > 900) return false;
  if (!Number.isFinite(track) || track <= 0) {
    return cand >= 90;
  }
  // ≥ ~55% of the song; ≤ ~145% + 30s slack.
  if (cand < Math.max(60, track * 0.55)) return false;
  if (cand > track * 1.45 + 30) return false;
  return true;
}

function isSpotifyShortPreviewUrl(url) {
  return /smart-preview-clips|\/previews\/|preview[_-]?clip/i.test(String(url || ''));
}

async function probeMediaDurationSeconds(mediaUrl, run) {
  try {
    const { stdout } = await run(
      'yt-dlp',
      ['--skip-download', '--print', '%(duration)s', '--no-warnings', mediaUrl],
      { timeoutMs: 45000 }
    );
    const n = Number(String(stdout || '').trim().split(/\s+/)[0]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function scoreCandidate(c, track, { mvKeyword, primary }) {
  const match = titleMatchesTrack(c.title, track.title, track.artists);
  if (!match || !match.ok) return null;
  const dur = Number(c.duration);
  if (!durationCloseEnough(dur, track.durationSeconds)) return null;
  let score = primary ? 6 : 10;
  if (mvKeyword) score += 8;
  if (match.artistHit) score += 5;
  if (Number.isFinite(track.durationSeconds) && Number.isFinite(dur)) {
    const delta = Math.abs(dur - track.durationSeconds);
    if (delta <= 15) score += 10;
    else if (delta <= 40) score += 5;
    else if (delta <= 90) score += 1;
  }
  if (/\b(video oficial|official music video|official video)\b/i.test(c.title)) score += 4;
  return { ...c, score };
}

function pickBestMusicVideo(candidates, track) {
  const scored = [];
  for (const c of candidates) {
    if (looksLikeMusicVideo(c.title)) {
      const row = scoreCandidate(c, track, { mvKeyword: true, primary: false });
      if (row) scored.push(row);
      continue;
    }
    if (looksLikePrimaryUpload(c.title, track)) {
      const row = scoreCandidate(c, track, { mvKeyword: false, primary: true });
      if (row) scored.push(row);
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

/**
 * Resolve a Spotify track to a downloadable music-video URL.
 * Order: Spotify-hosted preview/MV (if public) → YouTube official music video search.
 */
async function resolveSource(rawUrl, ctx = {}) {
  const run = ctx.run;
  if (typeof run !== 'function') {
    throw new Error('resolveSource requiere run().');
  }
  const trackId = assertTrackUrl(rawUrl);
  const track = await fetchTrackEntity(trackId);
  if (!track.title) {
    throw new Error('No se pudo leer el título del track de Spotify.');
  }

  // 1) Spotify-hosted video only if full-length (never smart-preview ~30s clips).
  if (track.videoPreviewUrl && /^https?:\/\//i.test(track.videoPreviewUrl)) {
    if (isSpotifyShortPreviewUrl(track.videoPreviewUrl)) {
      console.log(`[spotify] skipping short preview CDN for ${trackId}`);
    } else {
      const previewDur = await probeMediaDurationSeconds(track.videoPreviewUrl, run);
      if (durationCloseEnough(previewDur, track.durationSeconds)) {
        console.log(
          `[spotify] using Spotify video (${previewDur}s ≈ track ${track.durationSeconds}s) for ${trackId}`
        );
        return {
          sourceUrl: track.videoPreviewUrl,
          title: `${track.artists[0] || 'Spotify'} - ${track.title}`,
          trackTitle: track.title,
          artists: track.artists,
          forceAttachment: true,
          downloadMode: 'direct',
        };
      }
      console.log(
        `[spotify] Spotify video duration ${previewDur}s rejected (track ${track.durationSeconds}s); trying YouTube`
      );
    }
  }

  // 2) YouTube official music video search (duration ≈ track).
  const artist = track.artists[0] || '';
  const queries = [
    artist ? `${artist} - ${track.title} official music video` : `${track.title} official music video`,
    artist ? `${artist} ${track.title} video oficial` : `${track.title} video oficial`,
    artist ? `${artist} ${track.title} music video` : `${track.title} music video`,
    // Many official uploads omit "music video" in the title.
    artist ? `${artist} - ${track.title}` : track.title,
  ];

  for (const q of queries) {
    console.log(`[spotify] ytsearch: ${q}`);
    let candidates = [];
    try {
      candidates = await searchYoutubeCandidates(q, run, 8);
    } catch (err) {
      console.warn(`[spotify] ytsearch failed: ${err.message || err}`);
      continue;
    }
    const best = pickBestMusicVideo(candidates, track);
    if (best) {
      console.log(`[spotify] youtube MV ${best.id} · ${best.title}`);
      return {
        sourceUrl: `https://www.youtube.com/watch?v=${best.id}`,
        title: `${artist ? `${artist} - ` : ''}${track.title}`,
        trackTitle: track.title,
        artists: track.artists,
        forceAttachment: true,
        downloadMode: 'ytdlp',
        formatProviderId: 'youtube',
      };
    }
  }

  throw new Error(NO_VIDEOCLIP_MSG);
}

const provider = {
  id: 'spotify',
  label: 'Spotify',
  hosts: ['open.spotify.com', 'spotify.com', 'www.spotify.com'],
  matches(host) {
    return (
      host === 'open.spotify.com' ||
      host === 'spotify.com' ||
      host === 'www.spotify.com' ||
      host.endsWith('.spotify.com')
    );
  },
  normalizeUrl(rawUrl) {
    const id = assertTrackUrl(rawUrl);
    return `https://open.spotify.com/track/${id}`;
  },
  formatSelector() {
    // Spotify MVs are downloaded via YouTube/direct; keep a safe H.264 selector.
    return YOUTUBE_FORMAT;
  },
  extraArgs() {
    return ['--no-write-subs', '--no-write-auto-subs'];
  },
  resolveSource,
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
module.exports.NO_VIDEOCLIP_MSG = NO_VIDEOCLIP_MSG;
module.exports._test = {
  extractTrackId,
  assertTrackUrl,
  looksLikeMusicVideo,
  looksLikePrimaryUpload,
  isRejectedVideoTitle,
  normalizeText,
  pickBestMusicVideo,
  durationCloseEnough,
  isSpotifyShortPreviewUrl,
};
