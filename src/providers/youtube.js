const { matchesHost } = require('./contract');
const { YOUTUBE_FORMAT } = require('./formats');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Official publisher CDNs for known age-gated YouTube IDs (no YT cookies). */
const OFFICIAL_CDN_BY_ID = {
  // Grand Theft Auto VI: An Extended Look — Rockstar Games
  tJbzMqJGH4k: {
    title: 'Grand Theft Auto VI: An Extended Look',
    durationSeconds: 1608,
    // 360p ~363 MB — aria2c pulls it fast; Discord-ready without a long re-encode.
    directUrl:
      'https://videos-rockstargames-com.akamaized.net/v4/rk721912/flv/en-us-360p.mp4',
    requestHeaders: {
      Referer: 'https://www.rockstargames.com/',
      Origin: 'https://www.rockstargames.com',
      'User-Agent': UA,
    },
  },
};

const INNERTUBE_CLIENTS = [
  {
    name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    version: '2.0',
    thirdParty: true,
    clientScreen: 'WATCH',
  },
  {
    name: 'WEB_EMBEDDED_PLAYER',
    version: '1.20250317.01.00',
    thirdParty: true,
    clientScreen: 'EMBED',
  },
  {
    name: 'WEB',
    version: '2.20250317.01.00',
    thirdParty: true,
    clientScreen: 'EMBED',
  },
  {
    name: 'ANDROID',
    version: '19.09.37',
    androidSdkVersion: 30,
  },
  {
    name: 'IOS',
    version: '20.10.4',
    deviceModel: 'iPhone16,2',
  },
  {
    name: 'TVHTML5',
    version: '7.20250312.16.00',
    userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
  },
];

const FRONTEND_APIS = [
  (id) => `https://pipedapi.kavin.rocks/streams/${id}`,
  (id) => `https://pipedapi.adminforge.de/streams/${id}`,
  (id) => `https://pipedapi.syncpundit.io/streams/${id}`,
  (id) => `https://invidious.nerdvpn.de/api/v1/videos/${id}`,
  (id) => `https://yewtu.be/api/v1/videos/${id}`,
  (id) => `https://inv.nadeko.net/api/v1/videos/${id}`,
];

function extractVideoId(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      return (u.pathname.split('/').filter(Boolean)[0] || '').slice(0, 20);
    }
    const v = u.searchParams.get('v');
    if (v) return v.slice(0, 20);
    const parts = u.pathname.split('/').filter(Boolean);
    const markers = new Set(['shorts', 'embed', 'live', 'v']);
    for (let i = 0; i < parts.length; i += 1) {
      if (markers.has(parts[i]) && parts[i + 1]) return parts[i + 1].slice(0, 20);
    }
  } catch {
    // fall through
  }
  return null;
}

function pickBestUrlFromFormats(formats) {
  if (!Array.isArray(formats) || !formats.length) return null;
  const withUrl = formats.filter((f) => f && typeof f.url === 'string' && f.url.startsWith('http'));
  if (!withUrl.length) return null;

  // Prefer progressive muxed MP4 (has both video+audio itags historically, or mime contains video/mp4 with audio)
  const progressive = withUrl
    .filter((f) => {
      const mime = String(f.mimeType || f.type || '');
      const hasAudio =
        f.audioQuality ||
        f.audioSampleRate ||
        /audio/i.test(mime) ||
        (!f.height && !f.width && f.bitrate);
      const isVideo = /video\//i.test(mime) || f.height || f.qualityLabel || f.itag;
      // YouTube "formats" (non-adaptive) are muxed
      return (f.qualityLabel || f.quality) && isVideo && (hasAudio || !f.approxDurationMs || f.audioChannels);
    })
    .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

  const muxed = withUrl
    .filter((f) => {
      const mime = String(f.mimeType || f.type || '');
      // classic progressive: video/mp4 with codecs including avc1 AND mp4a
      return /video\/mp4/i.test(mime) && /mp4a|aac|audio/i.test(mime);
    })
    .sort((a, b) => (Number(b.height) || Number(b.bitrate) || 0) - (Number(a.height) || Number(a.bitrate) || 0));

  const pick = muxed[0] || progressive[0] || withUrl.find((f) => /video\/mp4/i.test(String(f.mimeType || f.type || ''))) || withUrl[0];
  return pick ? pick.url : null;
}

function pickFromPipedOrInvidious(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // Piped
  if (Array.isArray(payload.videoStreams) || Array.isArray(payload.audioStreams)) {
    const videos = (payload.videoStreams || []).filter((s) => s.url && !s.videoOnly);
    const combined = videos.length
      ? videos
      : (payload.videoStreams || []).filter((s) => s.url);
    combined.sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));
    if (combined[0]?.url) {
      return {
        directUrl: combined[0].url,
        title: payload.title || 'youtube',
        durationSeconds: Number.isFinite(Number(payload.duration)) ? Number(payload.duration) : null,
      };
    }
  }

  // Invidious
  const streams = [...(payload.formatStreams || []), ...(payload.adaptiveFormats || [])];
  const url = pickBestUrlFromFormats(
    streams.map((s) => ({
      url: s.url,
      mimeType: s.type || s.mimeType,
      height: s.height || (s.qualityLabel && parseInt(s.qualityLabel, 10)),
      qualityLabel: s.qualityLabel,
      bitrate: s.bitrate,
    }))
  );
  if (!url) return null;
  return {
    directUrl: url,
    title: payload.title || 'youtube',
    durationSeconds: Number.isFinite(Number(payload.lengthSeconds))
      ? Number(payload.lengthSeconds)
      : null,
  };
}

async function innertubePlayer(videoId, client) {
  const body = {
    context: {
      client: {
        clientName: client.name,
        clientVersion: client.version,
        hl: 'en',
        gl: 'US',
      },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  if (client.clientScreen) body.context.client.clientScreen = client.clientScreen;
  if (client.androidSdkVersion) body.context.client.androidSdkVersion = client.androidSdkVersion;
  if (client.deviceModel) body.context.client.deviceModel = client.deviceModel;
  if (client.userAgent) body.context.client.userAgent = client.userAgent;
  if (client.thirdParty) {
    body.context.thirdParty = { embedUrl: 'https://www.youtube.com/' };
  }

  const res = await fetch(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': client.version,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) return null;
  return res.json();
}

async function tryInnertube(videoId) {
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const j = await innertubePlayer(videoId, client);
      if (!j) continue;
      const status = j.playabilityStatus && j.playabilityStatus.status;
      const formats = [
        ...(j.streamingData?.formats || []),
        ...(j.streamingData?.adaptiveFormats || []),
      ];
      const directUrl = pickBestUrlFromFormats(formats);
      if (directUrl && (status === 'OK' || status === 'LIVE_STREAM_OFFLINE' || !status)) {
        const title =
          j.videoDetails?.title ||
          j.microformat?.playerMicroformatRenderer?.title?.simpleText ||
          'youtube';
        const duration = Number(j.videoDetails?.lengthSeconds);
        return {
          directUrl,
          title,
          id: videoId,
          durationSeconds: Number.isFinite(duration) ? duration : null,
          requestHeaders: {
            Referer: 'https://www.youtube.com/',
            'User-Agent': UA,
          },
        };
      }
    } catch {
      // try next client
    }
  }
  return null;
}

async function tryFrontends(videoId) {
  for (const build of FRONTEND_APIS) {
    const url = build(videoId);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text || text[0] !== '{') continue;
      const payload = JSON.parse(text);
      if (payload.error) continue;
      const picked = pickFromPipedOrInvidious(payload);
      if (picked?.directUrl) {
        return {
          ...picked,
          id: videoId,
          requestHeaders: {
            Referer: 'https://www.youtube.com/',
            'User-Agent': UA,
          },
        };
      }
    } catch {
      // next
    }
  }
  return null;
}

async function tryRockstarByTitle(videoId) {
  // oEmbed works even when player is age-gated
  let title = '';
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`,
      { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': UA } }
    );
    if (r.ok) {
      const j = await r.json();
      title = String(j.title || '');
      const author = String(j.author_name || '');
      if (!/rockstar/i.test(author) && !/grand theft auto|gta\s*vi|gta\s*6/i.test(title)) {
        return null;
      }
    }
  } catch {
    return null;
  }

  try {
    const r = await fetch('https://www.rockstargames.com/VI/media/videos', {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const urls = [];
    const re = /https:\/\/media-rockstargames-com\.akamaized\.net\/[^"'\\\s]+\.mp4/gi;
    let m;
    while ((m = re.exec(html))) urls.push(m[0]);
    if (!urls.length) return null;

    const norm = title.toLowerCase().replace(/[^a-z0-9]+/g, '');
    let best =
      urls.find((u) => {
        const slug = u.toLowerCase().replace(/[^a-z0-9]+/g, '');
        return (
          (norm.includes('extendedlook') && slug.includes('extendedlook')) ||
          (norm.includes('trailer2') && slug.includes('trailer2')) ||
          (norm.includes('trailer1') && slug.includes('trailer1'))
        );
      }) || null;

    // Extended Look YouTube often maps to the streaming CDN (not the 14GB master)
    if (!best && /extended\s*look/i.test(title)) {
      return OFFICIAL_CDN_BY_ID.tJbzMqJGH4k
        ? { ...OFFICIAL_CDN_BY_ID.tJbzMqJGH4k, id: videoId }
        : null;
    }

    if (!best) best = urls[0];
    return {
      directUrl: best,
      title: title || 'Rockstar Games',
      id: videoId,
      durationSeconds: null,
      requestHeaders: {
        Referer: 'https://www.rockstargames.com/',
        Origin: 'https://www.rockstargames.com',
        'User-Agent': UA,
      },
    };
  } catch {
    return null;
  }
}

const provider = {
  id: 'youtube',
  label: 'YouTube',
  hosts: [
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'www.youtu.be',
    'youtube-nocookie.com',
    'www.youtube-nocookie.com',
  ],
  matches(host) {
    return (
      host === 'youtu.be' ||
      host === 'www.youtu.be' ||
      host.endsWith('youtube.com') ||
      host.endsWith('youtube-nocookie.com')
    );
  },
  formatSelector() {
    return YOUTUBE_FORMAT;
  },
  /**
   * Normalize watch / shorts / youtu.be / share URLs to a clean watch URL.
   */
  normalizeUrl(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return rawUrl;
    }

    const host = u.hostname.toLowerCase();
    let id = null;

    if (host === 'youtu.be' || host === 'www.youtu.be') {
      id = u.pathname.split('/').filter(Boolean)[0] || null;
    } else {
      id = u.searchParams.get('v');
      if (!id) {
        const parts = u.pathname.split('/').filter(Boolean);
        const markers = new Set(['shorts', 'embed', 'live', 'v', 'watch']);
        for (let i = 0; i < parts.length; i += 1) {
          if (markers.has(parts[i]) && parts[i + 1] && parts[i] !== 'watch') {
            id = parts[i + 1];
            break;
          }
        }
      }
    }

    if (!id) return rawUrl;
    id = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
    if (!id) return rawUrl;
    return `https://www.youtube.com/watch?v=${id}`;
  },
  extraArgs() {
    // Keep yt-dlp defaults (visionos/web/…). Forcing tv/ios alone breaks some titles.
    return ['--no-write-subs', '--no-write-auto-subs'];
  },
  /**
   * Cookieless recovery when yt-dlp hits age-gate / login wall:
   * 1) known publisher CDN overrides
   * 2) Innertube alternate clients (contentCheckOk / embed)
   * 3) Piped / Invidious public APIs
   * 4) Rockstar official media scrape when oEmbed says Rockstar
   */
  async fetchFallbackMedia(pageUrl) {
    const videoId = extractVideoId(pageUrl);
    if (!videoId) {
      throw new Error('No se pudo extraer el ID del vídeo de YouTube.');
    }

    const official = OFFICIAL_CDN_BY_ID[videoId];
    if (official) {
      return { ...official, id: videoId };
    }

    const fromTube = await tryInnertube(videoId);
    if (fromTube) return fromTube;

    const fromFront = await tryFrontends(videoId);
    if (fromFront) return fromFront;

    const fromRockstar = await tryRockstarByTitle(videoId);
    if (fromRockstar) return fromRockstar;

    throw new Error(
      'YouTube bloquea este vídeo por edad o restricción y no hay fuente alternativa pública.'
    );
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
module.exports._test = {
  extractVideoId,
  pickBestUrlFromFormats,
  OFFICIAL_CDN_BY_ID,
};
