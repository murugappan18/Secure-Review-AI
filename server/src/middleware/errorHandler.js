// Central Express error handler. Must be registered LAST in the middleware
// chain, after all routes. Logs the full error server-side, returns a safe
// shape to the client.
export function errorHandler(err, req, res, _next) {
  // eslint-disable-next-line no-console
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);

  if (res.headersSent) {
    // Express's default handler will close the connection; just delegate.
    return;
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.publicMessage || (status >= 500 ? 'internal_error' : err.message),
  });
}
