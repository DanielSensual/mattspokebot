#!/usr/bin/env node

/**
 * CLI — Add a product to the Pokemon Center bot watchlist.
 *
 * Usage:
 *   node scripts/add-product.js <url> <name> [max_price]
 *
 * Example:
 *   node scripts/add-product.js "https://www.pokemoncenter.com/product/123" "Charizard EX Box" 49.99
 */

import { addProduct } from '../src/db.js';

const VALID_PREFIX = 'https://www.pokemoncenter.com';

function printUsage() {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║            Pokemon Center Bot — Add Product              ║
╠══════════════════════════════════════════════════════════╣
║  Usage:                                                  ║
║    node scripts/add-product.js <url> <name> [max_price]  ║
║                                                          ║
║  Example:                                                ║
║    node scripts/add-product.js \\                         ║
║      "https://www.pokemoncenter.com/product/123" \\       ║
║      "Charizard EX Box" 49.99                            ║
║                                                          ║
║  Arguments:                                              ║
║    url        Full pokemoncenter.com product URL          ║
║    name       Product name (use quotes for spaces)       ║
║    max_price  Max auto-buy price (default: 999.99)       ║
╚══════════════════════════════════════════════════════════╝
`);
}

function main() {
    const args = process.argv.slice(2);

    if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
        printUsage();
        process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
    }

    const [url, name, maxPriceStr] = args;

    // Validate URL
    if (!url.startsWith(VALID_PREFIX)) {
        console.error(`\n❌ Invalid URL. Must start with ${VALID_PREFIX}`);
        console.error(`   Got: ${url}\n`);
        process.exit(1);
    }

    // Parse max price
    let maxPrice = 999.99;
    if (maxPriceStr != null) {
        maxPrice = parseFloat(maxPriceStr);
        if (Number.isNaN(maxPrice) || maxPrice <= 0) {
            console.error(`\n❌ Invalid max_price: "${maxPriceStr}". Must be a positive number.\n`);
            process.exit(1);
        }
    }

    try {
        const product = addProduct(url, name, maxPrice);

        console.log(`
✅ Product added to watchlist!

   ID:        ${product.id}
   Name:      ${product.name}
   URL:       ${product.url}
   Max Price: $${product.max_price.toFixed(2)}
`);
    } catch (err) {
        console.error(`\n❌ Failed to add product: ${err.message}\n`);
        process.exit(1);
    }
}

main();
