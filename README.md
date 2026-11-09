# DC Downloader

Bot de Discord que descarga clips de **X**, **Reddit**, **YouTube**, **TikTok**, **Instagram**, **Facebook** y **Spotify** (videoclip de un track), los comprime bajo un tope de tamaño (o los sube a R2 si son largos) y los publica en el mismo canal.

Diseñado para ser **claro de usar**, **configurable por servidor** (allowlist opcional) y **fácil de extender** con nuevos proveedores.

Firma: **by Wanikoko**.

---

## Qué hace (resumen)

| Aspecto | Detalle |
|---------|---------|
| Entrada | `/video url` (+ `calidad` / `descripcion` / `spoiler`) |
| Plataformas | Registry en `src/providers/` |
| Duración | Pre-check (`MAX_DURATION_SECONDS`, defecto 1800 s) |
| Tamaño | Adjunto ≤ `MAX_FILE_SIZE_MB` (defecto 10); >5 min → R2 si está activo |
| Concurrencia | Cola global: un job a la vez |
| Acceso | `DISCORD_ALLOWED_GUILD_IDS` (vacío = todos) |

---

## Primeros pasos

```bash
cp .env.example .env   # token + client ID
npm install
npm run register
npm start
```

Luego en Discord: `/video url:https://www.youtube.com/watch?v=…`

- Uso humano corto → [`USO.md`](USO.md)
- Instalación, env y PM2 → [`docs/setup.md`](docs/setup.md)

---

## Documentación

| Documento | Contenido |
|-----------|-----------|
| [`USO.md`](USO.md) | Comandos y límites para usuarios |
| [`docs/commands.md`](docs/commands.md) | `/video`, calidad, descripción, spoiler, Spotify, carrusel |
| [`docs/architecture.md`](docs/architecture.md) | Capas, flujo runtime, cola, calidad, entrega |
| [`docs/providers.md`](docs/providers.md) | Contrato, plataformas, cómo añadir un sitio |
| [`docs/setup.md`](docs/setup.md) | Requisitos, env, allowlist, PM2, tests |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Síntomas y qué revisar |
| [`docs/structure.md`](docs/structure.md) | Árbol del repo y “dónde está X” |
| [`AGENTS.md`](AGENTS.md) | Guía operativa para agentes / IAs |
| [`CLAUDE.md`](CLAUDE.md) | Entrada Claude Code |

---

## Extender

Nuevo sitio = un módulo en `src/providers/` + una línea en el registry.  
Detalle: [`docs/providers.md`](docs/providers.md).

---

## Licencia / autoría

by Wanikoko
