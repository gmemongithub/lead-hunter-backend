import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

export const CONFIG = {
  PORT: parseInt(process.env.PORT || process.env.SERVER_PORT || '3000', 10),
  NODE_ENV: process.env.NODE_ENV || 'production',
  APP_URL: process.env.APP_URL || `http://localhost:${process.env.PORT || process.env.SERVER_PORT || 3000}`,
  
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'gmemonhassan72@gmail.com',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'GMEMONHASAN12345@a',
  ADMIN_SLUG: process.env.ADMIN_SLUG || 'master-control',
  WHATSAPP_NUMBER: process.env.WHATSAPP_NUMBER || '+8801700000000',
  JWT_SECRET: process.env.JWT_SECRET || 'lead_hunter_super_secret_jwt_key_987654321',
  ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY || 'lh_master_secret_32bytes_key_0123456789',
  
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '../data/license.db'),
  MIN_EXTENSION_VERSION: process.env.MIN_EXTENSION_VERSION || '0.1.0',
  
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
};
