import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config/env.js';
import { createApp } from './server.js';

const config = loadConfig();
const app = await createApp(config);

// MCP stdio owns stdout. Keep all operational messages on stderr.
serveStdio(() => app.server);
