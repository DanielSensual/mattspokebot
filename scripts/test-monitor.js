#!/usr/bin/env node

/**
 * CLI — Test the stock monitor against a single URL or the full watchlist.
 *
 * Usage:
 *   node scripts/test-monitor.js [url]
 *
 * If no URL is provided, checks every active product in the watchlist.
 */

import { getActiveProducts } from '../src/db.js';

const VALID_PREFIX = 'https://www.pokemoncenter.com';

function printUsage() {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║          Pokemon Center Bot — Test Monitor                ║
╠══════════════════════════════════════════════════════════╣
║  Usage:                                                  ║
║    node scripts/test-monitor.js [url]                    ║
║                                                          ║
║  If no URL given, checks all active watchlist products.  ║
╚══════════════════════════════════════════════════════════╝
`);
}

/**
 * Pretty-print a single stock check result.
 * @param {string} url
 * @param {object} result
 */
function printResult(url, result) {
    const statusIcon = result.inStock ? '🟢 IN STOCK' : '🔴 Out of Stock';

    console.log(`
┌──────────────────────────────────────────────────────────┐
│ ${statusIcon.padEnd(56)} │
├──────────────────────────────────────────────────────────┤`);

    if (result.title) {
        console.log(`│  Title: ${result.title.slice(0, 48).padEnd(48)} │`);
    }
    if (result.price != null) {
        console.log(`│  Price: $${Number(result.price).toFixed(2).padEnd(47)} │`);
    }
    console.log(`│  URL:   ${url.slice(0, 48).padEnd(48)} │`);

    if (result.error) {
        console.log(`│  Error: ${result.error.slice(0, 48).padEnd(48)} │`);
    }

    console.log(`└──────────────────────────────────────────────────────────┘`);
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printUsage();
        process.exit(0);
    }

    // Lazy-import checkStock to surface import errors clearly
    let checkStock;
    try {
        const monitor = await import('../src/monitor.js');
        checkStock = monitor.checkStock;
        if (typeof checkStock !== 'function') {
            throw new Error('checkStock is not exported from src/monitor.js');
        }
    } catch (err) {
        console.error(`\n❌ Failed to import src/monitor.js: ${err.message}`);
        console.error('   Make sure the monitor module exists and exports checkStock().\n');
        process.exit(1);
    }

    /** @type {Array<{ url: string, name?: string }>} */
    let targets = [];

    if (args.length > 0) {
        const url = args[0];
        if (!url.startsWith(VALID_PREFIX)) {
            console.error(`\n❌ Invalid URL. Must start with ${VALID_PREFIX}`);
            console.error(`   Got: ${url}\n`);
            process.exit(1);
        }
        targets.push({ url, name: url });
    } else {
        // Check all active watchlist products
        try {
            const products = getActiveProducts();
            if (products.length === 0) {
                console.log('\n⚠️  No active products in watchlist. Add one first:');
                console.log('   node scripts/add-product.js <url> <name> [max_price]\n');
                process.exit(0);
            }
            targets = products.map((p) => ({ url: p.url, name: p.name }));
            console.log(`\n📋 Checking ${targets.length} active watchlist product(s)...\n`);
        } catch (err) {
            console.error(`\n❌ Failed to load watchlist: ${err.message}\n`);
            process.exit(1);
        }
    }

    let hasErrors = false;

    for (const target of targets) {
        console.log(`\n🔍 Checking: ${target.name || target.url}`);

        try {
            const result = await checkStock(target.url);
            printResult(target.url, result);
        } catch (err) {
            console.error(`\n❌ Error checking ${target.url}: ${err.message}`);
            hasErrors = true;
        }
    }

    process.exit(hasErrors ? 1 : 0);
}

main();
