# Estructura del proyecto

```
dc-downloader/
├── .env.example
├── AGENTS.md                 # Guía operativa para agentes / IAs
├── CLAUDE.md                 # Entrada Claude Code → AGENTS + docs
├── USO.md                    # Uso rápido en Discord
├── README.md                 # Hub (índice a docs/)
├── assets/
│   └── dc-mark.png · dc-logo.svg  # Marca del repo
├── ecosystem.config.js       # PM2
├── package.json
├── docs/
│   ├── architecture.md
│   ├── providers.md
│   ├── setup.md
│   ├── commands.md
│   ├── troubleshooting.md
│   └── structure.md          # este archivo
├── scripts/
│   ├── test-download.js
│   ├── e2e-smoke.js
│   ├── ensure-bins.js
│   ├── verify-bins.js
│   └── slim-node-modules.js
└── src/
    ├── index.js              # Entrada del bot
    ├── register-commands.js  # Slash commands por guild
    ├── config.js             # Env + validación URL
    ├── commands/
    │   ├── video.js
    │   └── help.js
    ├── providers/
    │   ├── contract.js
    │   ├── index.js          # Registry
    │   ├── formats.js
    │   └── x | reddit | youtube | tiktok | instagram | facebook | spotify
    ├── services/
    │   ├── downloader.js
    │   ├── compressor.js
    │   ├── r2Storage.js
    │   ├── jobQueue.js
    │   └── tempCleanup.js
    └── utils/
        ├── progress.js
        ├── bins.js
        ├── botAvailability.js
        └── downloadError.js
```

| Pregunta | Archivo |
|----------|---------|
| ¿Dónde se aceptan slash commands? | `src/index.js` |
| ¿Dónde se define `/video`? | `src/commands/video.js` |
| ¿Dónde se valida la URL? | `src/config.js` → `parseAllowedUrl` |
| ¿Dónde se añade un sitio nuevo? | `src/providers/<id>.js` + `index.js` |
| ¿Dónde se descarga? | `src/services/downloader.js` |
| ¿Dónde se comprime? | `src/services/compressor.js` |
| ¿Dónde está la cola? | `src/services/jobQueue.js` |
| ¿Dónde se pinta el %? | `src/utils/progress.js` |
| ¿Dónde se leen límites? | `src/config.js` ← env |
