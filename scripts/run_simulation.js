import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

const BASE_URL = process.env.PSEUDOGRAM_BASE_URL || 'https://pseudogram-api.onrender.com';
const API_KEY = process.env.PSEUDOGRAM_API_KEY;

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('=== Mock Instagram Platform Simulation Runner ===\n');

  if (!API_KEY) {
    console.error('Error: PSEUDOGRAM_API_KEY is not set in .env. Run `npm run apply` first.');
    process.exit(1);
  }

  let webhookUrl =
    process.argv[2] ||
    (await prompt('Enter your deployed URL (e.g. https://instagram-dm-automation-ty32.onrender.com): '));

  if (!webhookUrl) {
    console.error('Error: URL is required.');
    process.exit(1);
  }

  // Auto-clean URL and ensure it points to /webhook
  webhookUrl = webhookUrl.replace(/\/+$/, '');
  if (!webhookUrl.endsWith('/webhook')) {
    webhookUrl += '/webhook';
  }

  const baseUrl = webhookUrl.replace(/\/webhook$/, '');
  const count = parseInt(process.argv[3] || (await prompt('Number of events to simulate (e.g. 50 or 500) [50]: ')) || '50', 10);
  const duration = parseInt(process.argv[4] || (await prompt('Duration in seconds [10]: ')) || '10', 10);

  console.log(`\n🚀 Starting simulation with ${count} events over ${duration}s to:\n   👉 ${webhookUrl}`);

  try {
    const res = await fetch(`${BASE_URL}/v1/simulate/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify({
        webhook_url: webhookUrl,
        count,
        duration_seconds: duration,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Simulation failed (${res.status}):`, errText);
      process.exit(1);
    }

    const data = await res.json();
    console.log('\n✅ Simulation started successfully!');
    console.log('Run ID:', data.run_id);
    console.log(`\nStreaming ${count} events... Waiting for simulation to finish...`);

    // Poll truth endpoint until status === "complete"
    let truthData = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const truthRes = await fetch(`${BASE_URL}/v1/simulate/${data.run_id}/truth`, {
        headers: { 'X-API-Key': API_KEY },
      });

      if (truthRes.ok) {
        truthData = await truthRes.json();
        if (truthData.status === 'complete') {
          break;
        }
      }
    }

    console.log('\n========================================');
    console.log('📊 SIMULATION TRUTH REPORT');
    console.log('========================================');
    console.log(`Total Events Sent by Mock API:   ${truthData?.total_events_generated || count}`);
    console.log(`Webhook Deliveries (inc. retries): ${truthData?.total_deliveries_attempted || '—'}`);
    console.log(`Webhook 200 OK Received by Mock:  ${truthData?.webhook_200_count || 0}`);
    console.log(`Expected Unique Matching Users:   ${truthData?.expected_unique_recipient_count || 0}`);

    // Fetch live stats from deployed app
    try {
      const statsRes = await fetch(`${baseUrl}/stats`);
      if (statsRes.ok) {
        const liveStats = await statsRes.json();
        console.log('\n📈 YOUR LIVE /stats COUNTERS ON RENDER:');
        console.log(JSON.stringify(liveStats, null, 2));
      }
    } catch {
      // ignore
    }

    console.log('\n✅ Simulation verification complete!');
  } catch (err) {
    console.error('Error running simulation:', err.message);
  }
}

main();
