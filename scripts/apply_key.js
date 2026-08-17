import fs from 'fs';
import path from 'path';
import readline from 'readline';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.PSEUDOGRAM_BASE_URL || 'https://pseudogram-api.onrender.com';

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
  console.log('=== PseudoGram Mock API Key Generator ===\n');

  // Check if args provided or prompt interactively
  const name = process.argv[2] || (await prompt('Enter your full name: '));
  const email = process.argv[3] || (await prompt('Enter your email: '));
  const phone = process.argv[4] || (await prompt('Enter your phone number (e.g. +919876543210): '));
  const whatsapp = process.argv[5] || phone;
  const linkedin_url = process.argv[6] || (await prompt('Enter your LinkedIn profile URL: '));

  if (!name || !email || !phone || !linkedin_url) {
    console.error('\nError: Name, email, phone, and LinkedIn URL are required.');
    process.exit(1);
  }

  console.log('\n1. Submitting application to', `${BASE_URL}/v1/apply ...`);
  try {
    const applyRes = await fetch(`${BASE_URL}/v1/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, phone, whatsapp, linkedin_url }),
    });

    const applyData = await applyRes.text();
    console.log(`Apply status: ${applyRes.status} - ${applyData}`);

    console.log('\n2. Requesting API key from', `${BASE_URL}/v1/keygen ...`);
    const keyRes = await fetch(`${BASE_URL}/v1/keygen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    if (!keyRes.ok) {
      const errorText = await keyRes.text();
      console.error(`Failed to get API key (${keyRes.status}): ${errorText}`);
      process.exit(1);
    }

    const keyData = await keyRes.json();
    console.log('\n✅ Successfully obtained API key:');
    console.log(`Email:   ${keyData.email}`);
    console.log(`API Key: ${keyData.api_key}`);

    // Update .env file
    const envPath = path.resolve(process.cwd(), '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    if (envContent.includes('PSEUDOGRAM_API_KEY=')) {
      envContent = envContent.replace(
        /PSEUDOGRAM_API_KEY=.*/,
        `PSEUDOGRAM_API_KEY=${keyData.api_key}`
      );
    } else {
      envContent += `\nPSEUDOGRAM_API_KEY=${keyData.api_key}\n`;
    }

    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('✅ Updated .env file with PSEUDOGRAM_API_KEY!');
  } catch (err) {
    console.error('Error during key generation:', err.message);
    process.exit(1);
  }
}

main();
