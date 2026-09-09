import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '../public');

export function createApp() {
  const app = express();

  app.use(cors({ origin: true, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/sw.js', (_req, res) => {
    res.set('Service-Worker-Allowed', '/');
    res.set('Cache-Control', 'no-cache');
    res.type('application/javascript');
    res.sendFile(path.join(publicDir, 'sw.js'));
  });

  app.get('/manifest.webmanifest', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/manifest+json');
    res.sendFile(path.join(publicDir, 'manifest.webmanifest'));
  });

  app.use(express.static(publicDir));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(routes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const app = createApp();
export default app;
