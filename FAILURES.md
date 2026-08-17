# FAILURES.md — System Edge Cases & Failure Modes

### 1. Webhook Accepted but Process Crashes Before SQLite Transaction
- **Condition:** An incoming webhook hits `POST /webhook`, returns `200 OK` immediately, but the server crashes (e.g., SIGKILL or out-of-memory) during the few milliseconds before the async event loop writes the event to SQLite.
- **Impact:** That specific comment event is lost and no DM will be queued.
- **Why it exists:** We prioritize returning `200 OK` to the webhook caller within the 5-second SLA. Without a persistent write-ahead ingestion buffer (like Redis Streams or Kafka), any in-memory event between HTTP response and DB insert is vulnerable to abrupt process death.

---

### 2. Multi-Instance Deployments Sharing No Distributed Lock
- **Condition:** If the application is scaled horizontally across multiple instances (e.g., 2+ containers on Render/Railway) without a shared database or distributed Redis lock.
- **Impact:** 
  1. Each instance maintains its own local SQLite file and rate limiter.
  2. If instance A receives an event for user `usr_123` and instance B receives another event for `usr_123` at the same moment, both instances will think it is the user's first time and both will dispatch a DM.
  3. The collective dispatch rate will exceed the 10 requests / 60 seconds limit, causing HTTP 429 rate limit errors.
- **Why it exists:** SQLite is embedded single-process. In production, a shared PostgreSQL database with `SELECT ... FOR UPDATE` and a distributed token bucket (Redis) is required for multi-replica safety.

---

### 3. Out-of-Order `comment.deleted` Arriving After DM Dispatched
- **Condition:** A user comments, our worker immediately dispatches the DM to the mock API, and 500ms later the `comment.deleted` event arrives at `/webhook`.
- **Impact:** The DM is already sent/accepted by Instagram and cannot be recalled.
- **Why it exists:** Network latency and out-of-order delivery mean there is no way to anticipate a future deletion once an HTTP request has been acknowledged by the platform API.

---

### 4. Terminal `400 Invalid Request` Responses
- **Condition:** If the mock API responds with HTTP 400 (`invalid_request`), our system categorizes this as non-retryable and marks the job as `failed`.
- **Impact:** If the 400 error was caused by an edge case bug in message formatting or unsupported emojis/characters, that DM is marked permanently failed and will not be re-attempted.

---

