import { config } from './config.js';
import { db, queries } from './db.js';

let isRunning = false;
let dispatchTimer = null;
let reconcilerTimer = null;
let nextAllowedDispatchTime = 0;

// Rate-limiting sliding window / interval tracking
function getNextDispatchDelay() {
  const now = Date.now();
  if (now < nextAllowedDispatchTime) {
    return nextAllowedDispatchTime - now;
  }
  return 0;
}

function updateNextAllowedDispatchTime(cooldownMs = config.minDispatchIntervalMs) {
  nextAllowedDispatchTime = Date.now() + cooldownMs;
}

/**
 * Dispatch a single DM job to the Mock API
 */
async function processNextJob() {
  if (!isRunning) return;

  const now = Date.now();
  const job = queries.getNextQueuedJob.get(now);

  if (!job) {
    // No jobs ready to send; check again in 500ms
    dispatchTimer = setTimeout(processLoop, 500);
    return;
  }

  // Check rate limit delay
  const delay = getNextDispatchDelay();
  if (delay > 0) {
    dispatchTimer = setTimeout(processLoop, delay);
    return;
  }

  // Check if comment was deleted in the meantime
  const isDeleted = queries.isCommentDeleted.get(job.comment_id);
  if (isDeleted) {
    console.log(`[Worker] Skipping DM job ${job.id}: Comment ${job.comment_id} was deleted.`);
    queries.updateJobStatus.run('cancelled', null, 'Comment deleted before sending', 0, job.attempts, Date.now(), job.id);
    dispatchTimer = setTimeout(processLoop, 50);
    return;
  }

  const currentAttempt = (job.attempts || 0) + 1;

  // Mark job as in_flight with current attempt number
  queries.updateJobStatus.run('in_flight', null, null, 0, currentAttempt, Date.now(), job.id);
  updateNextAllowedDispatchTime(config.minDispatchIntervalMs);

  const url = `${config.baseUrl}/v1/dm/send`;
  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': config.apiKey,
    'Idempotency-Key': `${job.idempotency_key}_att${currentAttempt}`,
  };

  const payload = {
    recipient_user_id: job.recipient_user_id,
    message: job.message,
    comment_id: job.comment_id,
  };

  try {
    console.log(`[Worker] Sending DM for job ${job.id} to user ${job.recipient_user_id} (comment ${job.comment_id})...`);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const responseText = await res.text();
    let data = {};
    try {
      data = JSON.parse(responseText);
    } catch {
      // Non-JSON response
    }

    if ((res.status === 200 || res.status === 202) && data.dm_id) {
      // Accepted by mock API
      const dmId = data.dm_id;
      console.log(`[Worker] ✅ DM accepted: dm_id=${dmId} for job ${job.id}`);
      queries.updateJobStatus.run('accepted', dmId, null, 0, currentAttempt, Date.now(), job.id);
    } else if (res.status === 429) {
      // Rate limited
      const retryAfterHeader = res.headers.get('Retry-After');
      const retrySeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 10;
      const cooldownMs = (retrySeconds + 1) * 1000;
      console.warn(`[Worker] ⚠️ Rate limited (429). Pausing for ${retrySeconds}s...`);
      updateNextAllowedDispatchTime(cooldownMs);

      // Requeue job without incrementing attempts
      queries.updateJobStatus.run(
        'queued',
        null,
        `Rate limited (429), retry after ${retrySeconds}s`,
        Date.now() + cooldownMs,
        job.attempts,
        Date.now(),
        job.id
      );
    } else if (res.status === 500) {
      // Mock API 500 internal error (safe to retry)
      const nextAttempt = job.attempts + 1;
      if (nextAttempt >= job.max_attempts) {
        console.error(`[Worker] ❌ DM job ${job.id} failed permanently after ${nextAttempt} attempts (500 error).`);
        queries.updateJobStatus.run('failed', null, 'Mock API 500 (max retries exceeded)', 0, nextAttempt, Date.now(), job.id);
      } else {
        const backoffMs = Math.min(30000, Math.pow(2, nextAttempt) * 1000 + Math.floor(Math.random() * 500));
        console.warn(`[Worker] ⚠️ Mock API 500 error. Retrying attempt ${nextAttempt}/${job.max_attempts} in ${backoffMs}ms...`);
        queries.updateJobStatus.run(
          'queued',
          null,
          `500 Internal Error (attempt ${nextAttempt})`,
          Date.now() + backoffMs,
          nextAttempt,
          Date.now(),
          job.id
        );
      }
    } else if (res.status === 400) {
      // Invalid request payload — permanent failure
      console.error(`[Worker] ❌ Invalid request (400): ${responseText}`);
      queries.updateJobStatus.run('failed', null, `Invalid request (400): ${responseText}`, 0, job.attempts + 1, Date.now(), job.id);
    } else {
      // Unexpected status code
      const nextAttempt = job.attempts + 1;
      const backoffMs = Math.min(30000, Math.pow(2, nextAttempt) * 1000);
      console.warn(`[Worker] ⚠️ Unexpected status ${res.status}: ${responseText}. Retrying in ${backoffMs}ms...`);
      queries.updateJobStatus.run(
        'queued',
        null,
        `Unexpected HTTP ${res.status}`,
        Date.now() + backoffMs,
        nextAttempt,
        Date.now(),
        job.id
      );
    }
  } catch (err) {
    // Network error / timeout
    const nextAttempt = job.attempts + 1;
    const backoffMs = Math.min(30000, Math.pow(2, nextAttempt) * 1000);
    console.error(`[Worker] ⚠️ Network exception during DM send: ${err.message}. Retrying in ${backoffMs}ms...`);
    queries.updateJobStatus.run(
      'queued',
      null,
      `Network Error: ${err.message}`,
      Date.now() + backoffMs,
      nextAttempt,
      Date.now(),
      job.id
    );
  }

  // Schedule next iteration
  dispatchTimer = setTimeout(processLoop, 50);
}

function processLoop() {
  processNextJob().catch((err) => {
    console.error('[Worker] Unhandled error in processLoop:', err);
    dispatchTimer = setTimeout(processLoop, 1000);
  });
}

/**
 * Polling Reconciler: Checks delivery status for accepted DMs via GET /v1/dm/{dm_id}
 * (Reads do NOT count against the rate limit)
 */
async function reconcileAcceptedDMs() {
  if (!isRunning) return;

  try {
    const jobs = queries.getJobsAwaitingReconciliation.all();

    for (const job of jobs) {
      if (!job.dm_id) continue;

      const url = `${config.baseUrl}/v1/dm/${job.dm_id}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'X-API-Key': config.apiKey },
      });

      if (!res.ok) {
        console.warn(`[Reconciler] Failed to fetch DM status for ${job.dm_id}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const status = data.status; // 'queued' | 'delivered' | 'failed'

      if (status === 'delivered') {
        console.log(`[Reconciler] 🎯 DM confirmed delivered: dm_id=${job.dm_id} (job ${job.id})`);
        queries.updateJobStatus.run('delivered', job.dm_id, null, 0, job.attempts, Date.now(), job.id);
      } else if (status === 'failed') {
        // Mock API asynchronous failure (~15% of accepted DMs fail)
        const nextAttempt = job.attempts + 1;
        if (nextAttempt >= job.max_attempts) {
          console.error(`[Reconciler] ❌ DM ${job.dm_id} asynchronously failed on mock API (max retries reached).`);
          queries.updateJobStatus.run('failed', job.dm_id, 'Async delivery failed (max retries)', 0, nextAttempt, Date.now(), job.id);
        } else {
          console.warn(`[Reconciler] ⚠️ DM ${job.dm_id} failed on mock API. Requeuing retry ${nextAttempt}/${job.max_attempts}...`);
          queries.updateJobStatus.run(
            'queued',
            null, // clear dm_id for new attempt
            `Async delivery failed (retrying ${nextAttempt})`,
            Date.now() + 2000,
            nextAttempt,
            Date.now(),
            job.id
          );
        }
      }
    }
  } catch (err) {
    console.error('[Reconciler] Error during reconciliation:', err.message);
  } finally {
    if (isRunning) {
      reconcilerTimer = setTimeout(reconcileAcceptedDMs, config.statusReconciliationIntervalMs);
    }
  }
}

export function startWorker() {
  if (isRunning) return;
  isRunning = true;
  console.log('[Worker] Background DM queue worker & reconciler started.');
  processLoop();
  reconcilerTimer = setTimeout(reconcileAcceptedDMs, 2000);
}

export function stopWorker() {
  isRunning = false;
  if (dispatchTimer) clearTimeout(dispatchTimer);
  if (reconcilerTimer) clearTimeout(reconcilerTimer);
  console.log('[Worker] Stopped background worker.');
}
