# Proveedores

Todo lo específico de una plataforma vive en `src/providers/<id>.js`.  
Registro único: array `PROVIDERS` en [`src/providers/index.js`](../src/providers/index.js).  
Contrato documentado en [`src/providers/contract.js`](../src/providers/contract.js).

---

## Contrato

| Campo | Obligatorio | Descripción |
|-------|-------------|-------------|
| `id` / `label` | Sí | Clave interna y nombre visible |
| `hosts` y/o `matches(host)` | Sí | Matching de hostname |
| `formatSelector()` | Sí | String para `yt-dlp -f` |
| `extraArgs(opts)` | Sí | Flags extra yt-dlp (`playlistItem`, `mediaKind`, …) |
| `normalizeUrl(url)` | No | Limpia tracking / canonicaliza |
| `analyzeMeta(meta)` | No | p. ej. watermark TikTok |
| `listMediaChoices(url, ctx)` | No | Carruseles → items `{ index, kind, label }` |
| `resolveSource(url, ctx)` | No | Reescribe URL (Spotify → YouTube MV) |
| `resolveCaption(url, meta)` | No | Texto completo para `/video descripcion` |
| `fetchFallbackMedia(url)` | No | CDN / índice público si yt-dlp falla |

Helpers de resolución: `resolveProviderByUrl`, `resolveProviderByHost`, `supportedLabels*`.

**Regla:** si algo solo aplica a un sitio, va al módulo del provider — no a `downloader.js` / `compressor.js` / comandos.

---

## Plataformas

| Plataforma | Hosts / URLs | Fuente | Notas |
|------------|--------------|--------|-------|
| **X / Twitter** | `x.com`, `twitter.com` | `FAST_FORMAT` ≤1080p H.264 | Caption vía fxtwitter; cookies opcionales |
| **Reddit** | `reddit.com`, `old.reddit.com`, `redd.it` (posts y `/s/`) | Preferir **DASH/HLS** (vídeo+audio); CMAF suele ser **solo vídeo** | `fetchFallbackMedia` si JSON anti-bot / 403 `i.redd.it`; no pedir cookies al usuario |
| **YouTube** | `youtube.com`, `youtu.be`, `youtube-nocookie.com` | `YOUTUBE_FORMAT` AVC+M4A | Age-gate / bot-check → `fetchFallbackMedia`; `-N 1` en auth-wall |
| **TikTok** | `tiktok.com`, `vm.`, `vt.` | Prefer `play_addr` / h264; evita watermark `download` | `--impersonate chrome`; fallback CDN sin cookies |
| **Instagram** | `instagram.com`, `instagr.am` | Progressive `3/2/1` H.264 (no DASH VP9) | Carruseles → Select Menu; restringidos → fallback |
| **Facebook** | `facebook.com`, `fb.watch` | `hd/sd` progressive | `normalizeUrl` unifica reel/watch |
| **Spotify** | `open.spotify.com/track/…` | Videoclip ≈ duración del track | Rechaza previews ~30 s, lyrics/audio/visualiser; siempre adjunto ≤10 MB |

---

## Añadir un proveedor

1. Crear `src/providers/<id>.js` (partir de `youtube.js` o `tiktok.js`).
2. Registrarlo en `PROVIDERS` en `src/providers/index.js`.
3. (Opcional) URL de prueba en `scripts/test-download.js`.
4. Reiniciar el bot / `pm2 restart dc-downloader`.

No hace falta tocar downloader, compressor ni Discord.

---

## Pitfalls conocidos (por sitio)

| Caso | Dónde | Qué no hacer |
|------|-------|--------------|
| Reddit mudo | Preferir DASH antes que CMAF | Preferir CMAF “porque es un solo MP4” |
| YouTube bot-check | `youtube.js` + downloader serie | Pedir `COOKIES_FILE` al usuario de Discord |
| Spotify preview corto | `spotify.js` `resolveSource` duración ≥55% track | Aceptar `smart-preview-clips` ~30 s |
| IG freeze (audio sí) | Format progressive + no `-c copy` VP9 | Mezclar DASH VP9 con stream copy |
| Caption con `*cursiva*` | `cleanPostCaption` / `resolveCaption` | Envolver todo en itálicas (Discord corta en `\n`) |
| Spoiler | `attachment.setSpoiler(true)` | `{ spoiler: true }` en el constructor (discord.js lo ignora) |

---

## Ver también

- [Arquitectura](architecture.md)
- [Comandos](commands.md)
- [`../AGENTS.md`](../AGENTS.md) — tabla “dónde tocar cada cosa”
