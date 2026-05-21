#!/usr/bin/env node

/**
 * CLI — Export / import browser cookies for the Pokemon Center bot session.
 *
 * Usage:
 *   node scripts/export-cookies.js                  # Print instructions
 *   node scripts/export-cookies.js <cookies.json>   # Import cookies file
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getDb } from '../src/db.js';
import { log } from '../src/logger.js';

const PC_DOMAIN = 'pokemoncenter.com';

function printInstructions() {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║          Pokemon Center Bot — Cookie Export Guide             ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Step 1: Install a cookie-export extension in Chrome         ║
║    • "EditThisCookie" or "Cookie-Editor" from the Web Store  ║
║    • Or use the built-in DevTools Application → Cookies tab  ║
║                                                              ║
║  Step 2: Log in to pokemoncenter.com                         ║
║    • Sign in with your account                               ║
║    • Complete any verification steps                         ║
║                                                              ║
║  Step 3: Export cookies as JSON                              ║
║    • Click the cookie extension → Export → JSON              ║
║    • Save the JSON file (e.g., cookies.json)                 ║
║                                                              ║
║  Step 4: Import into the bot                                 ║
║    node scripts/export-cookies.js cookies.json               ║
║                                                              ║
║  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ║
║                                                              ║
║  Alternative: DevTools Console Method                        ║
║    1. Open DevTools (F12) on pokemoncenter.com               ║
║    2. Go to Application → Cookies                            ║
║    3. Right-click → Copy all as JSON                         ║
║    4. Paste into a file and run this script                   ║
║                                                              ║
║  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ║
║                                                              ║
║  The cookies JSON should be an array of objects like:        ║
║  [                                                           ║
║    {                                                         ║
║      "name": "session_id",                                   ║
║      "value": "abc123",                                      ║
║      "domain": ".pokemoncenter.com",                         ║
║      "path": "/",                                            ║
║      ...                                                     ║
║    }                                                         ║
║  ]                                                           ║
╚══════════════════════════════════════════════════════════════╝
`);
}

/**
 * Validate that the cookies array contains pokemoncenter.com cookies.
 * @param {unknown[]} cookies
 * @returns {{ valid: boolean, pcCount: number, totalCount: number }}
 */
function validateCookies(cookies) {
    if (!Array.isArray(cookies)) {
        return { valid: false, pcCount: 0, totalCount: 0 };
    }

    const pcCookies = cookies.filter((c) => {
        const domain = String(c?.domain || '');
        return domain.includes(PC_DOMAIN);
    });

    return {
        valid: pcCookies.length > 0,
        pcCount: pcCookies.length,
        totalCount: cookies.length,
    };
}

/**
 * Save cookies directly to the database session_state table.
 * Falls back to direct DB write if src/session.js doesn't exist yet.
 * @param {unknown[]} cookies
 */
async function saveCookiesToDb(cookies) {
    // Try using session module if it exists
    try {
        const session = await import('../src/session.js');
        if (typeof session.saveCookies === 'function') {
            await session.saveCookies(cookies);
            return;
        }
    } catch {
        // session.js doesn't exist yet — fall through to direct DB write
    }

    // Direct DB write fallback
    const db = getDb();
    const now = new Date().toISOString();
    const json = JSON.stringify(cookies);

    db.prepare(`
        INSERT INTO session_state (id, cookies_json, last_validated_at, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            cookies_json = excluded.cookies_json,
            updated_at = excluded.updated_at
    `).run(json, now, now);

    log.info('Cookies saved to database', { count: cookies.length });
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printInstructions();
        process.exit(0);
    }

    // No file arg — just show instructions
    if (args.length === 0) {
        printInstructions();
        process.exit(0);
    }

    const filePath = resolve(args[0]);

    // Read and parse the cookies file
    let raw;
    try {
        raw = await readFile(filePath, 'utf-8');
    } catch (err) {
        console.error(`\n❌ Could not read file: ${filePath}`);
        console.error(`   ${err.message}\n`);
        process.exit(1);
    }

    let cookies;
    try {
        cookies = JSON.parse(raw);
    } catch (err) {
        console.error(`\n❌ Invalid JSON in ${filePath}`);
        console.error(`   ${err.message}\n`);
        process.exit(1);
    }

    // Validate
    const { valid, pcCount, totalCount } = validateCookies(cookies);

    if (!valid) {
        console.error(`\n❌ No pokemoncenter.com cookies found in the file.`);
        console.error(`   Total cookies in file: ${totalCount}`);
        console.error(`   Make sure you export cookies while on pokemoncenter.com.\n`);
        process.exit(1);
    }

    // Filter to only PC cookies
    const pcCookies = cookies.filter((c) => String(c?.domain || '').includes(PC_DOMAIN));

    // Save to database
    try {
        await saveCookiesToDb(pcCookies);

        console.log(`
✅ Cookies imported successfully!

   File:             ${filePath}
   Total in file:    ${totalCount}
   PC cookies saved: ${pcCount}

   The bot will use these cookies for authenticated sessions.
   Run the monitor to verify: npm run monitor:test
`);
    } catch (err) {
        console.error(`\n❌ Failed to save cookies: ${err.message}\n`);
        process.exit(1);
    }
}

main();
