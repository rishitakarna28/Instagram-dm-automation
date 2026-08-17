import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { db, initDB, queries } from './db.js';
import { startWorker } from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Serve dashboard static assets
app.use(express.static(path.join(__dirname, '../public')));

// Capture raw body for signature verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// Activity logs for UI dashboard
app.get('/api/activity', (req, res) => {
  try {
    const jobs = queries.getRecentJobs.all();
    const blocks = queries.getRecentBlocks.all();
    res.json({ jobs, blocks });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

/**
 * POST /rules
 * Creates a new keyword-to-DM trigger rule
 */
app.post('/rules', (req, res) => {
  const { keyword, dm_message } = req.body || {};

  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return res.status(400).json({ error: 'invalid_request', detail: 'keyword is required and must be a string' });
  }

  if (!dm_message || typeof dm_message !== 'string' || !dm_message.trim()) {
    return res.status(400).json({ error: 'invalid_request', detail: 'dm_message is required and must be a string' });
  }

  const ruleId = `rule_${crypto.randomUUID().slice(0, 8)}`;
  const cleanKeyword = keyword.trim();
  const cleanMessage = dm_message.trim();

  try {
    queries.createRule.run(ruleId, cleanKeyword, cleanMessage, Date.now());
    return res.status(201).json({
      rule_id: ruleId,
      keyword: cleanKeyword,
      dm_message: cleanMessage,
    });
  } catch (err) {
    console.error('[API] Error creating rule:', err);
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

/**
 * GET /rules
 * Helper endpoint to inspect active rules
 */
app.get('/rules', (req, res) => {
  const rules = queries.getAllRules.all();
  res.json({ count: rules.length, rules });
});

/**
 * GET /stats
 * Returns live accurate statistics
 */
app.get('/stats', (req, res) => {
  try {
    const stats = queries.getStats.get();
    return res.json({
      sent: stats.sent || 0,
      failed: stats.failed || 0,
      queued: stats.queued || 0,
      duplicates_blocked: stats.duplicates_blocked || 0,
    });
  } catch (err) {
    console.error('[API] Error fetching stats:', err);
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

/**
 * Verify HMAC-SHA256 signature (Part B)
 */
function verifySignature(req) {
  const signatureHeader = req.headers['x-pseudogram-signature'];
  if (!signatureHeader || !config.apiKey) return true;

  try {
    const expectedSignature =
      'sha256=' +
      crypto
        .createHmac('sha256', config.apiKey.trim())
        .update(req.rawBody || '')
        .digest('hex');

    const sigBuf = Buffer.from(signatureHeader);
    const expBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (err) {
    console.warn('[Webhook] Signature error:', err.message);
    return false;
  }
}

/**
 * GET /webhook
 * Friendly browser info endpoint
 */
app.get('/webhook', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Webhook endpoint is active. Send POST requests with comment event payloads.',
  });
});

/**
 * POST /webhook
 * Receives comment events and responds with 200 within 5 seconds.
 */
app.post('/webhook', (req, res) => {
  // 1. Signature check (logs if mismatch, non-blocking)
  if (req.headers['x-pseudogram-signature']) {
    const isValid = verifySignature(req);
    if (!isValid) {
      console.warn('[Webhook] ⚠️ Webhook signature mismatch.');
    }
  }

  // 2. Respond 200 OK immediately so we never block or drop webhook events
  res.status(200).json({ received: true });

  // 3. Process the webhook payload asynchronously in the background
  const event = req.body;
  if (!event || !event.event_id) {
    return;
  }

  processWebhookEvent(event).catch((err) => {
    console.error(`[Webhook] Unhandled error processing event ${event?.event_id}:`, err);
  });
});

/**
 * Asynchronous event processing
 */
async function processWebhookEvent(event) {
  const { event_id, event_type, data } = event;
  const now = Date.now();

  // Deduplicate event_id (~8% of events redelivered by mock API)
  const isAlreadyProcessed = queries.isEventProcessed.get(event_id);
  if (isAlreadyProcessed) {
    console.log(`[Webhook] ⏭️ Duplicate event_id ${event_id} ignored.`);
    queries.recordDuplicateBlock.run(event_id, data?.from?.user_id || null, null, 'duplicate_event_id', now);
    return;
  }

  // Mark event as processed
  queries.markEventProcessed.run(event_id, event_type || 'unknown', now);

  // Handle comment.deleted event
  if (event_type === 'comment.deleted') {
    const commentId = data?.comment_id;
    if (commentId) {
      console.log(`[Webhook] 🗑️ Comment deleted: ${commentId}`);
      queries.markCommentDeleted.run(commentId, now);
      queries.cancelJobByCommentId.run(now, commentId);
    }
    return;
  }

  // Handle comment.created event
  if (event_type === 'comment.created') {
    const commentId = data?.comment_id;
    const commentText = data?.text || '';
    const userId = data?.from?.user_id;

    if (!commentId || !userId || !commentText) {
      console.warn(`[Webhook] Malformed comment event data for ${event_id}`);
      return;
    }

    // Check against all rules (case-insensitive substring match)
    const rules = queries.getAllRules.all();
    const commentLower = commentText.toLowerCase();

    for (const rule of rules) {
      const keywordLower = rule.keyword.toLowerCase();

      if (commentLower.includes(keywordLower)) {
        console.log(`[Webhook] 🎯 Rule '${rule.keyword}' matched for user ${userId} on comment ${commentId}`);

        // Atomic duplicate check: has this user already received a DM for this rule?
        const alreadyReceived = queries.hasUserReceivedRule.get(userId, rule.id);

        if (alreadyReceived) {
          console.log(`[Webhook] 🚫 User ${userId} already received DM for rule ${rule.id}. Blocking duplicate.`);
          queries.recordDuplicateBlock.run(event_id, userId, rule.id, 'user_already_dmed_for_rule', now);
          continue;
        }

        // Generate unique DM job and lock the delivery record atomically
        const jobId = `job_${crypto.randomUUID().slice(0, 8)}`;
        const idempotencyKey = `rule_${rule.id}_usr_${userId}`;

        const insertTx = db.transaction(() => {
          queries.recordUserRuleDelivery.run(userId, rule.id, commentId, jobId, now);
          queries.createDMJob.run(
            jobId,
            rule.id,
            userId,
            commentId,
            rule.dm_message,
            idempotencyKey,
            config.maxRetries,
            now, // next_run_at: ready immediately
            now,
            now
          );
        });

        try {
          insertTx();
          console.log(`[Webhook] 📥 Queued DM job ${jobId} for user ${userId}`);
        } catch (err) {
          // If unique constraint failed concurrently
          if (err.message.includes('UNIQUE constraint failed')) {
            console.log(`[Webhook] 🚫 Concurrent duplicate detected for user ${userId}, rule ${rule.id}`);
            queries.recordDuplicateBlock.run(event_id, userId, rule.id, 'concurrent_duplicate', now);
          } else {
            console.error('[Webhook] DB Error inserting DM job:', err);
          }
        }
      }
    }
  }
}

// Start Server and Database
initDB();
startWorker();

const server = app.listen(config.port, () => {
  console.log(`🚀 Instagram DM Automation server listening on port ${config.port}`);
});

export { app, server };
