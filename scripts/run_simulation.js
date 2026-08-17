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

  const webhookUrl =
    process.argv[2] ||
    (await prompt('Enter your public webhook URL (e.g. https://your-domain.ngrok-free.app/webhook): '));

  const count = parseInt(process.argv[3] || (await prompt('Number of events to simulate (e.g. 50 or 500) [50]: ')) || '50', 10);
  const duration = parseInt(process.argv[4] || (await prompt('Duration in seconds [10]: ')) || '10', 10);

  if (!webhookUrl) {
    console.error('Error: Webhook URL is required.');
    process.exit(1);
  }

  console.log(`\n🚀 Starting simulation with ${count} events over ${duration}s to: ${webhookUrl}`);

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
    console.log('\nFetching truth data...');

    // Wait for simulation duration + extra buffer
    console.log(`Waiting ${duration + 5} seconds for simulation events to stream...`);
    await new Promise((r) => setTimeout(r, (duration + 5) * 1000));

    const truthRes = await fetch(`${BASE_URL}/v1/simulate/${data.run_id}/truth`, {
      headers: { 'X-API-Key': API_KEY },
    });

    if (truthRes.ok) {
      const truthData = await truthRes.json();
      console.log('\n📊 Truth Data Summary:');
      console.log(JSON.stringify(truthData, null, 2));
    } else {
      console.warn('Could not fetch truth data yet:', await truthRes.text());
    }
  } catch (err) {
    console.error('Error running simulation:', err.message);
  }
}

main();
