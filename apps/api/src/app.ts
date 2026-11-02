import { type Database, pingDatabase } from '@ttyd/db';
import express, { type ErrorRequestHandler } from 'express';

type AppDeps = {
  db: Database;
};

export function createApp({ db }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // Liveness: the process is up. Deliberately doesn't touch the DB, so a database blip
  // doesn't make the host restart an otherwise healthy process.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: can we actually serve traffic right now?
  app.get('/health/ready', async (_req, res) => {
    try {
      await pingDatabase(db);
      res.json({ status: 'ready' });
    } catch (err) {
      console.error('Readiness check failed: database unreachable', err);
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Express 5 forwards rejected promises here too. Clients get a generic message, never a stack trace.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const status =
      typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Bad request' });
  };
  app.use(errorHandler);

  return app;
}
