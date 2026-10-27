# DC Downloader — Uso rápido

## Comandos

```
/video url:<enlace> [calidad] [descripcion]
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
| `descripcion:True` | Envía el texto del post (p. ej. el tuit) encima del vídeo |
| *(omitida)* / `False` | Solo el vídeo + card del usuario |

## Spotify

- Solo enlaces de **track** (`/track/…`), no álbumes ni playlists.
- Flujo: videoclip ≈ duración de la canción (Spotify completo → YouTube MV / `Artista - canción`) → adjunto ≤10 MB.
- Ignora previews cortos de Spotify (~30 s) y lyrics / audio / visualiser.
- Sin videoclip válido: *No hay videoclip disponible para este track.*

## Ejemplo

```
/video url:https://www.youtube.com/watch?v=AiQAyz2n9LY calidad:alta
/video url:https://open.spotify.com/track/6PSFclnJArpyAdCKczoK07
/video url:https://x.com/…/status/… descripcion:True
```

## Plataformas

- X / Twitter
- Reddit
- YouTube
- TikTok (sin marca de agua cuando la API lo permite; restringidos sin cookies)
- Instagram (reels, posts y **carruseles**: eliges el elemento 1, 2, 3… vídeo o foto; H.264; restringidos sin cookies)
- Facebook (reels, `fb.watch` y videos de página)
- Spotify (solo tracks → videoclip)

## Límites

- Máximo **30 minutos** de duración (todos los proveedores)
- **≤ 5 min** → adjunto Discord comprimido (&lt;10 MB)
- **> 5 min** → Cloudflare R2 en alta calidad (sin comprimir a 10 MB) + player en Discord
- Spotify videoclips → siempre adjunto ≤10 MB
- Temp del VPS: se limpia por job + residuos antiguos
- R2: borrado FIFO al acercarse a **~9 GB** (para no pasar del gratis de 10 GB)

## Notas

- Barra de progreso con tiempo mientras descarga y comprime
- Al terminar envía el media en el mismo canal con una card del usuario que lo pidió (avatar + nombre)
- Con `descripcion` el texto del post va en esa card, encima del vídeo
- TikTok e Instagram resuelven contenido restringido sin cookies en el servidor

by Wanikoko
