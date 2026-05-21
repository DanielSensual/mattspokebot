/**
 * Matt's Pokemon Center Bot — Main Entry Point
 * Monitors Pokemon Center for target product restocks
 * and auto-purchases using store credits.
 */

import dotenv from 'dotenv';
import { config } from './config.js';
import { log } from './logger.js';
import { getDb } from './db.js';
import { startMonitorLoop } from './monitor.js';
import { loadCookies, validateSession } from './session.js';
import { sendAlert } from './alerts.js';

dotenv.config();

// ── Graceful Shutdown ────────────────────────────────────────
let shuttingDown = false;

function setupGracefulShutdown() {
    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => {
            if (shuttingDown) return;
            shuttingDown = true;
            log.warn(`Received ${signal}, shutting down...`, { signal });
            setTimeout(() => process.exit(0), 5000);
        });
    }
}

export function isShuttingDown() {
    return shuttingDown;
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
    setupGracefulShutdown();

    console.log('');
    console.log('⚡ ═══════════════════════════════════════════');
    console.log('   P O K E M O N   C E N T E R   B O T');
    console.log('   Restock Monitor + Auto-Purchase v1.0');
    console.log('═══════════════════════════════════════════════');
    console.log('');

    if (config.dryRun) {
        log.warn('🔒 DRY RUN MODE — will not place orders');
    }

    // Initialize database
    const db = getDb();
    log.info('Database initialized');

    // Check watchlist
    const products = db.prepare(
        "SELECT * FROM watchlist WHERE enabled = 1"
    ).all();

    const pausedCount = db.prepare(
        "SELECT COUNT(*) as c FROM monitor_state WHERE paused = 1"
    ).get()?.c || 0;

    log.info('Watchlist loaded', {
        total: products.length,
        paused: pausedCount,
    });

    if (products.length === 0) {
        log.warn('⚠️  No products in watchlist! Add products with:');
        log.warn('   npm run product:add <url> <name> [max_price]');
        log.warn('   Bot will idle until products are added.');
    }

    // Validate session
    console.log('\n🔐 Checking session...');
    try {
        const cookies = await loadCookies();
        if (cookies && cookies.length > 0) {
            const valid = await validateSession(cookies);
            if (valid) {
                log.info('✅ Session valid — authenticated with Pokemon Center');
            } else {
                log.warn('⚠️  Session expired — checkout will fail until re-authenticated');
                await sendAlert('session_expired', {
                    message: 'Pokemon Center session has expired. Re-export cookies to continue auto-purchasing.',
                });
            }
        } else {
            log.warn('⚠️  No session cookies found — set POKEMON_CENTER_COOKIES in .env');
            log.warn('   or run: npm run cookies:export <cookies.json>');
        }
    } catch (err) {
        log.error('Session validation failed', { error: err.message });
    }

    // Print status
    console.log('');
    console.log(`📋 Watchlist: ${products.length} product(s)`);
    for (const p of products) {
        console.log(`   → ${p.name} (max $${p.max_price})`);
        console.log(`     ${p.url}`);
    }
    console.log('');
    console.log(`⏱️  Poll interval: ${config.pollIntervalMs / 1000}s (±${config.pollJitterMs / 1000}s jitter)`);
    console.log(`💰 Max purchase: $${config.maxPurchaseAmount}`);
    console.log(`💳 Store credits: ${config.useStoreCredits ? 'ON' : 'OFF'}`);
    if (config.proxyUrl) console.log(`🔀 Proxy: active`);
    if (config.discord.webhookUrl) console.log(`📢 Discord alerts: ON`);
    if (config.twilio.accountSid) console.log(`📱 SMS alerts: ON`);
    console.log('');

    // Start the monitor loop
    log.info('🚀 Starting stock monitor...');
    await startMonitorLoop(db);
}

main().catch((error) => {
    log.error('Fatal error', { error: error.message, stack: error.stack });
    process.exit(1);
});
