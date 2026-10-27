#!/bin/bash
set -euo pipefail
cd /var/www/html/dc-downloader
export PATH="$HOME/.local/bin:$PATH"
echo "=== require smoke ==="
node -e 'require("./src/config"); require("./src/providers"); require("./src/commands/video"); require("./src/services/downloader"); console.log("requires OK")'
echo "=== bins ==="
node -e 'const b=require("./src/utils/bins"); console.log(b)'
echo "=== yt-dlp ==="
yt-dlp --version
echo "=== pm2 status ==="
pm2 jlist | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); const a=d.find(x=>x.name==="dc-downloader"); console.log({status:a.pm2_env.status,uptime:Date.now()-a.pm2_env.pm_uptime,restarts:a.pm2_env.restart_time,unstable:a.pm2_env.unstable_restarts})'
echo "=== e2e start ==="
rm -f /tmp/vps-e2e.txt
node scripts/e2e-smoke.js all > /tmp/vps-e2e.txt 2>&1
echo "=== e2e done exit=$? ==="
tail -n 80 /tmp/vps-e2e.txt
