import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { expandDiceTerms, parseExpression, formatTerms } from '../shared/dice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const clientRoot = path.join(root, 'client');
const port = Number(process.env.PORT || 3000);

let nextRollId = 1;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

function randomUint32() {
  return crypto.randomBytes(4).readUInt32LE(0) >>> 0;
}

function safePath(base, requestPath) {
  const normalized = path.normalize(requestPath).replace(/^([.][.][/\\])+/, '');
  const full = path.resolve(base, normalized);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

async function serveFile(req, res) {
  const raw = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);

  let filePath;

  if (raw === '/' || raw === '/index.html') {
    filePath = path.join(clientRoot, 'index.html');
  } else if (raw.startsWith('/shared/')) {
    // Shared deterministic utilities are intentionally exposed at /shared/*
    // so both the browser client and server use the same implementation.
    filePath = safePath(root, raw.slice('/'.length));
  } else {
    filePath = safePath(clientRoot, raw.slice('/'.length));
  }

  if (!filePath) {
    res.writeHead(400);
    res.end('Bad path');
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  } catch {
    if (raw === '/index.html') {
      res.writeHead(500);
      res.end('Missing client/index.html');
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }
}

const httpServer = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }
  serveFile(req, res).catch((error) => {
    console.error(error);
    res.writeHead(500);
    res.end('Server error');
  });
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

function broadcast(message) {
  const text = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(text);
  }
}

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'connected' }));

  socket.on('message', (raw) => {
    let request;
    try {
      request = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON request.' }));
      return;
    }

    if (request.type !== 'roll') {
      socket.send(JSON.stringify({ type: 'error', message: 'Unknown request type.' }));
      return;
    }

    try {
      const expression = String(request.expression ?? '');
      const terms = parseExpression(expression);
      const rollId = `roll-${String(nextRollId++).padStart(8, '0')}`;
      const rollSeed = randomUint32();
      const allowedSkins = new Set(['red', 'white', 'yellow', 'silver', 'tiedye']);
      const skin = allowedSkins.has(String(request.skin)) ? String(request.skin) : 'red';
      const expanded = expandDiceTerms(terms, rollId, rollSeed);

      if (expanded.dice.length === 0) {
        socket.send(JSON.stringify({
          type: 'roll',
          rollId,
          expression: formatTerms(terms),
          terms,
          skin,
          constantTotal: expanded.constantTotal,
          dice: [],
          rollSeed
        }));
        return;
      }

      const manifest = {
        type: 'roll',
        rollId,
        expression: formatTerms(terms),
        terms,
        skin,
        constantTotal: expanded.constantTotal,
        rollSeed,
        dice: expanded.dice
      };

      console.log(
        `[ROLL ${rollId}] ${manifest.expression} | seed=${rollSeed} | dice=${manifest.dice.length}`
      );
      broadcast(manifest);
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });
});

httpServer.listen(port, () => {
  console.log(`Dice server listening on http://localhost:${port}`);
  console.log(`WebSocket endpoint: ws://localhost:${port}/ws`);
});
