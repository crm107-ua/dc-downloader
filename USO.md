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

Vale para YouTube, X, Reddit, TikTok e Instagram.

## Ejemplo

```
/video url:https://www.youtube.com/watch?v=AiQAyz2n9LY calidad:alta
```

## Plataformas

- X / Twitter
- Reddit
- YouTube
- TikTok (sin marca de agua cuando la API lo permite)
- Instagram (reels y posts con video)

## Límites

- Máximo **10 minutos** de duración (antes de descargar)
- Archivo final por debajo de **10 MB**
- Solo funciona en los servidores autorizados del bot (si hay allowlist; si `DISCORD_ALLOWED_GUILD_IDS` está vacío, en cualquiera)
- Si hay otro `/video` en marcha, el tuyo espera **en cola**

## Notas

- Barra de progreso con tiempo mientras descarga y comprime
- Al terminar envía solo el video en el mismo canal
- Si Reddit/X/Instagram fallan por login, hace falta configurar cookies en el servidor

by Wanikoko
