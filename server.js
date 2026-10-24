import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { logger } from './lib/logger.js';
import { Errors } from './lib/errors.js';
import { requestContext } from './middleware/request-context.js';
import { errorHandler, notFoundHandler, asyncHandler } from './middleware/error-handler.js';
import { securityMiddleware } from './middleware/security.js';

import { loadDataset, getStats as getDatasetStats } from './lib/dataset.js';
import { reason, getCacheStats as getGroqCacheStats } from './lib/groq.js';
import { handleMessage, getSessionView } from './lib/agent.js';
import { createSession, closeSession } from './lib/session-store.js';
import * as nkenne from './lib/nkenne.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

logger.info('boot.start', { env: config.env, model: config.groq.model });

await loadDataset(
  path.resolve(__dirname, config.dataset.episodesPath),
  path.resolve(__dirname, config.dataset.goldPath),
  path.resolve(__dirname, config.dataset.swahiliPath),
  path.resolve(__dirname, config.dataset.swahiliGoldPath)
);
logger.info('boot.dataset.loaded', getDatasetStats());

const app = express();

app.use(...securityMiddleware);
app.use(requestContext);
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    env: config.env,
    uptime: Math.round(process.uptime()),
    dataset: getDatasetStats(),
    tokens: nkenne.getSessionStats(),
    groqCache: getGroqCacheStats(),
    requestId: req.id,
  });
});

app.post('/api/chat', asyncHandler(async (req, res) => {
  const { sessionId, input } = req.body || {};
  if (!input || typeof input !== 'string') throw Errors.validation('"input" must be a non-empty string');
  if (input.length > 2000) throw Errors.validation('"input" exceeds 2000 character limit');

  const result = await handleMessage(sessionId || null, input);
  res.json({ ...result, requestId: req.id });
}));

app.post('/api/reason', asyncHandler(async (req, res) => {
  const { input } = req.body || {};
  if (!input || typeof input !== 'string') throw Errors.validation('"input" must be a non-empty string');
  if (input.length > 2000) throw Errors.validation('"input" exceeds 2000 character limit');
  const result = await reason(input);
  res.json({ ...result, requestId: req.id });
}));

app.post('/api/session', asyncHandler(async (req, res) => {
  const session = createSession(req.body?.context || {});
  res.status(201).json({ sessionId: session.id, session, requestId: req.id });
}));

app.get('/api/session/:id', asyncHandler(async (req, res) => {
  const session = getSessionView(req.params.id);
  res.json({ session, requestId: req.id });
}));

app.post('/api/session/:id/close', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const session = getSessionView(id);
  closeSession(id);
  res.json({ sessionId: id, status: 'closed', previousStatus: session.status, requestId: req.id });
}));

app.post('/api/stt', upload.single('audio'), asyncHandler(async (req, res) => {
  if (!req.file) throw Errors.validation('No audio file');
  const result = await nkenne.stt(req.file.buffer, req.file.mimetype);
  res.json({ text: result.text, duration: result.duration, language: 'swahili', requestId: req.id });
}));

app.post('/api/translate', asyncHandler(async (req, res) => {
  const { text, from = 'English', to = 'Swahili' } = req.body || {};
  if (!text) throw Errors.validation('"text" is required');
  const result = await nkenne.translate(text, from, to);
  await nkenne.writeLog();
  res.json({ translatedText: result.text, tokensRemaining: result.tokensRemaining, requestId: req.id });
}));

app.post('/api/tts', asyncHandler(async (req, res) => {
  const { text } = req.body || {};
  if (!text) throw Errors.validation('"text" is required');
  const result = await nkenne.tts(text);
  await nkenne.writeLog();
  res.set('Content-Type', result.contentType);
  res.send(result.audio);
}));

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  logger.info('boot.ready', { port: config.port, url: `http://localhost:${config.port}` });
});

function shutdown(signal) {
  logger.info('shutdown.start', { signal });
  server.close(() => {
    logger.info('shutdown.complete');
    process.exit(0);
  });
  setTimeout(() => { logger.error('shutdown.forced'); process.exit(1); }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.error({ err: { message: String(err) } }, 'unhandledRejection');
});