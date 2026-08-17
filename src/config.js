import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  apiKey: process.env.PSEUDOGRAM_API_KEY || '',
  baseUrl: process.env.PSEUDOGRAM_BASE_URL || 'https://pseudogram-api.onrender.com',
  dbPath: process.env.DB_PATH || './automation.db',
  
  // Rate limiting config: 10 requests per rolling 60 seconds
  // 60000ms / 10 = 6000ms safe interval between DM calls
  minDispatchIntervalMs: parseInt(process.env.RATE_LIMIT_INTERVAL_MS || '6000', 10),
  
  // Maximum retry attempts for 500 errors or failed deliveries
  maxRetries: 5,
  
  // Polling interval to reconcile pending DMs (mock API async status check)
  statusReconciliationIntervalMs: 5000,
};
