/**
 * Cloudflare R2 storage (S3-compatible) for long Discord videos (>5 min).
 * Public objects are served from R2_PUBLIC_BASE_URL so Discord can unfurl a native player.
 *
 * Retention is NOT age-based: FIFO eviction keeps bucket ≤ R2_MAX_STORAGE_GB (default 9)
 * to stay under Cloudflare's free 10 GB tier with headroom.
 */
const fs = require('fs');
const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

function createR2Client(config) {
  return new S3Client({
    region: 'auto',
    endpoint: config.r2Endpoint,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
    forcePathStyle: true,
  });
}

function isR2Configured(config) {
  return Boolean(
    config &&
      config.r2Enabled &&
      config.r2Bucket &&
      config.r2Endpoint &&
      config.r2AccessKeyId &&
      config.r2SecretAccessKey &&
      config.r2PublicBaseUrl
  );
}

function publicObjectUrl(config, key) {
  const base = String(config.r2PublicBaseUrl || '').replace(/\/+$/, '');
  const safeKey = String(key || '')
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
  return `${base}/${safeKey}`;
}

async function listAllObjects(client, bucket) {
  const objects = [];
  let continuationToken;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of listed.Contents || []) {
      if (obj && obj.Key) objects.push(obj);
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

async function emptyBucket(config) {
  if (!isR2Configured(config)) {
    throw new Error('R2 no está configurado.');
  }
  const client = createR2Client(config);
  const contents = await listAllObjects(client, config.r2Bucket);
  if (!contents.length) return { removed: 0 };

  // Delete in batches of 1000 (S3 limit)
  let removed = 0;
  for (let i = 0; i < contents.length; i += 1000) {
    const chunk = contents.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: config.r2Bucket,
        Delete: {
          Objects: chunk.map((obj) => ({ Key: obj.Key })),
          Quiet: true,
        },
      })
    );
    removed += chunk.length;
  }
  return { removed };
}

/**
 * Upload a local file; returns { key, publicUrl, sizeBytes }.
 * Then enforces FIFO storage budget (default ≤9 GB).
 */
async function uploadFile(config, localPath, key, options = {}) {
  if (!isR2Configured(config)) {
    throw new Error('R2 no está configurado.');
  }
  const client = createR2Client(config);
  const contentType = options.contentType || 'video/mp4';
  const sizeBytes = fs.statSync(localPath).size;
  const common = {
    Bucket: config.r2Bucket,
    Key: key,
    ContentType: contentType,
    ContentDisposition: 'inline',
    CacheControl: 'public, max-age=3600',
  };

  // Multipart Upload can hang on some R2 setups; use simple Put for typical sizes.
  if (sizeBytes <= 95 * 1024 * 1024) {
    if (typeof options.onProgress === 'function') options.onProgress(5);
    const body = fs.createReadStream(localPath);
    await client.send(
      new PutObjectCommand({
        ...common,
        Body: body,
        ContentLength: sizeBytes,
      })
    );
    if (typeof options.onProgress === 'function') options.onProgress(100);
  } else {
    const body = fs.createReadStream(localPath);
    const upload = new Upload({
      client,
      params: { ...common, Body: body },
      queueSize: 4,
      partSize: 16 * 1024 * 1024,
      leavePartsOnError: false,
    });
    if (typeof options.onProgress === 'function') {
      upload.on('httpUploadProgress', (prog) => {
        if (!prog || !prog.total) return;
        const pct = Math.min(100, (prog.loaded / prog.total) * 100);
        options.onProgress(pct);
      });
    }
    await upload.done();
  }

  // FIFO eviction so free-tier usage stays under the soft cap (default 9 GB of 10 GB).
  const fifo = await enforceStorageBudget(config, { protectKey: key }).catch((err) => {
    console.warn('[r2-fifo] enforce failed:', err.message || err);
    return { removed: 0, totalBytes: null };
  });

  return {
    key,
    publicUrl: publicObjectUrl(config, key),
    sizeBytes,
    fifo,
  };
}

async function deleteObject(config, key) {
  if (!isR2Configured(config) || !key) return;
  const client = createR2Client(config);
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.r2Bucket,
        Key: key,
      })
    );
  } catch {
    // ignore missing
  }
}

/**
 * FIFO storage budget: if total object size > r2MaxStorageBytes, delete oldest first
 * until under the cap. Newest uploads (protectKey) are deleted last.
 *
 * @param {object} config
 * @param {{ protectKey?: string }} [options]
 * @returns {Promise<{ removed: number, totalBytes: number, maxBytes: number }>}
 */
async function enforceStorageBudget(config, options = {}) {
  if (!isR2Configured(config)) {
    return { removed: 0, totalBytes: 0, maxBytes: 0 };
  }
  const maxBytes = config.r2MaxStorageBytes;
  const client = createR2Client(config);
  const objects = await listAllObjects(client, config.r2Bucket);

  let totalBytes = objects.reduce((sum, obj) => sum + (Number(obj.Size) || 0), 0);
  if (totalBytes <= maxBytes) {
    return { removed: 0, totalBytes, maxBytes };
  }

  // Oldest first; keep protectKey until everything else is gone.
  const protectKey = options.protectKey || null;
  const ordered = objects.slice().sort((a, b) => {
    const ta = a.LastModified ? new Date(a.LastModified).getTime() : 0;
    const tb = b.LastModified ? new Date(b.LastModified).getTime() : 0;
    if (a.Key === protectKey) return 1;
    if (b.Key === protectKey) return -1;
    return ta - tb;
  });

  const toDelete = [];
  for (const obj of ordered) {
    if (totalBytes <= maxBytes) break;
    toDelete.push({ Key: obj.Key });
    totalBytes -= Number(obj.Size) || 0;
  }

  let removed = 0;
  for (let i = 0; i < toDelete.length; i += 1000) {
    const chunk = toDelete.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: config.r2Bucket,
        Delete: { Objects: chunk, Quiet: true },
      })
    );
    removed += chunk.length;
  }

  if (removed > 0) {
    console.log(
      `[r2-fifo] removed ${removed} object(s); budget ${(maxBytes / 1024 / 1024 / 1024).toFixed(2)} GB, now ~${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`
    );
  }

  return { removed, totalBytes, maxBytes };
}

/** @deprecated age-based R2 GC — use enforceStorageBudget (FIFO) instead */
async function sweepExpiredObjects(config) {
  return enforceStorageBudget(config);
}

function buildObjectKey(jobId, ext = '.mp4') {
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
  const day = new Date().toISOString().slice(0, 10);
  return `videos/${day}/${jobId}${safeExt}`;
}

module.exports = {
  isR2Configured,
  createR2Client,
  publicObjectUrl,
  emptyBucket,
  uploadFile,
  deleteObject,
  enforceStorageBudget,
  sweepExpiredObjects,
  buildObjectKey,
};
