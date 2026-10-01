# DC Downloader — Uso rápido

## Comandos

```
/video url:<enlace> [calidad]
/help
```

## Calidad (opcional)

| Valor | Efecto |
|-------|--------|
| *(omitida)* / `auto` | Equilibrado (defecto) |
| `alta` | Mejor imagen, más lento |
| `rapida` | Más rápido, menor calidad |

Vale para YouTube, X, Reddit, TikTok, Instagram y Facebook.

## Ejemplo

```
/video url:https://www.youtube.com/watch?v=AiQAyz2n9LY calidad:alta
```

## Plataformas

- X / Twitter
- Reddit
- YouTube
- TikTok (sin marca de agua cuando la API lo permite; restringidos sin cookies)
- Instagram (reels, posts y **carruseles**: eliges el elemento 1, 2, 3… vídeo o foto; H.264; restringidos sin cookies)
- Facebook (reels, `fb.watch` y videos de página)

## Límites

- Máximo **30 minutos** de duración (todos los proveedores)
- **≤ 5 min** → adjunto Discord comprimido (&lt;10 MB)
- **> 5 min** → Cloudflare R2 en alta calidad (sin comprimir a 10 MB) + player en Discord
- Temp del VPS: se limpia por job + residuos antiguos
- R2: borrado FIFO al acercarse a **~9 GB** (para no pasar del gratis de 10 GB)

## Notas

- Barra de progreso con tiempo mientras descarga y comprime
- Al terminar envía el media en el mismo canal con una card del usuario que lo pidió (avatar + nombre)
- TikTok e Instagram resuelven contenido restringido sin cookies en el servidor

by Wanikoko
