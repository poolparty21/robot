/**
 * Vercel serverless entry point.
 * Re-exports the Express app so @vercel/node can serve it.
 */
const app = require('../server');

module.exports = app;
