/**
 * Cloudflare R2 storage (S3-compatible) for long Discord videos (>5 min).
 * Public objects are served from R2_PUBLIC_BASE_URL so Discord can unfurl a native player.
 */
const fs = require('fs');
const path = require('path');
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

async function emptyBucket(config) {
  if (!isR2Configured(config)) {
    throw new Error('R2 no está configurado.');
  }
  const client = createR2Client(config);
  let removed = 0;
  let continuationToken;

  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: config.r2Bucket,
        ContinuationToken: continuationToken,
      })
    );
    const contents = listed.Contents || [];
    if (contents.length) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: config.r2Bucket,
          Delete: {
            Objects: contents.map((obj) => ({ Key: obj.Key })),
            Quiet: true,
          },
        })
      );
      removed += contents.length;
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return { removed };
}

/**
 * Upload a local file; returns { key, publicUrl, sizeBytes }.
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

  return {
    key,
    publicUrl: publicObjectUrl(config, key),
    sizeBytes,
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
 * Delete R2 objects older than tempMaxAgeHours (same retention as local TEMP_DIR).
 */
async function sweepExpiredObjects(config) {
  if (!isR2Configured(config)) return { removed: 0 };
  const client = createR2Client(config);
  const maxAgeMs = config.tempMaxAgeHours * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let continuationToken;

  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: config.r2Bucket,
        ContinuationToken: continuationToken,
      })
    );
    const stale = (listed.Contents || []).filter((obj) => {
      const t = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
      return t > 0 && t < cutoff;
    });
    if (stale.length) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: config.r2Bucket,
          Delete: {
            Objects: stale.map((obj) => ({ Key: obj.Key })),
            Quiet: true,
          },
        })
      );
      removed += stale.length;
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return { removed };
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
  sweepExpiredObjects,
  buildObjectKey,
};
