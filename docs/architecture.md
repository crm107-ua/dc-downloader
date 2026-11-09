# Arquitectura

Bot Discord (Node.js CommonJS, discord.js v14) con pipeline serializado y providers aislados.

Firma: **by Wanikoko**.

---

## Diagrama

```
Usuario Discord
      │  /video url [calidad] [descripcion] [spoiler]
      ▼
┌─────────────────┐
│  index.js       │  guard de guild · slash commands · BOT_OFFLINE
└────────┬────────┘
         ▼
┌─────────────────┐
│  commands/video │  defer · carrusel IG · progreso · cola
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
│                 │  compress | R2 → cleanup │
└────────┬────────┘                          │
         │                                   │
    yt-dlp / FFmpeg ◄── formatSelector / extraArgs / fetchFallbackMedia
         ▼
┌─────────────────┐
│  Discord        │  card (± caption) + adjunto | URL R2 (± spoiler)
└─────────────────┘
```

---

## Capas

| Capa | Responsabilidad |
|------|-----------------|
| `src/index.js` | Cliente Discord, allowlist, `InteractionCreate`, apagado limpio |
| `src/commands/` | UX de slash commands (`/video`, `/help`) |
| `src/providers/` | Todo lo específico de cada sitio |
| `src/services/downloader.js` | Pipeline agnóstico al proveedor |
| `src/services/compressor.js` | Encode H.264/AAC bajo el tope de MB |
| `src/services/r2Storage.js` | Vídeos >5 min → URL pública + presupuesto FIFO |
| `src/services/jobQueue.js` | Un job activo; waiters FIFO |
| `src/services/tempCleanup.js` | GC local de `TEMP_DIR` (+ R2 vía storage) |
| `src/utils/progress.js` | Embed de progreso + heartbeat |
| `src/utils/bins.js` | Resolución de ffmpeg / ffprobe / yt-dlp |
| `src/utils/botAvailability.js` | Modo mantenimiento / drain al parar |
| `src/config.js` | Env, allowlist, `parseAllowedUrl` |

**Regla:** el pipeline no tiene `if (platform === …)`. La especificidad vive en el provider.

---

## Flujo runtime

1. **Invocación** — `/video` en un guild autorizado (o cualquier guild si allowlist vacía).
2. **Validación** — URL http(s) + hostname en el registry.
3. **Defer** — respuesta diferida; Instagram puede mostrar Select Menu de carrusel.
4. **Cola** — `jobQueue.enqueue`; si `position >= 1`, UI “En cola”.
5. **Metadatos** — yt-dlp (o fallback del provider) → duración ≤ `MAX_DURATION_SECONDS` **antes** de bajar (omitido en fotos).
6. **Descarga** — `-f` del provider o `fetchFallbackMedia` → `TEMP_DIR/<uuid>/`.
7. **Compresión o R2** — ≤5 min (o Spotify `forceAttachment`): FFmpeg ≤ `MAX_FILE_SIZE_MB`. >5 min con R2: upload HQ + URL.
8. **Entrega** — borra el reply de progreso; `channel.send` card (± caption) + media (adjunto o enlace; spoiler si aplica).
9. **Cleanup** — borra el jobDir; barrido oportunista de residuos viejos.

---

## Cola

- Un solo encode/descarga a la vez (evita FFmpeg/yt-dlp pisándose).
- `position === 0` → no mostrar UI de cola (arranca ya).
- Stages de progreso: `queued` | `metadata` | `download` | `compress` | `upload`.
- Throttle ~1.8 s + heartbeat 4 s (embeds que no parecen “muertos”).

---

## Calidad

| Modo | Uso |
|------|-----|
| `auto` | Defecto; equilibrio calidad/tiempo |
| `alta` | Mejor imagen; encode más lento (multipass si hace falta) |
| `rapida` | Presets rápidos, una pasada |

Aplica a **todos** los providers. Perfiles en `compressor.js` → `buildEncodeAttempts`.

---

## Entrega Discord

| Caso | Comportamiento |
|------|----------------|
| Clip ≤ `R2_LONG_VIDEO_SECONDS` (defecto 300) | Adjunto MP4 ≤ `MAX_FILE_SIZE_MB` |
| Clip > umbral y R2 activo | URL pública; no forzar 10 MB |
| Spotify videoclip | Siempre adjunto ≤10 MB (`forceAttachment`) |
| `descripcion:True` | Caption en la card (`resolveCaption` / meta); sin `*cursiva*` (Discord corta en saltos) |
| `spoiler:True` | `attachment.setSpoiler(true)` → nombre `SPOILER_…`; R2: `\|\|url\|\|` |

---

## Ver también

- [Proveedores](providers.md)
- [Estructura del repo](structure.md)
- [Comandos](commands.md)
- Guía agentes: [`../AGENTS.md`](../AGENTS.md)
