# AGENTS.md — Guía para agentes e IAs

Documento de orientación para cualquier agente (humano o IA) que trabaje en **dc-downloader**.
Léelo antes de cambiar código. Prioriza cambios mínimos, el contrato de providers y no romper la cola ni los límites de Discord.

---

## Índice

1. [Qué es este proyecto](#qué-es-este-proyecto)
2. [Principios no negociables](#principios-no-negociables)
3. [Mapa del código](#mapa-del-código)
4. [Flujo runtime](#flujo-runtime)
5. [Dónde tocar cada cosa](#dónde-tocar-cada-cosa)
6. [Proveedores](#proveedores)
7. [Cola, progreso y calidad](#cola-progreso-y-calidad)
8. [Configuración y secretos](#configuración-y-secretos)
9. [Comandos npm y tests](#comandos-npm-y-tests)
10. [Producción](#producción)
11. [Anti-patrones](#anti-patrones)
12. [Checklist de cambio](#checklist-de-cambio)

---

## Qué es este proyecto

Bot Discord (Node.js, CommonJS, discord.js v14) que:

1. Recibe `/video url` (+ `calidad` / `descripcion` opcionales).
2. Resuelve el proveedor por hostname (Spotify puede `resolveSource` → YouTube).
3. Encola el job (un solo encode/descarga a la vez).
4. Comprueba duración **antes** de descargar.
5. Descarga con **yt-dlp**, comprime con **FFmpeg** bajo `MAX_FILE_SIZE_MB` (o R2 si >5 min).
6. Envía card (+ caption si `descripcion`) y media; limpia el temp del job.

Firma / autoría del producto: **by Wanikoko**.

---

## Principios no negociables

1. **Allowlist de guilds (opcional)** — Si `DISCORD_ALLOWED_GUILD_IDS` tiene IDs, solo esos servidores; si está vacío, cualquier guild. Con allowlist activa, guilds ajenos → leave.
2. **Duración pre-download** — Rechazar videos largos antes de bajarlos.
3. **Tope de tamaño** — El adjunto debe caber en el límite Discord (`MAX_FILE_SIZE_MB`, defecto 10).
4. **Providers aislados** — No meter lógica de plataforma en `downloader.js` / `compressor.js` / comandos.
5. **Cola global** — No lanzar varios FFmpeg/yt-dlp en paralelo; usar `jobQueue`.
6. **Sin secretos en git** — Nunca commit de `.env`, tokens ni cookies.
7. **PM2 ajeno** — En el VPS, reiniciar solo `dc-downloader`; no tocar otros procesos PM2.
8. **Docs al día** — Si cambias comportamiento de usuario, actualiza `README.md` / `USO.md`.

---

## Mapa del código

```
src/
  index.js                 # Boot, Client, guild guard, InteractionCreate
  register-commands.js     # Slash commands SOLO por guild (no globales)
  config.js                # getConfig, isGuildAllowed, parseAllowedUrl

  commands/
    video.js               # /video — defer, cola, calidad, adjunto
    help.js                # /help ephemeral

  providers/
    contract.js            # Contrato + matchesHost helper
    index.js               # PROVIDERS[] — ÚNICO sitio para registrar
    formats.js             # Selectores -f compartidos
    x.js | reddit.js | youtube.js | tiktok.js | instagram.js | facebook.js | spotify.js

  services/
    downloader.js          # Pipeline: meta → download → compress|R2 → cleanup
    compressor.js          # FFmpeg; modos rapida|auto|alta + hosted HQ
    r2Storage.js           # Cloudflare R2 (vídeos >5 min)
    jobQueue.js            # FIFO global enqueue()
    tempCleanup.js         # Barrido oportunista TEMP_DIR + R2

  utils/
    progress.js            # Embed progreso + heartbeat + UI cola
    bins.js                # Resolución ffmpeg / ffprobe / yt-dlp
    downloadError.js       # Mensajes de error al usuario

scripts/
  test-download.js         # Prueba CLI sin Discord
  e2e-smoke.js             # Spotify / Reddit sin Discord
  ensure-bins.js           # Descarga yt-dlp a bin/ si falta
  verify-bins.js           # Comprueba binarios

ecosystem.config.js        # PM2 (PATH con yt-dlp user bin)
.env.example               # Plantilla env
```

| Pregunta | Archivo |
|----------|---------|
| ¿Dónde se aceptan slash commands? | `src/index.js` |
| ¿Dónde se define `/video`? | `src/commands/video.js` |
| ¿Dónde se valida la URL? | `src/config.js` → `parseAllowedUrl` |
| ¿Dónde se añade un sitio nuevo? | `src/providers/<id>.js` + `index.js` |
| ¿Dónde se descarga? | `src/services/downloader.js` |
| ¿Dónde se comprime? | `src/services/compressor.js` |
| ¿Dónde está la cola? | `src/services/jobQueue.js` |
| ¿Dónde se pinta el %? | `src/utils/progress.js` |
| ¿Dónde se leen límites? | `src/config.js` ← env |

---

## Flujo runtime

```
InteractionCreate (/video)
  → allowlist guild
  → parseAllowedUrl + resolveProvider
  → deferReply
  → (Instagram) listMediaChoices → si carrusel, Select Menu 1..N (vídeo/foto)
  → createProgressReporter
  → jobQueue.enqueue(() => downloadAndPrepare(... playlistItem/mediaKind))
       → onQueued → UI "En cola" si position > 0
       → onStart  → metadata
       → fetchMetadata (yt-dlp) → assertDuration  (omitido en fotos)
       → downloadRaw (yt-dlp -f provider | thumbnail si foto)
       → compressToLimit (FFmpeg)  (omitido en fotos)
  → deleteReply + channel.send(author card ± caption) + channel.send(files|R2)
  → cleanup jobDir
```

**Calidad por defecto:** `auto` (todos los providers). Opciones: `rapida` | `auto` | `alta`.  
**Descripción:** opción booleana `descripcion`; caption vía `provider.resolveCaption` o meta yt-dlp.

---

## Dónde tocar cada cosa

| Objetivo | Qué editar | Qué no tocar |
|----------|------------|--------------|
| Nuevo proveedor | `providers/<id>.js` + `providers/index.js` | downloader/compressor |
| Mejorar encode | `compressor.js` (`buildEncodeAttempts`) | providers (salvo source `-f`) |
| Cambiar barra / textos UI | `utils/progress.js`, `commands/help.js` | — |
| Opción slash nueva | `commands/video.js` + `register-commands` (vía restart) | — |
| Límite duración/tamaño | `.env` / `config.js` | Hardcodear en providers |
| Cookies | `.env` `COOKIES_*` | Meter cookies en código |
| Cola / paralelismo | `jobQueue.js` | Quitar enqueue de `video.js` |
| YouTube URL weird | `providers/youtube.js` `normalizeUrl` | Truncar stdout a mano |
| YouTube age-gate / bot-check | `providers/youtube.js` `extraArgs` (`player_client=android,…`) + `fetchFallbackMedia`; `downloader` trata bot-check como auth-wall y baja googlevideo en serie (`-N 1` / fetch) | Pedir COOKIES_FILE al usuario |
| Spotify → MV YouTube bot-check | `spotify.js` busca vía Piped/Invidious; dona `fetchFallbackMedia`/format de YouTube | Pedir cookies YouTube |
| Instagram carrusel | `providers/instagram.js` `listMediaChoices` + UI en `commands/video.js` | Forzar siempre el primer ítem en downloader |
| Instagram freeze / VP9 | `instagram.js` format `3/2/1` + `compressor` no hace `-c copy` de no-H.264 | Mezclar DASH VP9 con stream copy |
| Instagram restringido / age gate | `providers/instagram.js` `fetchFallbackMedia` (progressive o resolver público) | Cookies obligatorias en Discord |
| IG/FB viewport minúsculo | `compressor.js` scale con caja cuadrada + `setsar=1` | Cajas 16:9 (`640:360`) que aplastan reels verticales |
| Vídeos >5 min | `r2Storage.js` + upload directo si ya es H.264 → URL pública | Comprimir a 10 MB |
| R2 almacenamiento | FIFO `enforceStorageBudget` (tope ~9 GB del gratis 10 GB) | Borrar por edad como temp |
| Facebook reel / fb.watch | `providers/facebook.js` + registry | Meter lógica FB en downloader |
| Spotify track → videoclip | `providers/spotify.js` `resolveSource` (Spotify preview → YouTube MV); siempre adjunto ≤10 MB | Álbumes/playlists; pedir cookies Spotify |
| `/video descripcion` | `commands/video.js` + caption (`cleanPostCaption` / `provider.resolveCaption`; X: fxtwitter) | Truncar con `…` ni aplastar saltos de línea |
| Reddit JSON anti-bot / share `/s/` (yt-dlp: "authentication is required") | `providers/reddit.js` `fetchFallbackMedia`: índice público + DASH `v.redd.it` (vídeo+audio) | Pedir cookies de cuenta Reddit al usuario |
| Reddit GIF/imagen 403 en i.redd.it | `providers/reddit.js` `fetchFallbackMedia` (CDN directo) | Pedir cookies de cuenta Reddit al usuario |

---

## Proveedores

Contrato mínimo (`contract.js`):

- `id`, `label`, `hosts` (y/o `matches(host)`)
- `formatSelector()` → string para `yt-dlp -f`
- `extraArgs()` → `string[]`
- Opcional: `analyzeMeta`, `normalizeUrl`, `resolveSource`, `resolveCaption`, `fetchFallbackMedia`

Registry: array `PROVIDERS` en `providers/index.js`.  
`resolveProviderByUrl` / `ByHost` / `supportedLabels*` se usan desde config, help y downloader.

**Regla:** si algo solo aplica a un sitio, va al módulo del provider.

---

## Cola, progreso y calidad

### jobQueue

- `enqueue(task, { onQueued, onStart })`
- Un `active` a la vez; waiters FIFO.
- `position === 0` → no mostrar UI de cola (va a empezar).
- `position >= 1` → “En cola”.

### progress

- Throttle ~1.8 s + heartbeat 4 s (evita embeds “muertos”).
- Stages: `queued` | `metadata` | `download` | `compress` | `upload`.
- Mostrar `Calidad · …` cuando hay `qualityMode`.

### compressor

- `normalizeQualityMode` → defecto **`auto`**.
- Perfiles en `buildEncodeAttempts(videoBitrateKbps, qualityMode)`.
- Timeouts largos en modos lentos; Discord interaction ~15 min → no encolar indefinidamente jobs enormes sin aviso.

---

## Configuración y secretos

Leídas en `getConfig()`:

| Env | Uso |
|-----|-----|
| `DISCORD_BOT_TOKEN` | Login |
| `DISCORD_CLIENT_ID` | Registro de commands |
| `DISCORD_ALLOWED_GUILD_IDS` | Allowlist opcional (vacío = todos) |
| `MAX_DURATION_SECONDS` | Pre-check |
| `MAX_FILE_SIZE_MB` | Cap encode + adjunto |
| `TEMP_DIR` / `TEMP_MAX_AGE_HOURS` | Workspace local + GC por edad |
| `R2_*` / `R2_MAX_STORAGE_GB` | Vídeos >5 min; FIFO ≤9 GB |
| `COOKIES_FILE` / `COOKIES_FROM_BROWSER` | yt-dlp auth opcional (casi nunca; YT edad usa fallback) |
| `BOT_OFFLINE` / `MAINTENANCE_MODE` | `1` → todos los slash responden «Servidor apagado, prueba más tarde.» |
| `YT_DLP_BIN` / `FFMPEG_BIN` / `FFPROBE_BIN` | Opcional; si vacío usa binarios del sistema (o `bin/` / ensure-bins) vía `src/utils/bins.js` |

Nunca imprimir el token en logs. No subir `.env`.

En apagado limpio (`pm2 stop` / SIGTERM) el bot también responde «Servidor apagado…» a comandos nuevos mientras drena la cola (~12 s).

---

## Comandos npm y tests

```bash
npm start                 # node src/index.js
npm run register          # re-publica slash commands en guilds
npm run test:download     # providers de prueba
npm run test:download -- youtube
npm run test:e2e          # Spotify + Reddit
npm run verify:bins       # ffmpeg / ffprobe / yt-dlp
```

Tests CLI escriben en `temp/test-out/`. Útiles para validar calidad/tamaño sin Discord.

---

## Producción

- App PM2: **`dc-downloader`** (ver `ecosystem.config.js`).
- Tras deploy de JS: `pm2 restart dc-downloader` (re-registra commands al boot).
- `PATH` debe incluir yt-dlp (a menudo `~/.local/bin`).
- No reiniciar ni parar otros procesos PM2 del mismo host.
- Un solo proceso con el mismo token: no correr bot local + prod a la vez.

---

## Anti-patrones

- Añadir `if (platform === 'youtube')` en `downloader.js` o `compressor.js` (salvo casos ya documentados como `qualityMode` genérico).
- Registrar comandos **globales** además de guild (duplicados en Discord).
- Forzar muchos encodes en paralelo “para ir más rápido”.
- Truncar stdout de `--dump-json` (rompe JSON de YouTube).
- Commit de `.env`, cookies o claves SSH.
- Documentación que diga “solo YouTube” para `calidad` (ya es global).
- Cambiar `MAX_FILE_SIZE_MB` por encima del límite real de Discord sin avisar.

---

## Checklist de cambio

Antes de dar por cerrado un cambio:

- [ ] ¿El comportamiento cabe en provider vs pipeline correcto?
- [ ] ¿La cola sigue serializando jobs?
- [ ] ¿`calidad` default sigue siendo `auto`?
- [ ] ¿Duración se comprueba pre-download?
- [ ] ¿El MP4 respeta el tope de MB?
- [ ] ¿Temp del job se limpia en éxito y error?
- [ ] ¿README / USO / AGENTS actualizados si cambió UX o arquitectura?
- [ ] ¿Sin secretos en el diff?
- [ ] ¿En prod solo se reinició `dc-downloader`?

---

## Referencias rápidas

- Uso humano corto: [`USO.md`](USO.md)
- Documentación completa: [`README.md`](README.md)
- Contrato provider: [`src/providers/contract.js`](src/providers/contract.js)
