/**
 * Starts the HTTP server and wires graceful shutdown: stop taking new requests, let in-flight
 * ones finish, stop background workers, close pools — then exit. Kubernetes/ECS send SIGTERM
 * before killing a container, so this avoids dropping requests during deploys.
 */
export function runService({ app, port, logger, shutdown = [] }) {
  const server = app.listen(port, () => logger.info({ port }, 'Service listening'));
  let stopping = false;

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down gracefully');
    const force = setTimeout(() => {
      logger.warn('Forcing exit after timeout');
      process.exit(1);
    }, 10_000);
    force.unref();
    await new Promise((resolve) => {
      server.close(() => resolve());
      // Long-lived connections (SSE, keep-alive) would otherwise hold close() open.
      setTimeout(() => server.closeAllConnections(), 2_000).unref();
    });
    for (const fn of shutdown) {
      try {
        await fn();
      } catch (err) {
        logger.error({ err }, 'Error during shutdown step');
      }
    }
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
  return server;
}
