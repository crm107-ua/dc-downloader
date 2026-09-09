# DC Downloader

Bot de Discord para descargar videos cortos de plataformas registradas como proveedores (hoy: **X**, **Reddit**, **YouTube**, **TikTok**), comprimirlos bajo un limite estricto de tamano y publicarlos en el mismo canal donde se invoco el comando.

La arquitectura de proveedores es **abierta**: anadir un sitio nuevo no requiere tocar el pipeline de descarga, compresion ni Discord.

---

## Indice

1. [Resumen](#resumen)
2. [Arquitectura](#arquitectura)
3. [Proveedores (extensible)](#proveedores-extensible)
4. [Anadir un proveedor nuevo](#anadir-un-proveedor-nuevo)
5. [Flujo de funcionamiento](#flujo-de-funcionamiento)
6. [Comandos](#comandos)
7. [Requisitos](#requisitos)
8. [Configuracion](#configuracion)
9. [Instalacion e invitacion](#instalacion-e-invitacion)
10. [Variables de entorno](#variables-de-entorno)
11. [Limpieza de temporales](#limpieza-de-temporales)
12. [Pruebas locales](#pruebas-locales)
13. [Notas por plataforma](#notas-por-plataforma)
14. [Estructura del proyecto](#estructura-del-proyecto)

---

## Resumen

| Aspecto | Detalle |
|---------|---------|
| Entrada | Slash command `/video` con una URL |
| Plataformas | Registro en `src/providers/` (X, Reddit, YouTube, TikTok) |
| Duracion maxima | Configurable (`MAX_DURATION_SECONDS`, por defecto 600 s / 10 min) |
| Tamano maximo | Configurable (`MAX_FILE_SIZE_MB`, por defecto 10 MB) |
| Salida | Un unico archivo MP4 adjunto en el canal (sin texto de metadatos) |
| Extensibilidad | Nuevo proveedor = un modulo + una linea en el registry |

El chequeo de duracion se realiza **antes** de descargar el video. Si supera el limite, la operacion se cancela sin ocupar disco ni ancho de banda de forma innecesaria.

---

## Arquitectura

```
Usuario Discord
      |
      |  /video url:<enlace>
      v
+------------------+
|  discord.js bot  |  defer reply
+--------+---------+
         |
         v
+------------------+     +------------------------+
| Provider registry|---->| Provider (hosts, -f,   |
| resolve by host  |     | extraArgs, analyzeMeta)|
+--------+---------+     +------------------------+
         |
         v
+------------------+     +------------------+
| URL validation   |---->| yt-dlp metadata  |  duracion <= limite?
+------------------+     +--------+---------+
                                  |
                     OK           |           FAIL
                      +-----------+-----------+
                      |                       |
                      v                       v
              +---------------+        respuesta de error
              | yt-dlp download|
              +-------+-------+
                      |
                      v
              +---------------+
              | FFmpeg encode |  H.264 + AAC hasta < MAX_FILE_SIZE_MB
              +-------+-------+
                      |
                      v
              +---------------+
              | Discord reply |  solo el archivo MP4
              +-------+-------+
                      |
                      v
              borrado del job en TEMP_DIR
              (+ barrido oportunista de restos > 24 h)
```

**Componentes principales**

| Capa | Rol |
|------|-----|
| `src/providers/` | Contrato + registry + un modulo por plataforma |
| `discord.js` | Login, registro de slash commands, defer/edit reply, adjuntos |
| `yt-dlp` | Extraccion de metadatos y descarga (args/formatos vienen del provider) |
| `FFmpeg` | Reencode y control de bitrate para cumplir el tope de MB |
| `TEMP_DIR` | Workspace por job (UUID); limpieza inmediata y diferida |

El pipeline (`downloader`, `compressor`, comandos Discord) **no** contiene branches `if (platform === ...)`. Toda la especificidad vive en el provider.

---

## Proveedores (extensible)

Cada proveedor es un objeto que cumple el contrato documentado en `src/providers/contract.js`:

| Campo | Tipo | Descripcion |
|-------|------|-------------|
| `id` | string | Clave unica (logs, nombre de archivo) |
| `label` | string | Nombre legible (help, errores) |
| `hosts` | string[] | Hostnames exactos aceptados (lowercase) |
| `matches(host)` | opcional | Matcher custom si no basta `hosts` |
| `formatSelector()` | string | Valor de `yt-dlp -f` |
| `extraArgs()` | string[] | Flags extra de yt-dlp (extractor-args, etc.) |
| `analyzeMeta(meta)` | opcional | Analisis post-metadatos (p. ej. watermark) |

El registry (`src/providers/index.js`) expone:

- `listProviders()` / `resolveProviderByUrl(url)` / `resolveProviderByHost(host)`
- `supportedLabels()` para help y mensajes de error

Validacion de URL, help y descarga leen el registry; al registrar un provider nuevo, queda disponible en todo el bot sin tocar el resto.

---

## Anadir un proveedor nuevo

1. Crear `src/providers/<id>.js` siguiendo el contrato (puedes copiar `youtube.js` o `tiktok.js` como plantilla).
2. Exportar el objeto provider.
3. En `src/providers/index.js`, `require` el modulo y anadirlo al array `PROVIDERS`.
4. (Opcional) Anadir una URL de prueba en `scripts/test-download.js`.
5. Reiniciar el bot. No hace falta cambiar `downloader.js`, `compressor.js` ni los comandos Discord.

Ejemplo minimo:

```js
// src/providers/example.js
const provider = {
  id: 'example',
  label: 'Example',
  hosts: ['example.com', 'www.example.com'],
  formatSelector() {
    return 'bv*+ba/b';
  },
  extraArgs() {
    return [];
  },
};

module.exports = provider;
```

```js
// src/providers/index.js
const example = require('./example');
const PROVIDERS = [x, reddit, youtube, tiktok, example];
```

Con eso, `/video` aceptara URLs de `example.com`, `/help` listara el label, y el pipeline usara su `formatSelector` / `extraArgs` automaticamente.

---

## Flujo de funcionamiento

### 1. Invocacion

El usuario ejecuta `/video` en un canal donde el bot tiene permisos de enviar mensajes y adjuntar archivos.

### 2. Resolucion de proveedor y validacion de URL

Se resuelve el provider por hostname. Si no hay match en el registry, se rechaza la URL. Los hosts permitidos salen unicamente de los providers registrados.

### 3. Comprobacion de duracion (pre-descarga)

Se consulta metadatos con `yt-dlp --dump-json` (mas `extraArgs` del provider) y se compara `duration` con `MAX_DURATION_SECONDS`.

- Si la duracion supera el limite: error al usuario, **sin descarga**.
- Si el proveedor no informa duracion: se continua y se verifica de nuevo con `ffprobe` tras la descarga.

### 4. Descarga

Se descarga con el `formatSelector` del provider y se fusiona a MP4 cuando hace falta.

Cada solicitud usa un directorio de trabajo aislado (`TEMP_DIR/<uuid>/`) para permitir uso concurrente de varios usuarios en el mismo servidor.

### 5. Compresion

FFmpeg reencodea a H.264 + AAC calculando un bitrate objetivo a partir de la duracion y `MAX_FILE_SIZE_MB`. Si el archivo sigue por encima del limite, se realizan pasadas mas agresivas (escala 720p, 480p, 360p) hasta cumplir el tope o agotar intentos.

### 6. Entrega

El bot responde en el **mismo canal** unicamente con el archivo MP4. No se anade texto tipo plataforma / duracion / tamano.

### 7. Limpieza

- Al finalizar (exito o error): se elimina el directorio del job.
- Al iniciar cualquier descarga: barrido oportunista de entradas en `TEMP_DIR` mas antiguas que `TEMP_MAX_AGE_HOURS` (por defecto 24 h), sin cron, con throttle para no saturar disco bajo carga concurrente.

---

## Comandos

| Comando | Descripcion |
|---------|-------------|
| `/video url:<enlace>` | Descarga, comprime y publica el video en el canal |
| `/help` | Muestra ayuda de uso (ephemeral); lista providers del registry |

Si Discord sigue mostrando `/download`, es cache de comandos globales antiguos. El registro actual solo publica `/video` y `/help`. Ejecuta `npm run register` (o reinicia el bot) y, si hace falta, espera unos minutos o configura `DISCORD_GUILD_ID` para propagacion instantanea en tu servidor.

---

## Requisitos

- Node.js 20 o superior
- [FFmpeg](https://ffmpeg.org/) disponible en `PATH`
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) disponible en `PATH` (recomendado mantenerlo actualizado: `yt-dlp -U`)
- Aplicacion de Discord con bot token e Application ID

---

## Configuracion

1. Copia `.env.example` a `.env` y completa los valores.
2. Invita el bot al servidor (enlace mas abajo).
3. Instala dependencias y arranca:

```bash
npm install
npm run register
npm start
```

---

## Instalacion e invitacion

**Scopes:** `bot` + `applications.commands`  
**Permisos:** Send Messages, Attach Files

```
https://discord.com/api/oauth2/authorize?client_id=1547154925249634396&permissions=2147485696&scope=bot%20applications.commands
```

Sustituye el `client_id` si usas otra aplicacion.

Para que los slash commands se actualicen al instante en un servidor concreto, anade su ID en `.env`:

```env
DISCORD_GUILD_ID=tu_guild_id
```

---

## Variables de entorno

| Variable | Obligatoria | Descripcion | Defecto |
|----------|-------------|-------------|---------|
| `DISCORD_BOT_TOKEN` | Si | Token del bot | — |
| `DISCORD_CLIENT_ID` | Si | Application ID | — |
| `DISCORD_GUILD_ID` | No | Registro instantaneo de slash en un guild | vacio (solo global) |
| `MAX_DURATION_SECONDS` | No | Duracion maxima permitida (pre-descarga) | `600` |
| `MAX_FILE_SIZE_MB` | No | Tamano maximo del MP4 enviado | `10` |
| `TEMP_DIR` | No | Directorio de trabajo temporal | `./temp` |
| `TEMP_MAX_AGE_HOURS` | No | Edad maxima de residuos en `TEMP_DIR` | `24` |
| `COOKIES_FILE` | No | Cookies Netscape para X/Reddit | — |
| `COOKIES_FROM_BROWSER` | No | p. ej. `chrome`, `edge`, `firefox` | — |

---

## Limpieza de temporales

No se usa cron. En cada `/video` se programa un barrido de `TEMP_DIR`:

- Solo elimina entradas con `mtime` superior a `TEMP_MAX_AGE_HOURS`.
- Los jobs activos (recien creados) no se tocan.
- Un unico barrido compartido entre descargas concurrentes, con intervalo minimo de 5 minutos entre barridos, para eficiencia bajo uso simultaneo.

---

## Pruebas locales

Sin Discord, valida descarga + limites:

```bash
npm run test:download
npm run test:download -- tiktok
```

Los MP4 de prueba se guardan en `TEMP_DIR/test-out/` para inspeccion manual (incluido control visual de marca de agua en TikTok).

---

## Notas por plataforma

| Plataforma | Particularidades |
|------------|------------------|
| **X** | Suele funcionar sin cookies; casos restringidos pueden requerir `COOKIES_*` |
| **Reddit** | Algunos posts exigen autenticacion; usa cookies si falla |
| **YouTube** | Cliente `android/ios/web` via `extraArgs` para reducir HTTP 403; mantén yt-dlp al dia |
| **TikTok** | `formatSelector` prioriza streams sin watermark; `analyzeMeta` detecta si solo hubo opciones watermarked |

Las particularidades viven en el modulo del provider, no en el pipeline compartido.

---

## Estructura del proyecto

```
dc-downloader/
├── .env.example
├── package.json
├── README.md
├── scripts/
│   └── test-download.js
└── src/
    ├── index.js
    ├── register-commands.js
    ├── config.js                 # entorno + validacion via registry
    ├── providers/
    │   ├── contract.js           # contrato del provider
    │   ├── index.js              # registry (unica lista a extender)
    │   ├── x.js
    │   ├── reddit.js
    │   ├── youtube.js
    │   └── tiktok.js
    ├── commands/
    │   ├── video.js
    │   └── help.js               # lista labels desde el registry
    └── services/
        ├── downloader.js         # pipeline agnostico al sitio
        ├── compressor.js
        └── tempCleanup.js
```

---

by Wanikoko
