require('dotenv').config();
const { getConfig } = require('../src/config');
const c = getConfig();
console.log('r2Enabled=', c.r2Enabled, 'bucket=', c.r2Bucket, 'pub=', c.r2PublicBaseUrl ? 'set' : 'missing');
if (!c.r2Enabled) process.exit(2);
