// server/config.js — Environment configuration
import 'dotenv/config';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
  port:          parseInt(process.env.PORT || '5000', 10),
  dataDir:       join(__dirname, '..', 'data'),
  dbPath:        join(__dirname, '..', 'data', 'ir.db'),
  railradar: {
    baseUrl:     process.env.RAILRADAR_BASE_URL   || 'https://api.railradar.in',
    endpoint:    process.env.LIVE_SNAPSHOT_ENDPOINT || '/api/v1/trains/live-map',
    apiKey:      (process.env.RAILRADAR_API_KEY    || '').trim(),
    pollSeconds: Math.max(20, parseInt(process.env.LIVE_SNAPSHOT_POLL_SECONDS || '60', 10)),
  },
  liveUpdateInterval: Math.max(2, parseInt(process.env.LIVE_UPDATE_INTERVAL_SECONDS || '15', 10)),
  spatialRange: {
    default: 250,
    min:     10,
    max:     3000,
  },
};
