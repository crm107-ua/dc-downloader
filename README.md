<p align="center">
  <img src="assets/dc-logo.jpg" alt="DC Downloader" width="320" />
</p>

<h1 align="center">DC Downloader</h1>

<p align="center">
  Bot de Discord para descargar, comprimir y publicar clips<br/>
  de X · Reddit · YouTube · TikTok · Instagram · Facebook · Spotify
</p>

<p align="center">
  <a href="USO.md">Uso</a>
  ·
  <a href="docs/setup.md">Setup</a>
  ·
  <a href="docs/architecture.md">Arquitectura</a>
  ·
  <a href="docs/providers.md">Providers</a>
  ·
  <a href="AGENTS.md">Agentes</a>
</p>

<p align="center">
  <sub>by Wanikoko</sub>
</p>

---

## Qué hace

Recibe `/video url`, resuelve el proveedor, encola el job, comprueba duración **antes** de bajar, descarga con **yt-dlp**, comprime con **FFmpeg** bajo el tope de Discord (o sube a **R2** si es largo) y publica en el canal.

| | |
|---|---|
| Entrada | `/video` + `calidad` · `descripcion` · `spoiler` |
| Duración | Pre-check (`MAX_DURATION_SECONDS`, 1800 s) |
| Adjunto | ≤ `MAX_FILE_SIZE_MB` (10 MB); >5 min → R2 |
| Cola | Un job activo; el resto espera |
| Acceso | Allowlist opcional por guild |

---

## Primeros pasos

```bash
cp .env.example .env   # token + client ID
npm install
npm run register
npm start
```

En Discord: `/video url:https://www.youtube.com/watch?v=…`

Guía corta → [`USO.md`](USO.md) · instalación completa → [`docs/setup.md`](docs/setup.md)

---

## Documentación

| Documento | Contenido |
|-----------|-----------|
| [`USO.md`](USO.md) | Comandos y límites para usuarios |
| [`docs/commands.md`](docs/commands.md) | Opciones de `/video`, Spotify, carrusel |
| [`docs/architecture.md`](docs/architecture.md) | Capas, flujo, cola, R2 |
| [`docs/providers.md`](docs/providers.md) | Contrato y plataformas |
| [`docs/setup.md`](docs/setup.md) | Env, allowlist, PM2, tests |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Síntomas frecuentes |
| [`docs/structure.md`](docs/structure.md) | Árbol del repo |
| [`AGENTS.md`](AGENTS.md) · [`CLAUDE.md`](CLAUDE.md) | Guías para agentes / IAs |

---

## Extender

Nuevo sitio = un módulo en `src/providers/` + una línea en el registry.  
Detalle → [`docs/providers.md`](docs/providers.md)

---

<p align="center">
  <sub>by Wanikoko</sub>
</p>
