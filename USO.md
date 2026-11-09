# DC Downloader — Uso rápido

Guía corta para Discord. Detalle técnico: [`README.md`](README.md) → [`docs/`](docs/).

## Comandos

```
/video url:<enlace> [calidad] [descripcion] [spoiler]
/help
```

## Calidad (opcional)

| Valor | Efecto |
|-------|--------|
| *(omitida)* / `auto` | Equilibrado (defecto) |
| `alta` | Mejor imagen, más lento |
| `rapida` | Más rápido, menor calidad |

## Descripción (opcional)

| Valor | Efecto |
|-------|--------|
| `descripcion:True` | Texto completo del post (X, Reddit, Instagram…) encima del media |
| *(omitida)* / `False` | Solo el media + card del usuario |

## Spoiler (opcional)

| Valor | Efecto |
|-------|--------|
| `spoiler:True` | Media como spoiler de Discord |
| *(omitida)* / `False` | Visible al instante |

## Spotify

- Solo **tracks** (`/track/…`), no álbumes ni playlists.
- Videoclip ≈ duración de la canción → adjunto ≤10 MB.
- Ignora previews cortos (~30 s) y lyrics / audio / visualiser.
- Sin videoclip: *No hay videoclip disponible para este track.*

## Ejemplo

```
/video url:https://www.youtube.com/watch?v=AiQAyz2n9LY calidad:alta
/video url:https://open.spotify.com/track/6PSFclnJArpyAdCKczoK07
/video url:https://x.com/…/status/… descripcion:True
/video url:https://www.reddit.com/r/…/comments/…/ spoiler:True
```

## Plataformas

- X / Twitter
- Reddit (vídeo con audio; shortlinks `/s/`)
- YouTube
- TikTok (sin marca de agua cuando la API lo permite; restringidos sin cookies)
- Instagram (reels, posts y **carruseles**: eliges 1, 2, 3…; restringidos sin cookies)
- Facebook (reels, `fb.watch`, videos de página)
- Spotify (solo tracks → videoclip)

## Límites

- Máximo **30 minutos** de duración
- **≤ 5 min** → adjunto Discord comprimido (&lt;10 MB)
- **> 5 min** → Cloudflare R2 en alta calidad + enlace (si R2 está activo)
- Spotify → siempre adjunto ≤10 MB
- Temp del VPS: se limpia por job + residuos antiguos
- R2: borrado FIFO al acercarse a **~9 GB**

## Notas

- Barra de progreso mientras descarga y comprime
- Al terminar: card del usuario (avatar + nombre) + media
- Con `descripcion`, el texto del post va en esa card
- Más detalle de opciones: [`docs/commands.md`](docs/commands.md)

by Wanikoko
