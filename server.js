// server.js — Krypton v2 entry point
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import cfg from './server/config.js';
import { initDb } from './server/db.js';
import { startPoller } from './server/railradar.js';
import { setupTracking } from './server/tracking.js';
import routes from './server/routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const http = createServer(app);
const io   = new Server(http, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API routes first
app.use(routes);

// Static files (public/) — serves index.html for /
const publicDir = join(__dirname, 'public');
app.use(express.static(publicDir));

// Fallback: serve index.html for root and any unmatched routes (SPA pattern)
app.get('/{*path}', (req, res) => {
  res.sendFile(join(publicDir, 'index.html'));
});

async function start() {
  console.log('[krypton] Initializing database...');
  await initDb();

  console.log('[krypton] Starting RailRadar poller...');
  startPoller();

  console.log('[krypton] Setting up live tracking...');
  setupTracking(io);

  http.listen(cfg.port, () => {
    console.log(`[krypton] ✓ Running on http://localhost:${cfg.port}`);
  });
}

start().catch(err => {
  console.error('[krypton] Fatal:', err);
  process.exit(1);
});
