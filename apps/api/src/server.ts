import { createDb } from '@ttyd/db';
import { createApp } from './app';
import { env } from './env';

const { db, close } = createDb(env.DATABASE_URL);
const app = createApp({ db });

const server = app.listen(env.PORT, (error) => {
  if (error) throw error;
  console.log(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Stop accepting connections, let in-flight requests finish, then release DB connections.
function shutdown(signal: NodeJS.Signals) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
