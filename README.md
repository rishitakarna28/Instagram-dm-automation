# LinkPlease Instagram Comment-to-DM Automation

A backend service that automatically sends a direct message to users when their Instagram-style comments match configured keywords.

This project was built as part of the LinkPlease technical assignment using the provided PseudoGram mock API.

## Tech Stack

* **Node.js** — Backend runtime
* **Express.js** — REST API and webhook server
* **SQLite** — Persistent application storage
* **Background Worker** — Asynchronous DM processing
* **PseudoGram API** — Mock Instagram API provided for the assignment

---

## How It Works

The application follows this flow:

```text
User creates a keyword rule
        ↓
POST /rules
        ↓
Rule stored in SQLite
        ↓
PseudoGram sends a comment event
        ↓
POST /webhook
        ↓
Webhook acknowledges the event quickly
        ↓
Event is processed in the background
        ↓
Comment is matched against configured rules
        ↓
Duplicate user/rule check
        ↓
DM job is added to the queue
        ↓
Background worker sends the DM
        ↓
Delivery status is tracked
        ↓
GET /stats
```

For example, a creator can create the following rule:

```json
{
  "keyword": "PRICE",
  "dm_message": "Here's the price list!"
}
```

If a user comments:

```text
Can you send me the PRICE?
```

the keyword matches and the system creates a DM job for that user.

Keyword matching is case-insensitive and can occur anywhere in the comment text.

---

## Core API Endpoints

### 1. Create a Rule

```http
POST /rules
```

Request:

```json
{
  "keyword": "PRICE",
  "dm_message": "Here's the price list!"
}
```

Response:

```json
{
  "rule_id": "rule-id",
  "keyword": "PRICE",
  "dm_message": "Here's the price list!"
}
```

Rules are stored persistently in SQLite.

---

### 2. Receive Comment Webhooks

```http
POST /webhook
```

The endpoint receives comment events from the PseudoGram API.

The webhook acknowledges the request quickly and processes the event asynchronously rather than making the webhook wait for the external DM API.

The system handles:

* `comment.created` events
* repeated event IDs
* case-insensitive keyword matching
* user-based duplicate prevention
* asynchronous DM processing

---

### 3. View Statistics

```http
GET /stats
```

Example response:

```json
{
  "sent": 10,
  "failed": 1,
  "queued": 2,
  "duplicates_blocked": 5
}
```

The statistics represent:

* **sent** — DMs confirmed as delivered
* **failed** — DMs that ultimately failed after processing/retries
* **queued** — DM jobs waiting to be processed or retried
* **duplicates_blocked** — DM attempts correctly prevented because the user had already been processed for that rule

---

## Duplicate Prevention

A key requirement of the assignment is that the same user must not receive the same rule's DM more than once.

The application uses the PseudoGram `user_id` as the user's identity rather than the username.

The database maintains a user-rule relationship so that:

```text
User + Rule
```

can only be processed once.

For example:

```text
User: usr_123
Rule: PRICE
```

After the first successful processing, another `PRICE` comment from the same user will be blocked from generating another DM for that rule.

This also protects against repeated comments and redelivered webhook events.

---

## Background Processing

DM sending is handled by a background worker.

This separates webhook reception from communication with the external PseudoGram API.

The basic flow is:

```text
Webhook
   ↓
Validate/process event
   ↓
Create DM job
   ↓
Background worker
   ↓
PseudoGram DM API
```

This prevents the webhook endpoint from unnecessarily waiting for external API operations.

---

## Handling External API Failures

The PseudoGram API can return temporary failures and rate-limit responses.

The worker handles temporary failures through retries.

### HTTP 500

A temporary server error is retried.

### HTTP 429

When the API rate limit is reached, the worker respects the `Retry-After` information and delays the next attempt.

### HTTP 400

A malformed request is treated as a terminal failure because retrying the same invalid request will not fix it.

### DM Delivery Status

A successful `202 Accepted` response from the PseudoGram API means that the DM was accepted for processing, not necessarily that it was delivered.

The application therefore tracks the returned DM ID and checks its eventual delivery status.

---

## Database

SQLite is used for persistent storage.

The database stores application state such as:

* keyword rules
* received events
* user/rule delivery information
* DM jobs
* delivery status
* duplicate-block information

SQLite was chosen to keep the assignment implementation simple while still providing persistent storage and transactional database operations.

---

## Project Structure

```text
.
├── src/
│   ├── server.js
│   ├── db.js
│   ├── worker.js
│   └── config.js
│
├── scripts/
│   ├── test_flow.js
│   ├── run_simulation.js
│   ├── reset_db.js
│   └── apply_key.js
│
├── FAILURES.md
├── package.json
└── README.md
```

### Important Files

**`src/server.js`**

Contains the Express server and API endpoints such as `/rules`, `/webhook`, and `/stats`.

**`src/db.js`**

Handles SQLite database initialization and database operations.

**`src/worker.js`**

Processes queued DM jobs, communicates with the PseudoGram API, handles retries, and tracks delivery status.

**`src/config.js`**

Contains application configuration.

**`FAILURES.md`**

Documents known limitations and failure scenarios of the implementation.

---

## Running Locally

### Install dependencies

```bash
npm install
```

### Configure environment variables

Create a `.env` file and provide the required PseudoGram configuration/API key.

Example:

```env
PSEUDOGRAM_API_KEY=your_api_key
```

Do not commit the `.env` file or API keys to the repository.

### Start the application

```bash
npm start
```

The server will start on the configured port.

---

## Testing

The project includes scripts for testing the application flow and running simulations against the PseudoGram API.

The PseudoGram simulation can be used to send a large number of comment events to the deployed webhook endpoint.

A typical test flow is:

```text
Create rule
    ↓
Send/simulate comments
    ↓
Webhook receives events
    ↓
Rules are matched
    ↓
DM jobs are processed
    ↓
Delivery status is checked
    ↓
GET /stats
```

The statistics can then be compared against the expected simulation results.

---

## Known Limitations

Known failure cases and limitations are documented in [`FAILURES.md`](FAILURES.md).

Some examples include:

* A process crash during the small window between webhook acknowledgement and event persistence.
* Limitations when running multiple application instances without shared coordination.
* Out-of-order `comment.deleted` events.
* Permanent failures caused by malformed requests.

These limitations are documented intentionally rather than claiming that the system handles every possible failure scenario.

---

## Deployment

The backend is deployed and exposes the required API endpoints:

```text
POST /rules
POST /webhook
GET  /stats
```

The deployed application is intended to remain available for the duration required by the assignment.

---

## Assignment Scope

This implementation focuses on **Part A** of the assignment:

* Create keyword-based rules
* Match incoming comments against rules
* Prevent duplicate DMs for the same user and rule
* Process DM jobs asynchronously
* Handle temporary API failures and retries
* Track DM delivery and statistics

The implementation also includes additional delivery-status handling beyond the minimum Part A requirements.

The submitted scope is **Part A**.
