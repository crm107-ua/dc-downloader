# DC Downloader

Bot de Discord que descarga videos cortos de **X**, **Reddit**, **YouTube**, **TikTok**, **Instagram**, **Facebook** y **Spotify** (videoclip de un track), los comprime bajo un límite estricto de tamaño y los publica en el mismo canal.

Diseñado para ser **claro de usar**, **configurable por servidor** (allowlist opcional) y **fácil de extender** con nuevos proveedores.

---

## Índice

1. [Qué hace](#qué-hace)
2. [Primeros pasos](#primeros-pasos)
3. [Comandos](#comandos)
4. [Cola y calidad](#cola-y-calidad)
5. [Arquitectura](#arquitectura)
6. [Flujo de funcionamiento](#flujo-de-funcionamiento)
7. [Proveedores](#proveedores)
8. [Requisitos](#requisitos)
9. [Instalación](#instalación)
10. [Variables de entorno](#variables-de-entorno) · [Alcance por servidor](#alcance-por-servidor)
11. [Producción (PM2)](#producción-pm2)
12. [Pruebas](#pruebas)
13. [Estructura del proyecto](#estructura-del-proyecto)
14. [Plataformas](#plataformas)
15. [Solución de problemas](#solución-de-problemas)

---

## Qué hace

| Aspecto | Detalle |
|---------|---------|
| Entrada | Slash command `/video` con una URL |
| Plataformas | Registry en `src/providers/` |
| Duración máxima | Antes de descargar (`MAX_DURATION_SECONDS`, defecto **1800 s**) |
| Tamaño máximo | MP4 enviado (`MAX_FILE_SIZE_MB`, defecto **10 MB**) |
| Calidad | Opción `calidad`: `auto` (defecto) · `alta` · `rapida` |
| Concurrencia | Cola global: un job activo; el resto espera con posición visible |
| Salida | Solo el archivo MP4 en el canal |
| Acceso | Opcional: limitar a guilds en `DISCORD_ALLOWED_GUILD_IDS` (vacío = todos) |

---

## Primeros pasos

1. Copia `.env.example` → `.env` y rellena token y client ID. Opcionalmente define `DISCORD_ALLOWED_GUILD_IDS` para limitar servidores.
2. Instala **Node.js ≥ 20**, **FFmpeg** y **yt-dlp** (en `PATH`).
3. Instala dependencias y registra comandos:

```bash
npm install
npm run register
npm start
```

4. Invita el bot al servidor (scopes `bot` + `applications.commands`; permisos Send Messages + Attach Files).
5. En Discord: `/video url:https://www.youtube.com/watch?v=...`

Guía corta de uso: [`USO.md`](USO.md).

---

## Comandos

| Comando | Descripción |
|---------|-------------|
| `/video url:<enlace> [calidad] [descripcion] [spoiler]` | Descarga, comprime y envía el video |
| `/help` | Ayuda (mensaje ephemeral) |

### Opción `calidad`

| Valor | Comportamiento |
|-------|----------------|
| `auto` | Equilibrado (**defecto** si no se indica) |
| `alta` | Mejor imagen, encode más lento |
| `rapida` | Encode rápido, menor calidad percibida |

Aplica a **todos** los proveedores.

### Opción `descripcion`

| Valor | Comportamiento |
|-------|----------------|
| `True` | Texto completo del post (X / Reddit / Instagram, etc.) en la card, encima del media |
| `False` / omitida | Solo card del usuario + media |

### Opción `spoiler`

| Valor | Comportamiento |
|-------|----------------|
| `True` | Adjunta el media como spoiler de Discord (contenido delicado) |
| `False` / omitida | Media sin spoiler |

### Spotify

Solo **tracks** (`open.spotify.com/track/…`). Resuelve videoclip de duración ≈ la canción (Spotify completo o YouTube MV / `Artista - Título`; ignora previews ~30 s y lyrics/audio), comprime a ≤10 MB. Sin videoclip → mensaje breve al usuario.

Si Discord aún muestra comandos antiguos, reinicia el bot o ejecuta `npm run register`.

---

## Cola y calidad

**Cola global** (`src/services/jobQueue.js`):

- Varios canales / usuarios pueden lanzar `/video` a la vez.
- Solo se procesa **un** job; el resto muestra *En cola · posición N*.
- Al liberarse el slot, el siguiente arranca automáticamente.
- Evita que FFmpeg/yt-dlp se pisen y dejen la barra “congelada”.

**Compresión** (`src/services/compressor.js`):

- Objetivo: caber en `MAX_FILE_SIZE_MB` con la mejor imagen posible para el modo elegido.
- `alta` / `auto`: x264 multipass cuando hace falta.
- `rapida`: presets rápidos, una pasada.
- La barra de progreso incluye heartbeat para no parecer atascada.

---

## Arquitectura

```
Usuario Discord
      │  /video url + calidad?
      ▼
┌─────────────────┐
│  index.js       │  guard de guild · slash commands
└────────┬────────┘
         ▼
┌─────────────────┐
│  commands/video │  defer · progreso · cola
└────────┬────────┘
         ▼
┌─────────────────┐     si hay otro job activo
│  jobQueue       │◄──── espera con UI "En cola"
└────────┬────────┘
         ▼
┌─────────────────┐     resolve por hostname
│  providers/*    │──────────────────────────┐
└────────┬────────┘                          │
         ▼                                   │
┌─────────────────┐                          │
│  downloader     │  meta → download →       │
│                 │  compress → cleanup      │
└────────┬────────┘                          │
         │                                   │
    yt-dlp / FFmpeg ◄── formatSelector / extraArgs del provider
         ▼
┌─────────────────┐
│  Discord reply  │  attachment MP4
└─────────────────┘
```

| Capa | Responsabilidad |
|------|-----------------|
| `src/index.js` | Cliente Discord, allowlist, registro de comandos |
| `src/commands/` | UX de slash commands |
| `src/providers/` | Todo lo específico de cada sitio |
| `src/services/downloader.js` | Pipeline agnóstico al proveedor |
| `src/services/compressor.js` | Encode H.264/AAC bajo el tope de MB |
| `src/services/jobQueue.js` | Serialización de jobs |
| `src/utils/progress.js` | Embed de progreso + heartbeat |
| `src/services/tempCleanup.js` | Barrido oportunista de `TEMP_DIR` |

El pipeline **no** tiene `if (platform === ...)`. La especificidad vive en el provider.

---

## Flujo de funcionamiento

1. **Invocación** — `/video` en un guild autorizado.
2. **Validación** — URL http(s) + hostname en el registry de providers.
3. **Cola** — Entra en la cola global; si no es el primero, UI de espera.
4. **Metadatos** — `yt-dlp` (light print / dump) → duración ≤ `MAX_DURATION_SECONDS` **antes** de bajar el vídeo.
5. **Descarga** — Formato del provider → `TEMP_DIR/<uuid>/`.
6. **Compresión** — FFmpeg según `calidad` hasta ≤ `MAX_FILE_SIZE_MB`.
7. **Entrega** — Solo el MP4 en el canal; se borra el job.
8. **Limpieza extra** — Al iniciar jobs, barrido de residuos > `TEMP_MAX_AGE_HOURS`.

---

## Proveedores

Contrato en `src/providers/contract.js`. Registry en `src/providers/index.js`.

| Campo | Descripción |
|-------|-------------|
| `id` / `label` | Identificador y nombre visible |
| `hosts` / `matches(host)` | Matching de URL |
| `formatSelector()` | Valor de `yt-dlp -f` |
| `extraArgs()` | Flags extra |
| `analyzeMeta(meta)` | Opcional (p. ej. watermark TikTok) |
| `normalizeUrl(url)` | Opcional (p. ej. YouTube shorts/embed, Instagram reel/p) |

### Añadir un proveedor

1. Crear `src/providers/<id>.js` (copiar `youtube.js` o `tiktok.js`).
2. Registrarlo en el array `PROVIDERS` de `src/providers/index.js`.
3. (Opcional) URL de prueba en `scripts/test-download.js`.
4. Reiniciar el bot.

No hace falta tocar downloader, compressor ni Discord.

---

## Requisitos

- Node.js **≥ 20**
- [FFmpeg](https://ffmpeg.org/) en `PATH`
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) en `PATH` (mantener actualizado: `yt-dlp -U`)
- App de Discord (token + Application ID)

---

## Instalación

```bash
git clone <repo>
cd dc-downloader
cp .env.example .env   # editar valores
npm install
npm run register
npm start
```

**Invitación OAuth2**

- Scopes: `bot` + `applications.commands`
- Permisos: Send Messages, Attach Files

```
https://discord.com/api/oauth2/authorize?client_id=TU_CLIENT_ID&permissions=2147485696&scope=bot%20applications.commands
```

Los slash commands se registran por guild (no globales). El alcance puede limitarse con `DISCORD_ALLOWED_GUILD_IDS`. Ver [Alcance por servidor](#alcance-por-servidor).

---

## Variables de entorno

| Variable | Obligatoria | Descripción | Defecto |
|----------|-------------|-------------|---------|
| `DISCORD_BOT_TOKEN` | Sí | Token del bot | — |
| `DISCORD_CLIENT_ID` | Sí | Application ID | — |
| `DISCORD_ALLOWED_GUILD_IDS` | No | IDs de servidores permitidos (coma-separados). Vacío = cualquier servidor | *(vacío)* |
| `MAX_DURATION_SECONDS` | No | Duración máxima global (todos los providers) | `1800` (30 min) |
| `MAX_FILE_SIZE_MB` | No | Tope del MP4 adjunto (clips ≤5 min) | `10` |
| `TEMP_DIR` | No | Workspace temporal | `./temp` |
| `TEMP_MAX_AGE_HOURS` | No | GC de residuos locales en el VPS | `24` |
| `COOKIES_FILE` | No | Cookies Netscape (opcional, X/Reddit) | — |
| `COOKIES_FROM_BROWSER` | No | p. ej. `chrome`, `edge`, `firefox` | — |
| `R2_ENABLED` | No | `1` para activar vídeos largos vía Cloudflare R2 | `0` |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Si R2 | Credenciales S3 de R2 | — |
| `R2_BUCKET` | Si R2 | Nombre del bucket | `dc-downloader` |
| `R2_ENDPOINT` | Si R2 | Endpoint S3 de la cuenta | — |
| `R2_PUBLIC_BASE_URL` | Si R2 | URL pública (`pub-….r2.dev` o dominio custom) | — |
| `R2_LONG_VIDEO_SECONDS` | No | Umbral adjunto vs R2 (defecto 5 min) | `300` |
| `R2_MAX_STORAGE_GB` | No | Tope blando FIFO (margen bajo 10 GB gratis) | `9` |

Plantilla: [`.env.example`](.env.example). **No** commits de `.env`.

### Alcance por servidor

`DISCORD_ALLOWED_GUILD_IDS` controla en qué servidores puede usarse el bot:

| Valor | Comportamiento |
|-------|----------------|
| Vacío / no definido | Sin restricción: el bot opera en cualquier servidor al que esté invitado |
| Lista de IDs | Solo esos guilds; en el resto no responde y abandona el servidor |

Ejemplo con allowlist:

```env
DISCORD_ALLOWED_GUILD_IDS=1119618150053466152,538027285580873728
```

Ejemplo sin restricción:

```env
DISCORD_ALLOWED_GUILD_IDS=
```

Al arrancar, el log indica el modo (`Servidores permitidos: …` o `todos`). Los slash commands se registran por guild (no globales): con allowlist, solo en esos IDs; sin ella, en todos los servidores donde el bot esté presente (y también al unirse a uno nuevo).

---

## Producción (PM2)

Config de referencia: [`ecosystem.config.js`](ecosystem.config.js).

```bash
pm2 start ecosystem.config.js
pm2 restart dc-downloader
pm2 logs dc-downloader
```

Asegura que `PATH` de PM2 incluye el binario de `yt-dlp` (a menudo `~/.local/bin`).

---

## Pruebas

Sin Discord, valida descarga + límites:

```bash
npm run test:download
npm run test:download -- youtube
npm run test:e2e                 # Spotify + Reddit
npm run test:e2e -- spotify_amor
```

Salida en `TEMP_DIR/test-out/`.

---

## Estructura del proyecto

```
dc-downloader/
├── .env.example
├── AGENTS.md                 # Guía para agentes / IAs
├── USO.md                    # Uso rápido en Discord
├── README.md
├── ecosystem.config.js       # PM2
├── package.json
├── scripts/
│   ├── test-download.js
│   └── e2e-smoke.js          # Spotify / Reddit sin Discord
└── src/
    ├── index.js              # Entrada del bot
    ├── register-commands.js  # Slash commands por guild
    ├── config.js             # Env + validación URL
    ├── commands/
    │   ├── video.js
    │   └── help.js
    ├── providers/
    │   ├── contract.js
    │   ├── index.js          # Registry
    │   ├── formats.js
    │   └── x | reddit | youtube | tiktok | instagram | facebook | spotify
    ├── services/
    │   ├── downloader.js
    │   ├── compressor.js
    │   ├── r2Storage.js
    │   ├── jobQueue.js
    │   └── tempCleanup.js
    └── utils/
        ├── progress.js
        ├── bins.js
        └── downloadError.js
```

---

## Plataformas

| Plataforma | Hosts / URLs | Formato fuente | Auth | Comportamiento específico |
|------------|--------------|----------------|------|---------------------------|
| **X / Twitter** | `x.com`, `twitter.com` | `FAST_FORMAT` (≤1080p, H.264/MP4 preferido) | Opcional (`COOKIES_*`) si el post está restringido | Sin `normalizeUrl` ni `extraArgs` propios |
| **Reddit** | `reddit.com`, `old.reddit.com`, `redd.it` (posts y shortlinks `/s/`) | `FAST_FORMAT` | No requerida | `normalizeUrl` limpia tracking. Si la API JSON de Reddit devuelve la página anti-bot, `fetchFallbackMedia` resuelve el post y baja el DASH de `v.redd.it` (vídeo+audio) o la imagen directa. GIFs/imágenes de `i.redd.it` con 403 siguen el mismo fallback |
| **YouTube** | `youtube.com`, `youtu.be`, `youtube-nocookie.com` (watch, Shorts, embed, live) | `YOUTUBE_FORMAT` (≤1080p / 60 fps, AVC+M4A) | Age-gate: `fetchFallbackMedia` (Innertube / Piped-Invidious / CDN oficial p.ej. Rockstar) sin cookies | `normalizeUrl` unifica a `watch?v=`; yt-dlp clients por defecto |
| **TikTok** | `tiktok.com`, `vm.tiktok.com`, `vt.tiktok.com` | Prefer `play_addr` / `h264_*` / `bytevc1_*`; evita el fallback watermarked `download` | No requerida | `normalizeUrl` limpia query; `extraArgs` usa `--impersonate chrome` + app móvil; si yt-dlp falla (p. ej. contenido restringido), `fetchFallbackMedia` resuelve CDN sin cookies |
| **Instagram** | `instagram.com`, `instagr.am` (`/reel/`, `/p/`, `/tv/`, `/share/`) | Progressive `3/2/1` (H.264); evita DASH VP9 | No requerida | `normalizeUrl` limpia tracking; **carruseles** → Select Menu (vídeo/foto); `include_dash=0`; si yt-dlp falla (Restricted / login), `fetchFallbackMedia` (progressive CDN o resolver público) sin cookies |
| **Facebook** | `facebook.com`, `fb.watch` (`/reel/`, `/watch/`, `/videos/`, shortlinks) | `hd/sd` progressive (H.264) preferido sobre DASH AV1 | No requerida | `normalizeUrl` unifica reel/watch/fb.watch |
| **Spotify** | `open.spotify.com` `/track/ID` (también `/intl-xx/track/`) | Videoclip ≈ duración del track (YouTube MV / `Artista - Título`; Spotify CDN solo si no es preview corto) | No requerida | Solo tracks; rechaza smart-preview ~30 s, lyrics/audio/visualiser; adjunto ≤10 MB |

---

## Solución de problemas

| Síntoma | Qué revisar |
|---------|-------------|
| Bot no responde | Allowlist (si está activa); token; `pm2 logs` |
| “Plataforma no soportada” | Host no registrado; tipografía del enlace |
| Reddit/X piden auth | `COOKIES_FILE` o `COOKIES_FROM_BROWSER` (opcional; TikTok/Instagram/Facebook no lo necesitan) |
| TikTok / Instagram fallan | Actualizar yt-dlp (`yt-dlp -U`); TikTok necesita `curl_cffi`; Instagram usa fallback automático sin cookies |
| Vídeo IG congelado (audio sí) | Debe salir H.264 progressive; el compressor rechaza `-c copy` de VP9/AV1 |
| YouTube 403 / JSON raro | Actualizar yt-dlp; revisar `extraArgs` del provider |
| Barra en cola | Normal: otro `/video` está activo |
| Encode muy lento | Usar `calidad:rapida` o `auto` |
| Comandos duplicados o viejos | `npm run register` / reinicio PM2 |

---

by Wanikoko
