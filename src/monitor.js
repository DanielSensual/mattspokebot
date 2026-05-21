/**
 * Pokemon Center Bot — Stock Monitor
 *
 * Continuously polls product pages on pokemoncenter.com, detects restocks,
 * and dispatches checkout + alert workflows when availability is detected.
 */

import { config } from './config.js';
import { log } from './logger.js';
import { getStealthHeaders, randomDelay, jitterInterval, humanDelay } from './stealth.js';
import { getDb } from './db.js';

// ---------------------------------------------------------------------------
// Stock check — single product
// ---------------------------------------------------------------------------

/**
 * Fetches a Pokemon Center product page via `fetch()` with stealth headers
 * and determines stock status by inspecting the HTML for cart / sold-out
 * indicators.
 *
 * @param {string} productUrl  Full URL of the product page
 * @returns {Promise<{ inStock: boolean, title: string, price: string, url: string }>}
 */
export async function checkStock(productUrl) {
    const result = {
        inStock: false,
        title: '',
        price: '',
        url: productUrl,
    };

    try {
        const headers = getStealthHeaders();
        const res = await fetch(productUrl, { headers, redirect: 'follow' });

        // ----- Rate-limited or blocked -----
        if (res.status === 429) {
            log.warn('Rate-limited (429) while checking stock', { url: productUrl });
            return result;
        }
        if (res.status === 403) {
            log.warn('Forbidden (403) — possible bot detection', { url: productUrl });
            return result;
        }
        if (!res.ok) {
            log.warn('Unexpected HTTP status during stock check', {
                url: productUrl,
                status: res.status,
            });
            return result;
        }

        const html = await res.text();

        // ----- Parse title -----
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        result.title = titleMatch
            ? titleMatch[1].replace(/\s*\|.*$/, '').trim()
            : 'Unknown Product';

        // ----- Parse price -----
        const pricePatterns = [
            /data-testid="product-price"[^>]*>([^<]+)</i,
            /class="[^"]*price[^"]*"[^>]*>\s*\$?([\d,.]+)/i,
            /\$(\d+\.\d{2})/,
        ];
        for (const pattern of pricePatterns) {
            const m = html.match(pattern);
            if (m) {
                result.price = m[1].trim().startsWith('$') ? m[1].trim() : `$${m[1].trim()}`;
                break;
            }
        }

        // ----- Detect in-stock vs. out-of-stock -----
        const outOfStockIndicators = [
            /out\s*of\s*stock/i,
            /sold\s*out/i,
            /currently\s*unavailable/i,
            /not\s*available/i,
            /disabled[^>]*>.*add\s*to\s*cart/i,
        ];

        const inStockIndicators = [
            /data-testid="add-to-cart"/i,
            /class="[^"]*add-to-cart[^"]*"/i,
            />Add to Cart</i,
            /btn-add-to-cart/i,
        ];

        // Check out-of-stock first (takes priority)
        const isExplicitlyOOS = outOfStockIndicators.some((rx) => rx.test(html));

        if (isExplicitlyOOS) {
            result.inStock = false;
            log.debug('Product out of stock', { title: result.title, url: productUrl });
            return result;
        }

        // Check for add-to-cart presence
        const hasAddToCart = inStockIndicators.some((rx) => rx.test(html));

        if (hasAddToCart) {
            result.inStock = true;
            log.info('🟢 Product IN STOCK', { title: result.title, price: result.price, url: productUrl });
            return result;
        }

        // Ambiguous — could be a pre-order page or a weird layout.  Default to OOS.
        log.debug('Stock status ambiguous — defaulting to out-of-stock', {
            title: result.title,
            url: productUrl,
        });
        return result;
    } catch (err) {
        log.error('Stock check failed', { url: productUrl, error: err.message });
        return result;
    }
}

// ---------------------------------------------------------------------------
// Failure tracking helpers
// ---------------------------------------------------------------------------

/**
 * Increment the consecutive failure counter for a product in `monitor_state`.
 * @param {import('better-sqlite3').Database} db
 * @param {string} productUrl
 * @returns {number} Updated failure count
 */
function incrementFailures(db, productUrl) {
    db.prepare(`
        INSERT INTO monitor_state (url, consecutive_failures, updated_at)
        VALUES (?, 1, datetime('now'))
        ON CONFLICT(url) DO UPDATE
            SET consecutive_failures = consecutive_failures + 1,
                updated_at = datetime('now')
    `).run(productUrl);

    const row = db.prepare('SELECT consecutive_failures FROM monitor_state WHERE url = ?').get(productUrl);
    return row?.consecutive_failures ?? 1;
}

/**
 * Reset the failure counter to zero after a successful check.
 * @param {import('better-sqlite3').Database} db
 * @param {string} productUrl
 */
function resetFailures(db, productUrl) {
    db.prepare(`
        INSERT INTO monitor_state (url, consecutive_failures, updated_at)
        VALUES (?, 0, datetime('now'))
        ON CONFLICT(url) DO UPDATE
            SET consecutive_failures = 0,
                updated_at = datetime('now')
    `).run(productUrl);
}

/**
 * Mark a product as paused in the watchlist.
 * @param {import('better-sqlite3').Database} db
 * @param {string} productUrl
 */
function pauseProduct(db, productUrl) {
    db.prepare('UPDATE watchlist SET enabled = 0 WHERE url = ?').run(productUrl);
    log.warn('⏸  Product paused due to repeated failures', { url: productUrl });
}

// ---------------------------------------------------------------------------
// Monitor loop
// ---------------------------------------------------------------------------

/**
 * Starts the main monitoring loop.  This function runs **indefinitely**:
 *
 * 1. Fetches all enabled products from the `watchlist` table.
 * 2. Checks stock for each product (with human-like delays between requests).
 * 3. When a product is detected in stock, triggers checkout + alerts.
 * 4. Tracks consecutive failures and auto-pauses products that exceed
 *    `config.maxFailuresBeforePause`.
 * 5. Sleeps for `config.pollIntervalMs ± config.pollJitterMs` between cycles.
 *
 * @param {import('better-sqlite3').Database} [dbOverride] Optional database handle (uses getDb() by default)
 */
export async function startMonitorLoop(dbOverride) {
    const db = dbOverride ?? getDb();

    log.info('🚀 Monitor loop starting', {
        pollIntervalMs: config.pollIntervalMs,
        pollJitterMs: config.pollJitterMs,
        maxFailures: config.maxFailuresBeforePause,
        dryRun: config.dryRun,
    });

    // Lazy-loaded references to avoid circular deps at import time
    let attemptCheckout;
    let sendAlert;
    let sendCriticalAlert;

    while (true) {
        try {
            // ------ Fetch enabled products ------
            const products = db
                .prepare('SELECT url, name FROM watchlist WHERE enabled = 1')
                .all();

            if (products.length === 0) {
                log.info('Watchlist is empty — nothing to monitor. Sleeping…');
            } else {
                log.info(`Polling ${products.length} product(s)`);
            }

            // ------ Check each product sequentially ------
            for (const product of products) {
                try {
                    const stock = await checkStock(product.url);

                    if (stock.inStock) {
                        log.info('🎯 RESTOCK DETECTED — initiating checkout', {
                            title: stock.title,
                            price: stock.price,
                            url: stock.url,
                        });

                        resetFailures(db, product.url);

                        // Lazy-import checkout + alerts on first restock
                        if (!attemptCheckout) {
                            const checkoutMod = await import('./checkout.js');
                            attemptCheckout = checkoutMod.attemptCheckout;
                        }
                        if (!sendAlert) {
                            const alertsMod = await import('./alerts.js');
                            sendAlert = alertsMod.sendAlert;
                            sendCriticalAlert = alertsMod.sendCriticalAlert;
                        }

                        // Fire checkout + alert concurrently
                        const [checkoutResult] = await Promise.allSettled([
                            attemptCheckout({ url: stock.url, title: stock.title, price: stock.price }),
                            sendAlert({
                                type: 'restock',
                                title: stock.title,
                                price: stock.price,
                                url: stock.url,
                            }),
                        ]);

                        if (checkoutResult.status === 'fulfilled') {
                            const res = checkoutResult.value;
                            if (res.success) {
                                log.info('✅ Checkout completed', { orderId: res.orderId, dryRun: res.dryRun });

                                if (sendAlert) {
                                    await sendAlert({
                                        type: 'checkout_success',
                                        title: stock.title,
                                        price: stock.price,
                                        url: stock.url,
                                        orderId: res.orderId,
                                        dryRun: res.dryRun,
                                    }).catch(() => {}); // best-effort
                                }
                            } else {
                                log.error('❌ Checkout failed', { error: res.error });

                                if (res.error === 'CAPTCHA detected' && sendCriticalAlert) {
                                    await sendCriticalAlert({
                                        message: `⚠️ CAPTCHA detected on ${stock.title}. Manual intervention required.`,
                                        url: stock.url,
                                    }).catch(() => {});
                                }
                            }
                        } else {
                            log.error('Checkout promise rejected', {
                                reason: checkoutResult.reason?.message,
                            });
                        }
                    } else {
                        // Not in stock — may be a normal OOS or may be an error
                        if (stock.title) {
                            // We got a valid page, reset failures
                            resetFailures(db, product.url);
                        } else {
                            // Likely a fetch error or blocked response
                            const failures = incrementFailures(db, product.url);
                            log.warn('Stock check returned no data', {
                                url: product.url,
                                consecutiveFailures: failures,
                            });

                            if (failures >= config.maxFailuresBeforePause) {
                                pauseProduct(db, product.url);
                            }
                        }
                    }
                } catch (productErr) {
                    const failures = incrementFailures(db, product.url);
                    log.error('Uncaught error checking product', {
                        url: product.url,
                        error: productErr.message,
                        consecutiveFailures: failures,
                    });

                    if (failures >= config.maxFailuresBeforePause) {
                        pauseProduct(db, product.url);
                    }
                }

                // Human-like gap between products
                if (products.indexOf(product) < products.length - 1) {
                    await randomDelay(1500, 4000);
                }
            }
        } catch (loopErr) {
            log.error('Monitor loop cycle error', { error: loopErr.message });
        }

        // ------ Sleep until next cycle ------
        const sleepMs = jitterInterval(config.pollIntervalMs, config.pollJitterMs);
        log.info(`Sleeping ${(sleepMs / 1000).toFixed(1)}s until next cycle`);
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
}
