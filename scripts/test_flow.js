import assert from 'assert';

const BASE_URL = 'http://localhost:3000';

async function runTests() {
  console.log('🧪 Starting Part A Integration Test Suite...\n');

  // 1. Health check
  console.log('1. Testing GET / healthcheck...');
  const healthRes = await fetch(`${BASE_URL}/`);
  assert.strictEqual(healthRes.status, 200, 'Health check should return 200');
  console.log('   ✅ Health check passed.');

  // 2. Create Rule
  console.log('\n2. Testing POST /rules...');
  const rulePayload = {
    keyword: 'PRICE',
    dm_message: "Here's our full pricing guide: https://example.com/pricing",
  };

  const ruleRes = await fetch(`${BASE_URL}/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rulePayload),
  });

  assert.strictEqual(ruleRes.status, 201, 'POST /rules should return 201 Created');
  const ruleData = await ruleRes.json();
  assert.ok(ruleData.rule_id, 'Response should contain rule_id');
  assert.strictEqual(ruleData.keyword, 'PRICE');
  console.log(`   ✅ Rule created: ${ruleData.rule_id} (keyword: ${ruleData.keyword})`);

  // 3. Test Webhook with matching comment
  console.log('\n3. Testing POST /webhook with matching comment ("PRICE please")...');
  const event1 = {
    event_id: 'evt_test_001',
    event_type: 'comment.created',
    sent_at: new Date().toISOString(),
    data: {
      comment_id: 'cmt_test_001',
      post_id: 'post_100',
      text: 'Can you send the PRICE please?',
      created_at: new Date().toISOString(),
      from: {
        user_id: 'usr_alice_1',
        username: 'alice.tester',
      },
    },
  };

  const hookRes1 = await fetch(`${BASE_URL}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event1),
  });

  assert.strictEqual(hookRes1.status, 200, 'POST /webhook must return 200 within 5 seconds');
  console.log('   ✅ Webhook returned 200 immediately.');

  // Wait a moment for background processing
  await new Promise((r) => setTimeout(r, 200));

  // 4. Test Webhook Deduplication: Same user comments again with PRICE
  console.log('\n4. Testing Deduplication: Same user commenting "PRICE" on another post...');
  const event2 = {
    event_id: 'evt_test_002',
    event_type: 'comment.created',
    sent_at: new Date().toISOString(),
    data: {
      comment_id: 'cmt_test_002',
      post_id: 'post_101',
      text: 'PRICE info again',
      created_at: new Date().toISOString(),
      from: {
        user_id: 'usr_alice_1', // same user!
        username: 'alice.tester',
      },
    },
  };

  const hookRes2 = await fetch(`${BASE_URL}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event2),
  });
  assert.strictEqual(hookRes2.status, 200);

  // 5. Test Redelivery Deduplication: Same event_id arriving again
  console.log('\n5. Testing Webhook Redelivery Deduplication: Redelivering evt_test_001...');
  const hookRes3 = await fetch(`${BASE_URL}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event1),
  });
  assert.strictEqual(hookRes3.status, 200);

  // Wait for background tasks
  await new Promise((r) => setTimeout(r, 500));

  // 6. Test GET /stats
  console.log('\n6. Testing GET /stats...');
  const statsRes = await fetch(`${BASE_URL}/stats`);
  assert.strictEqual(statsRes.status, 200);
  const stats = await statsRes.json();
  console.log('   Stats response:', JSON.stringify(stats, null, 2));

  assert.ok(typeof stats.sent === 'number', 'stats.sent must be a number');
  assert.ok(typeof stats.failed === 'number', 'stats.failed must be a number');
  assert.ok(typeof stats.queued === 'number', 'stats.queued must be a number');
  assert.ok(typeof stats.duplicates_blocked === 'number', 'stats.duplicates_blocked must be a number');
  assert.ok(stats.duplicates_blocked >= 2, 'Should have blocked at least 2 duplicates (user duplicate + event duplicate)');

  console.log('\n🎉 ALL PART A INTEGRATION TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
