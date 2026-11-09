# Solución de problemas

| Síntoma | Qué revisar |
|---------|-------------|
| Bot no responde | Allowlist activa; token; `pm2 logs dc-downloader`; `BOT_OFFLINE` |
| «Servidor apagado…» | `BOT_OFFLINE=1` / mantenimiento, o drain tras `pm2 stop` |
| «Plataforma no soportada» | Host no registrado; tipografía del enlace |
| Reddit/X pedían auth | Preferir fallbacks del provider; cookies solo si hace falta en el VPS |
| Reddit **sin audio** | Debe usarse DASH/HLS (vídeo+audio); CMAF suele ser vídeo solo — ver `providers/reddit.js` |
| TikTok / Instagram fallan | `yt-dlp -U`; TikTok necesita `curl_cffi`; IG/TikTok tienen fallback sin cookies |
| Vídeo IG congelado (audio sí) | Salida H.264 progressive; compressor no hace `-c copy` de VP9/AV1 |
| YouTube 403 / JSON raro | Actualizar yt-dlp; `extraArgs` / `fetchFallbackMedia` del provider |
| Spotify ~30 s | Preview rechazado a propósito; buscar MV de duración ≈ track |
| Spoiler no tapa | Debe ser `attachment.setSpoiler(true)`, no `{ spoiler: true }` en el ctor |
| Barra «En cola» | Normal: otro `/video` activo |
| Encode muy lento | `calidad:rapida` o `auto` |
| Comandos duplicados o viejos | `npm run register` / reinicio PM2 (no registrar globales) |
| Adjunto > límite Discord | `MAX_FILE_SIZE_MB` no debe superar el límite real del servidor |

---

## Ver también

- [Setup / PM2](setup.md)
- [Proveedores](providers.md)
- [Arquitectura](architecture.md)
