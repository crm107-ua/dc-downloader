# CLAUDE.md — entrada para Claude / agentes

Antes de cambiar código, lee en este orden:

1. **[`AGENTS.md`](AGENTS.md)** — principios, mapa, “dónde tocar”, anti-patrones, checklist.
2. **[`docs/architecture.md`](docs/architecture.md)** — flujo runtime, cola, R2, entrega Discord.
3. **[`docs/providers.md`](docs/providers.md)** — contrato y pitfalls por plataforma.

Documentación humana (hub): [`README.md`](README.md) · uso corto: [`USO.md`](USO.md).

---

## Reglas cortas (no negociables)

- Providers aislados: nada de `if (platform === …)` en downloader/compressor/comandos.
- Cola global: un solo FFmpeg/yt-dlp a la vez (`jobQueue`).
- Duración **antes** de descargar; adjunto ≤ `MAX_FILE_SIZE_MB` (salvo R2 >5 min).
- Sin secretos en git (`.env`, cookies, tokens).
- En el VPS: reiniciar **solo** `dc-downloader` (PM2).
- Docs al día si cambia UX o arquitectura (`README` hub, `docs/*`, `USO`, `AGENTS`).
- Cambios mínimos; no refactors colaterales.

---

## Stack

Node.js ≥20, CommonJS, discord.js v14, yt-dlp, FFmpeg, PM2 app `dc-downloader`.
