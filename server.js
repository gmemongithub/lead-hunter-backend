import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './src/config.js';
import { initDatabase } from './src/db/database.js';
import apiV1Router from './src/routes/api-v1.js';
import adminRouter from './src/routes/admin.js';
import portalRouter from './src/routes/portal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve HTML Dashboards (No-cache so user changes reflect immediately)
const viewsDir = path.join(__dirname, 'src/views');
const sendNoCache = (file) => (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(viewsDir, file));
};
app.get('/admin', sendNoCache('admin.html'));
app.get('/portal', sendNoCache('portal.html'));
app.get('/portal/setup', sendNoCache('setup.html'));
app.get('/portal/reset-password', sendNoCache('reset.html'));

// Root redirect
app.get('/', (req, res) => res.redirect('/portal'));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'Lead Hunter Security & License Server',
    version: '2.0.0',
    minExtensionVersion: CONFIG.MIN_EXTENSION_VERSION,
    time: new Date().toISOString(),
  });
});

// Mount API Routers
app.use('/api/v1', apiV1Router);
app.use('/admin/api', adminRouter);
app.use('/portal/api', portalRouter);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Server Unhandled Error]', err);
  res.status(500).json({
    error: 'SERVER_ERROR',
    message: CONFIG.NODE_ENV === 'development' ? err.message : 'An internal server error occurred.',
  });
});

// Boot Server
async function startServer() {
  try {
    await initDatabase();
    app.listen(CONFIG.PORT, '0.0.0.0', () => {
      console.log(`=======================================================`);
      console.log(`🚀 Lead Hunter Enterprise License Server running!`);
      console.log(`📡 URL: ${CONFIG.APP_URL}`);
      console.log(`🛡️  Admin Dashboard:  ${CONFIG.APP_URL}/admin`);
      console.log(`👤 Customer Portal:  ${CONFIG.APP_URL}/portal`);
      console.log(`🔌 Extension API:    ${CONFIG.APP_URL}/api/v1`);
      console.log(`=======================================================`);
    });
  } catch (err) {
    console.error('Fatal error starting license server:', err);
    process.exit(1);
  }
}

startServer();
