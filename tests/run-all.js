#!/usr/bin/env node
// Runs every flow test in tests/flows/ against a single local static server,
// serially (they share app/localStorage patterns, so isolation comes from
// each test using its own browser context, not from parallelism). Exits
// non-zero if any flow fails, so this is CI-ready once CI exists.
const path = require('path');
const fs = require('fs');
const server = require('./lib/server');

const PORT = Number(process.env.BOARDWALK_TEST_PORT) || 8901;
const FLOWS_DIR = path.join(__dirname, 'flows');

async function main() {
  const flowFiles = fs.readdirSync(FLOWS_DIR).filter(f => f.endsWith('.test.js')).sort();
  if (!flowFiles.length) {
    console.error('No flow test files found in tests/flows/');
    process.exit(1);
  }

  console.log(`Starting local server on http://127.0.0.1:${PORT} ...`);
  const httpServer = await server.start(PORT);
  const baseUrl = `http://127.0.0.1:${PORT}`;

  const results = [];
  try {
    for (const file of flowFiles) {
      const flow = require(path.join(FLOWS_DIR, file));
      console.log(`\n=== ${file} ===`);
      const result = await flow.run(baseUrl);
      results.push(result);
      console.log(`--- ${result.label}: ${result.passed}/${result.total} passed ---`);
    }
  } finally {
    await new Promise(resolve => httpServer.close(resolve));
  }

  console.log('\n=== SUITE SUMMARY ===');
  let allOk = true;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}  (${r.passed}/${r.total})`);
    if (!r.ok) {
      allOk = false;
      r.checks.filter(c => !c.ok).forEach(c => console.log(`    ✗ ${c.name}`));
    }
  }

  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
