# AGENTS.md — Guía para agentes e IAs

Documento de orientación para cualquier agente (humano o IA) que trabaje en **dc-downloader**.  
Léelo **antes** de cambiar código. Prioriza cambios mínimos, el contrato de providers y no romper la cola ni los límites de Discord.

Entrada Claude: [`CLAUDE.md`](CLAUDE.md). Hub humano: [`README.md`](README.md). Detalle largo: [`docs/`](docs/).

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

1. Recibe `/video url` (+ `calidad` / `descripcion` / `spoiler` opcionales).
2. Resuelve el proveedor por hostname (Spotify puede `resolveSource` → YouTube).
3. Encola el job (un solo encode/descarga a la vez).
4. Comprueba duración **antes** de descargar.
5. Descarga con **yt-dlp**, comprime con **FFmpeg** bajo `MAX_FILE_SIZE_MB` (o R2 si >5 min).
6. Envía card (+ caption si `descripcion`) y media (± spoiler); limpia el temp del job.

Firma / autoría: **by Wanikoko**.

Profundidad: [`docs/architecture.md`](docs/architecture.md).

---

## Principios no negociables

1. **Allowlist de guilds (opcional)** — Si `DISCORD_ALLOWED_GUILD_IDS` tiene IDs, solo esos servidores; vacío = cualquiera. Con allowlist, guilds ajenos → leave.
2. **Duración pre-download** — Rechazar videos largos antes de bajarlos.
3. **Tope de tamaño** — El adjunto debe caber en el límite Discord (`MAX_FILE_SIZE_MB`, defecto 10).
4. **Providers aislados** — No meter lógica de plataforma en `downloader.js` / `compressor.js` / comandos.
5. **Cola global** — No lanzar varios FFmpeg/yt-dlp en paralelo; usar `jobQueue`.
6. **Sin secretos en git** — Nunca commit de `.env`, tokens ni cookies.
7. **PM2 ajeno** — En el VPS, reiniciar solo `dc-downloader`; no tocar otros procesos PM2.
8. **Docs al día** — Si cambias UX o arquitectura: `README.md` (hub), `docs/*`, `USO.md`, este archivo y `CLAUDE.md` si aplica.

---

## Mapa del código

Árbol completo: [`docs/structure.md`](docs/structure.md).

```
src/
  index.js                 # Boot, Client, guild guard, InteractionCreate
  register-commands.js     # Slash commands SOLO por guild (no globales)
  config.js                # getConfig, isGuildAllowed, parseAllowedUrl

  commands/
    video.js               # /video — defer, cola, calidad, caption, spoiler
    help.js                # /help ephemeral

  providers/
    contract.js            # Contrato + matchesHost
    index.js               # PROVIDERS[] — ÚNICO sitio para registrar
    formats.js             # Selectores -f compartidos
    x | reddit | youtube | tiktok | instagram | facebook | spotify

  services/
    downloader.js          # Pipeline: meta → download → compress|R2 → cleanup
    compressor.js          # FFmpeg; modos rapida|auto|alta + hosted HQ
    r2Storage.js           # Cloudflare R2 (vídeos >5 min)
    jobQueue.js            # FIFO global enqueue()
    tempCleanup.js         # Barrido TEMP_DIR + presupuesto R2

  utils/
    progress.js            # Embed progreso + heartbeat + UI cola
    bins.js                # ffmpeg / ffprobe / yt-dlp
    botAvailability.js     # BOT_OFFLINE + drain SIGTERM
    downloadError.js       # Mensajes de error al usuario
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
  → allowlist guild / BOT_OFFLINE
  → parseAllowedUrl + resolveProvider
  → deferReply
  → (Instagram) listMediaChoices → si carrusel, Select Menu 1..N (vídeo/foto)
  → createProgressReporter
  → jobQueue.enqueue(() => downloadAndPrepare(... playlistItem/mediaKind))
       → onQueued → UI "En cola" si position > 0
       → onStart  → metadata
       → fetchMetadata (yt-dlp) → assertDuration  (omitido en fotos)
       → downloadRaw (yt-dlp -f provider | thumbnail si foto | fetchFallbackMedia)
       → compressToLimit (FFmpeg)  (omitido en fotos; R2 si >5 min)
  → deleteReply + channel.send(author card ± caption) + channel.send(files|R2 ± spoiler)
  → cleanup jobDir
```

- **Calidad por defecto:** `auto`. Opciones: `rapida` | `auto` | `alta`.
- **Descripción:** `descripcion` → `provider.resolveCaption` o meta yt-dlp; sin `*cursiva*`.
- **Spoiler:** `attachment.setSpoiler(true)` → `SPOILER_…`; R2: `||url||`.

Detalle: [`docs/architecture.md`](docs/architecture.md) · UX: [`docs/commands.md`](docs/commands.md).

---

## Dónde tocar cada cosa

| Objetivo | Qué editar | Qué no tocar |
|----------|------------|--------------|
| Nuevo proveedor | `providers/<id>.js` + `providers/index.js` | downloader/compressor |
| Mejorar encode | `compressor.js` (`buildEncodeAttempts`) | providers (salvo source `-f`) |
| Cambiar barra / textos UI | `utils/progress.js`, `commands/help.js` | — |
| Opción slash nueva | `commands/video.js` (+ restart / `register`) | — |
| Límite duración/tamaño | `.env` / `config.js` | Hardcodear en providers |
| Cookies | `.env` `COOKIES_*` | Meter cookies en código |
| Cola / paralelismo | `jobQueue.js` | Quitar enqueue de `video.js` |
| YouTube URL weird | `providers/youtube.js` `normalizeUrl` | Truncar stdout a mano |
| YouTube age-gate / bot-check | `youtube.js` `extraArgs` + `fetchFallbackMedia`; downloader auth-wall → `-N 1` | Pedir `COOKIES_FILE` al usuario |
| Spotify → MV YouTube bot-check | `spotify.js` (Piped/Invidious) + format/fallback de YouTube | Pedir cookies YouTube |
| Instagram carrusel | `instagram.js` `listMediaChoices` + UI en `video.js` | Forzar siempre el primer ítem |
| Instagram freeze / VP9 | format `3/2/1` + compressor sin `-c copy` de no-H.264 | Mezclar DASH VP9 con stream copy |
| Instagram restringido | `instagram.js` `fetchFallbackMedia` | Cookies obligatorias en Discord |
| IG/FB viewport minúsculo | compressor: caja cuadrada + `setsar=1` | Cajas 16:9 que aplastan verticales |
| Vídeos >5 min | `r2Storage.js` (upload HQ si ya H.264) | Comprimir a 10 MB |
| R2 almacenamiento | FIFO `enforceStorageBudget` (~9 GB) | Borrar por edad como temp |
| Facebook reel / fb.watch | `providers/facebook.js` + registry | Lógica FB en downloader |
| Spotify track → videoclip | `spotify.js` `resolveSource`: no previews ~30 s; duración ≈ track (≥55%); MV / `Artista - Título`; adjunto ≤10 MB | Álbumes/playlists |
| `/video descripcion` | `video.js` + `resolveCaption` / `cleanPostCaption` (X: fxtwitter) | Truncar con `…` ni aplastar saltos |
| Reddit anti-bot / `/s/` / mudo | `reddit.js` `fetchFallbackMedia`: resolver post; **DASH/HLS primero** (CMAF ≈ sin audio) | Pedir cookies; preferir CMAF |
| Reddit GIF/imagen 403 `i.redd.it` | mismo fallback CDN | Pedir cookies Reddit al usuario |
| Captions Reddit/IG/X | `resolveCaption` por provider; no `*cursiva*` | Truncar / aplastar saltos |
| `/video spoiler` | `attachment.setSpoiler(true)` | `{ spoiler: true }` en el ctor (discord.js lo ignora) |

---

## Proveedores

Contrato mínimo (`contract.js`):

- `id`, `label`, `hosts` (y/o `matches(host)`)
- `formatSelector()` → string para `yt-dlp -f`
- `extraArgs()` → `string[]`
- Opcional: `analyzeMeta`, `normalizeUrl`, `resolveSource`, `resolveCaption`, `listMediaChoices`, `fetchFallbackMedia`

Registry: `PROVIDERS` en `providers/index.js`.  
**Regla:** si algo solo aplica a un sitio, va al módulo del provider.

Tablas y pitfalls: [`docs/providers.md`](docs/providers.md).

---

## Cola, progreso y calidad

### jobQueue

- `enqueue(task, { onQueued, onStart })`
- Un `active` a la vez; waiters FIFO.
- `position === 0` → no UI de cola; `>= 1` → “En cola”.

### progress

- Throttle ~1.8 s + heartbeat 4 s.
- Stages: `queued` | `metadata` | `download` | `compress` | `upload`.

### compressor

- `normalizeQualityMode` → defecto **`auto`**.
- Perfiles en `buildEncodeAttempts(videoBitrateKbps, qualityMode)`.
- Interaction Discord ~15 min → no encolar jobs enormes sin aviso.

---

## Configuración y secretos

Leídas en `getConfig()` — lista completa: [`docs/setup.md`](docs/setup.md) y [`.env.example`](.env.example).

| Env | Uso |
|-----|-----|
| `DISCORD_BOT_TOKEN` / `DISCORD_CLIENT_ID` | Login / registro commands |
| `DISCORD_ALLOWED_GUILD_IDS` | Allowlist (vacío = todos) |
| `MAX_DURATION_SECONDS` / `MAX_FILE_SIZE_MB` | Pre-check / tope adjunto |
| `TEMP_DIR` / `TEMP_MAX_AGE_HOURS` | Workspace + GC |
| `R2_*` / `R2_MAX_STORAGE_GB` | Vídeos >5 min; FIFO ≤9 GB |
| `COOKIES_FILE` / `COOKIES_FROM_BROWSER` | yt-dlp auth opcional |
| `BOT_OFFLINE` / `MAINTENANCE_MODE` | Apagado lógico |
| `YT_DLP_BIN` / `FFMPEG_BIN` / `FFPROBE_BIN` | Binarios explícitos |

Nunca imprimir el token. No subir `.env`.  
En `pm2 stop` / SIGTERM: «Servidor apagado…» mientras drena la cola (~12 s).

---

## Comandos npm y tests

```bash
npm start
npm run register
npm run test:download
npm run test:download -- youtube
npm run test:e2e
npm run verify:bins
```

Salida CLI en `temp/test-out/`.

---

## Producción

- App PM2: **`dc-downloader`** (`ecosystem.config.js`).
- Tras deploy: `pm2 restart dc-downloader` (re-registra commands al boot).
- `PATH` con yt-dlp (a menudo `~/.local/bin`).
- No tocar otros procesos PM2.
- Un solo proceso con el mismo token.

Más: [`docs/setup.md`](docs/setup.md#producción-pm2).

---

## Anti-patrones

- `if (platform === 'youtube')` en downloader/compressor (salvo casos genéricos documentados).
- Registrar commands **globales** además de guild.
- Varios encodes en paralelo “para ir más rápido”.
- Truncar stdout de `--dump-json` (rompe JSON de YouTube).
- Preferir CMAF de Reddit sobre DASH (vídeo mudo).
- Commit de `.env`, cookies o claves SSH.
- Docs que digan “`calidad` solo YouTube” (es global).
- Subir `MAX_FILE_SIZE_MB` por encima del límite real de Discord sin avisar.
- Spoiler vía opciones del constructor de `AttachmentBuilder`.

---

## Checklist de cambio

- [ ] ¿Cabe en provider vs pipeline correcto?
- [ ] ¿La cola sigue serializando jobs?
- [ ] ¿`calidad` default = `auto`?
- [ ] ¿Duración pre-download?
- [ ] ¿MP4 / R2 respetan los topes?
- [ ] ¿Temp del job se limpia en éxito y error?
- [ ] ¿`README` / `docs/*` / `USO` / `AGENTS` al día si cambió UX o arquitectura?
- [ ] ¿Sin secretos en el diff?
- [ ] ¿En prod solo se reinició `dc-downloader`?

---

## Referencias

| Recurso | Ruta |
|---------|------|
| Uso humano | [`USO.md`](USO.md) |
| Hub docs | [`README.md`](README.md) |
| Arquitectura | [`docs/architecture.md`](docs/architecture.md) |
| Providers | [`docs/providers.md`](docs/providers.md) |
| Setup / env / PM2 | [`docs/setup.md`](docs/setup.md) |
| Troubleshooting | [`docs/troubleshooting.md`](docs/troubleshooting.md) |
| Contrato código | [`src/providers/contract.js`](src/providers/contract.js) |
