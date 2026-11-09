# Comandos Discord

| Comando | Descripción |
|---------|-------------|
| `/video url:<enlace> [calidad] [descripcion] [spoiler]` | Descarga, comprime y envía el media |
| `/help` | Ayuda ephemeral |

Si Discord muestra opciones viejas: reinicia el bot o `npm run register`.

---

## `/video` — calidad

| Valor | Comportamiento |
|-------|----------------|
| `auto` | Equilibrado (**defecto** si se omite) |
| `alta` | Mejor imagen, encode más lento |
| `rapida` | Encode rápido, menor calidad percibida |

Aplica a **todos** los proveedores.

---

## `/video` — descripcion

| Valor | Comportamiento |
|-------|----------------|
| `True` | Texto completo del post en la card (X / Reddit / Instagram, etc.) |
| `False` / omitida | Solo card del usuario + media |

Fuente: `provider.resolveCaption` o metadatos yt-dlp. Se preservan saltos de línea; no se envuelve en `*cursiva*`.

---

## `/video` — spoiler

| Valor | Comportamiento |
|-------|----------------|
| `True` | Media como spoiler Discord (`setSpoiler(true)` → `SPOILER_…`; R2: `\|\|url\|\|`) |
| `False` / omitida | Visible al instante |

---

## Spotify

- Solo **tracks** (`open.spotify.com/track/…`, también `/intl-xx/track/`).
- Flujo: videoclip ≈ duración de la canción (Spotify completo si no es preview → YouTube MV / `Artista - Título`) → adjunto ≤10 MB.
- Ignora smart-previews ~30 s y resultados lyrics / audio / visualiser.
- Sin videoclip válido: *No hay videoclip disponible para este track.*

---

## Instagram carrusel

Si el post tiene varios ítems, el bot muestra un Select Menu (1…N, vídeo o foto). El job usa el índice elegido (`playlistItem` / `mediaKind`).

---

## Límites visibles al usuario

- Duración máx. global: `MAX_DURATION_SECONDS` (defecto 30 min).
- ≤5 min → adjunto comprimido ≤10 MB.
- >5 min → R2 HQ (si está activo) + enlace en Discord.
- Spotify → siempre adjunto ≤10 MB.

Guía corta: [`../USO.md`](../USO.md).
