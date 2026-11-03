import { createDb, pingDatabase } from '@ttyd/db';
import { createApp } from './app';
import { env } from './env';

const FORCE_EXIT_AFTER_MS = 10_000;

let shuttingDown = false;

const { db, close } = createDb(env.DATABASE_URL);
const app = createApp({ db, isShuttingDown: () => shuttingDown });

const server = app.listen(env.PORT, (error) => {
  if (error) throw error;
  console.log(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Open the first database connection now (TLS + login can take seconds) so the first readiness probe doesn't
// pay for it and fail its 2s limit. Not fatal: /health/ready keeps reporting 503 until the database answers.
pingDatabase(db).catch((err) => console.warn('Database not reachable yet at startup', err.message));

// Stop accepting connections, let in-flight requests finish, then release DB connections.
// Runs once: a second signal (impatient Ctrl+C, orchestrator retry) must not cut the drain short.
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  setTimeout(() => {
    console.error(`Requests still running after ${FORCE_EXIT_AFTER_MS}ms, forcing exit`);
    process.exit(1);
  }, FORCE_EXIT_AFTER_MS).unref();

  server.close(async (closeError) => {
    let exitCode = 0;
    if (closeError) {
      console.error('Error while closing the HTTP server', closeError);
      exitCode = 1;
    }
    try {
      await close();
    } catch (err) {
      console.error('Error while closing database connections', err);
      exitCode = 1;
    }
    process.exit(exitCode);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
