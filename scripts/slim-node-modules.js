#!/usr/bin/env node
/**
 * Drop leftover fat optional packages from older installs (ffmpeg-static, etc.).
 * Safe as postinstall: only removes known paths under node_modules / .npm.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(path.join(__dirname, '..'));
const nm = path.join(root, 'node_modules');

const DROP = [
  'ffmpeg-static',
  'ffprobe-static',
  'youtube-dl-exec',
  'fluent-ffmpeg',
  '@aws-sdk/lib-storage',
  '@ffmpeg-installer',
  '@ffprobe-installer',
  '@derhuerst',
  '@kikobeats',
];

function isSafeToRm(p) {
  if (!p) return false;
  const resolved = path.resolve(p);
  if (resolved === root) return false;
  if (resolved === path.parse(resolved).root) return false;
  if (resolved === path.resolve('.')) return false;
  // only allow deleting known cache/deps paths under project or home
  const home = process.env.HOME ? path.resolve(process.env.HOME) : '';
  const underRoot = resolved.startsWith(root + path.sep);
  const underHomeNpm = home && resolved === path.join(home, '.npm');
  const underRootNpm = resolved === path.join(root, '.npm');
  const underNm = resolved.startsWith(nm + path.sep) || resolved === nm;
  const underTemp = resolved.startsWith(path.join(root, 'temp') + path.sep);
  return underNm || underRootNpm || underHomeNpm || underTemp || (underRoot && resolved.includes(`${path.sep}node_modules${path.sep}`));
}

function rm(p) {
  try {
    if (!p || !fs.existsSync(p)) return false;
    if (!isSafeToRm(p)) {
      console.warn(`[slim] refuse to remove unsafe path: ${p}`);
      return false;
    }
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.warn(`[slim] failed ${p}: ${err.message}`);
    return false;
  }
}

let removed = 0;
for (const name of DROP) {
  if (rm(path.join(nm, name))) {
    removed += 1;
    console.log(`[slim] removed node_modules/${name}`);
  }
}

// npm download cache keeps old fat tarballs and fills the 512 MB quota.
const cacheCandidates = [path.join(root, '.npm')];
if (process.env.HOME) cacheCandidates.push(path.join(process.env.HOME, '.npm'));
if (process.env.npm_config_cache && String(process.env.npm_config_cache).trim()) {
  cacheCandidates.push(path.resolve(process.env.npm_config_cache));
}
for (const cachePath of cacheCandidates) {
  if (rm(cachePath)) console.log(`[slim] removed npm cache ${cachePath}`);
}

// Clean local temp job leftovers aggressively on tiny hosts.
const tempDir = path.join(root, 'temp');
if (fs.existsSync(tempDir)) {
  try {
    for (const name of fs.readdirSync(tempDir)) {
      if (name === 'test-out') continue;
      rm(path.join(tempDir, name));
    }
  } catch {
    // ignore
  }
}

if (removed) console.log(`[slim] dropped ${removed} fat package(s)`);
else console.log('[slim] nothing to drop');
