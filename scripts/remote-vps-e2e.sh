#!/bin/bash
set -euo pipefail
cd /var/www/html/dc-downloader
export PATH="$HOME/.local/bin:$PATH"
echo "=== yt-dlp version ==="
yt-dlp --version
echo "=== EJS metadata Goth ==="
yt-dlp --skip-download --no-warnings -4 \
  --js-runtimes node \
  --remote-components ejs:github \
  --extractor-args "youtube:player_client=android,web_embedded,tv,ios,web" \
  --print "%(id)s %(duration)s %(title)s" \
  "https://www.youtube.com/watch?v=q4N48-fOXeU"
echo "=== E2E smoke ==="
node scripts/e2e-smoke.js all
echo "=== DONE ==="
