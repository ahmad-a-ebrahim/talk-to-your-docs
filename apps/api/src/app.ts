import { type Database, pingDatabase } from '@ttyd/db';
import { STATUS_CODES } from 'node:http';
import express, { type ErrorRequestHandler } from 'express';

const READINESS_TIMEOUT_MS = 2_000;

type AppDeps = {
  db: Database;
  /** True once shutdown has started, so readiness tells the load balancer to stop sending traffic. */
  isShuttingDown: () => boolean;
};

/** Rejects if `promise` takes longer than `ms`. The timer is always cleared so it can't keep the process alive. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createApp({ db, isShuttingDown }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // Liveness: the process is up. Deliberately doesn't touch the DB, so a database blip
  // doesn't make the host restart an otherwise healthy process.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: can we actually serve traffic right now? A draining instance says no immediately, and a
  // stalled database gives a fast 503 instead of a probe that hangs until the orchestrator gives up.
  app.get('/health/ready', async (_req, res) => {
    if (isShuttingDown()) {
      res.status(503).json({ status: 'shutting_down' });
      return;
    }
    try {
      await withTimeout(pingDatabase(db), READINESS_TIMEOUT_MS);
      res.json({ status: 'ready' });
    } catch (err) {
      console.error('Readiness check failed: database unreachable', err);
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Express 5 forwards rejected promises here too. Clients get the standard HTTP reason for 4xx
  // ("Payload Too Large", ...) and a generic message for anything else, never a stack trace.
  const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
    // Headers already sent (e.g. mid-stream): we can't write a new response, so let Express's default
    // handler close the connection instead of throwing ERR_HTTP_HEADERS_SENT.
    if (res.headersSent) {
      next(err);
      return;
    }
    const status =
      typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({
      error: status === 500 ? 'Internal server error' : (STATUS_CODES[status] ?? 'Bad request'),
    });
  };
  app.use(errorHandler);

  return app;
}
