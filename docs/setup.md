# Instalación y configuración

---

## Requisitos

- Node.js **≥ 20**
- [FFmpeg](https://ffmpeg.org/) y [yt-dlp](https://github.com/yt-dlp/yt-dlp) en `PATH` (o rutas vía env / `bin/`)
- App Discord (token + Application ID)

Mantén yt-dlp al día: `yt-dlp -U`.

---

## Instalación local

```bash
git clone <repo>
cd dc-downloader
cp .env.example .env   # editar valores
npm install
npm run register
npm start
```

### Invitación OAuth2

- Scopes: `bot` + `applications.commands`
- Permisos: Send Messages, Attach Files

```
https://discord.com/api/oauth2/authorize?client_id=TU_CLIENT_ID&permissions=2147485696&scope=bot%20applications.commands
```

Los slash commands se registran **por guild** (nunca globales, para no duplicar).

---

## Variables de entorno

Plantilla: [`.env.example`](../.env.example). **No** commits de `.env`.

| Variable | Obligatoria | Descripción | Defecto |
|----------|-------------|-------------|---------|
| `DISCORD_BOT_TOKEN` | Sí | Token del bot | — |
| `DISCORD_CLIENT_ID` | Sí | Application ID | — |
| `DISCORD_ALLOWED_GUILD_IDS` | No | IDs permitidos (coma). Vacío = todos | *(vacío)* |
| `BOT_OFFLINE` / `MAINTENANCE_MODE` | No | `1` → «Servidor apagado, prueba más tarde.» | `0` |
| `MAX_DURATION_SECONDS` | No | Tope pre-download | `1800` |
| `MAX_FILE_SIZE_MB` | No | Tope adjunto / encode | `10` |
| `TEMP_DIR` | No | Workspace local | `./temp` |
| `TEMP_MAX_AGE_HOURS` | No | GC residuos locales | `24` |
| `COOKIES_FILE` / `COOKIES_FROM_BROWSER` | No | Auth yt-dlp opcional | — |
| `YT_DLP_BIN` / `FFMPEG_BIN` / `FFPROBE_BIN` | No | Rutas explícitas; vacío → sistema / `bin/` | — |
| `R2_ENABLED` | No | `1` = vídeos largos vía R2 | `0` |
| `R2_ACCOUNT_ID` / keys / `R2_BUCKET` / `R2_ENDPOINT` / `R2_PUBLIC_BASE_URL` | Si R2 | Credenciales S3 + URL pública | — |
| `R2_LONG_VIDEO_SECONDS` | No | Umbral adjunto vs R2 | `300` |
| `R2_MAX_STORAGE_GB` | No | Tope FIFO (margen bajo 10 GB gratis) | `9` |

Nunca imprimir el token en logs.

---

## Alcance por servidor

| Valor de `DISCORD_ALLOWED_GUILD_IDS` | Comportamiento |
|-------------------------------------|----------------|
| Vacío | Opera en cualquier servidor invitado |
| Lista de IDs | Solo esos; guilds ajenos → leave |

Al arrancar el log indica el modo. Con allowlist, los commands se registran solo en esos guilds; sin ella, en todos donde esté el bot (y al unirse a uno nuevo).

---

## Producción (PM2)

Config: [`ecosystem.config.js`](../ecosystem.config.js). App: **`dc-downloader`**.

```bash
pm2 start ecosystem.config.js
pm2 restart dc-downloader
pm2 logs dc-downloader
```

- `PATH` de PM2 debe incluir yt-dlp (a menudo `~/.local/bin`).
- Tras deploy de JS: `pm2 restart dc-downloader` (re-registra commands al boot).
- **No** reiniciar ni parar otros procesos PM2 del mismo host.
- Un solo proceso con el mismo token (no local + prod a la vez).
- En `pm2 stop` / SIGTERM el bot drena la cola (~12 s) y responde «Servidor apagado…» a comandos nuevos.

---

## Pruebas sin Discord

```bash
npm run test:download
npm run test:download -- youtube
npm run test:e2e
npm run test:e2e -- spotify_amor
npm run verify:bins
```

Salida en `TEMP_DIR/test-out/`.

---

## Ver también

- [Comandos](commands.md)
- [Solución de problemas](troubleshooting.md)
- Uso humano: [`../USO.md`](../USO.md)
