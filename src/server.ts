import { createApp } from './app';
import { closePool } from './config/db';
import { env } from './config/env';
import { waitForPendingEmails } from './services/email';
import { waitForPendingNotifications } from './services/notifications';
import { logger } from './utils/logger';

const app = createApp();

const server = app.listen(env.PORT, (error?: Error) => {
  if (error) {
    logger.fatal({ err: error }, `Could not start on port ${env.PORT}`);
    process.exit(1);
  }
  logger.info({ port: env.PORT, environment: env.NODE_ENV }, 'Lepara API is listening');
});

let shuttingDown = false;

/**
 * Stops taking new requests, lets open ones and emails and push notifications
 * still being sent finish, then closes the database pool.
 */
function shutdown(reason: string, exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'Shutting down');

  const forceExit = setTimeout(() => {
    logger.error('Open requests did not finish within 10 seconds; forcing exit');
    process.exit(exitCode || 1);
  }, 10_000);
  forceExit.unref();

  server.close(() => {
    Promise.all([waitForPendingEmails(), waitForPendingNotifications()])
      .then(() => closePool())
      .catch((error: unknown) => logger.error({ err: error }, 'Could not close the database pool'))
      .finally(() => process.exit(exitCode));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));

// A bug that escaped every handler: log it, then restart cleanly (the host restarts the process).
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  shutdown('uncaughtException', 1);
});
