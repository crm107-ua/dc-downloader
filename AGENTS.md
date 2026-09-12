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

1. Recibe `/video url` (+ `calidad` opcional).
2. Resuelve el proveedor por hostname.
3. Encola el job (un solo encode/descarga a la vez).
4. Comprueba duración **antes** de descargar.
5. Descarga con **yt-dlp**, comprime con **FFmpeg** bajo `MAX_FILE_SIZE_MB`.
6. Responde solo con el MP4 y limpia el temp del job.

Firma / autoría del producto: **by Wanikoko**.

---

## Principios no negociables

1. **Allowlist de guilds** — Sin `DISCORD_ALLOWED_GUILD_IDS` no arranca; guilds ajenos → leave.
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
    x.js | reddit.js | youtube.js | tiktok.js | instagram.js

  services/
    downloader.js          # Pipeline: meta → download → compress → cleanup
    compressor.js          # FFmpeg; modos rapida|auto|alta
    jobQueue.js            # FIFO global enqueue()
    tempCleanup.js         # Barrido oportunista TEMP_DIR

  utils/
    progress.js            # Embed progreso + heartbeat + UI cola

scripts/
  test-download.js         # Prueba CLI sin Discord

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
  → createProgressReporter
  → jobQueue.enqueue(() => downloadAndPrepare(...))
       → onQueued → UI "En cola" si position > 0
       → onStart  → metadata
       → fetchMetadata (yt-dlp) → assertDuration
       → downloadRaw (yt-dlp -f provider)
       → compressToLimit (FFmpeg, qualityMode)
  → editReply({ files: [mp4] })
  → cleanup jobDir
```

**Calidad por defecto:** `auto` (todos los providers). Opciones: `rapida` | `auto` | `alta`.

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

---

## Proveedores

Contrato mínimo (`contract.js`):

- `id`, `label`, `hosts` (y/o `matches(host)`)
- `formatSelector()` → string para `yt-dlp -f`
- `extraArgs()` → `string[]`
- Opcional: `analyzeMeta`, `normalizeUrl`

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
| `DISCORD_ALLOWED_GUILD_IDS` | Allowlist |
| `MAX_DURATION_SECONDS` | Pre-check |
| `MAX_FILE_SIZE_MB` | Cap encode + adjunto |
| `TEMP_DIR` / `TEMP_MAX_AGE_HOURS` | Workspace + GC |
| `COOKIES_FILE` / `COOKIES_FROM_BROWSER` | yt-dlp auth |

Nunca imprimir el token en logs. No subir `.env`.

---

## Comandos npm y tests

```bash
npm start                 # node src/index.js
npm run register          # re-publica slash commands en guilds
npm run test:download     # todos los providers de prueba
npm run test:download -- youtube
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
