/**
 * Pokemon Center Bot — Playwright Checkout Engine
 *
 * Automates the end-to-end purchase flow: add to cart → checkout → place
 * order.  Integrates stealth headers, session cookies, captcha detection,
 * and optional store-credit application.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import { config } from './config.js';
import { log } from './logger.js';
import { humanDelay, getStealthHeaders } from './stealth.js';
import { loadCookies, saveCookies, injectCookies } from './session.js';

// Register stealth plugin once at module level
chromium.use(StealthPlugin());

/** Screenshots directory (project-relative) */
const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Take a timestamped screenshot if config.screenshotsEnabled is true.
 * @param {import('playwright').Page} page
 * @param {string} label  Descriptive slug (e.g. "cart-confirmation")
 * @returns {Promise<string|null>} Absolute path to the saved file, or null
 */
async function takeScreenshot(page, label) {
    if (!config.screenshotsEnabled) return null;

    try {
        if (!existsSync(SCREENSHOTS_DIR)) {
            mkdirSync(SCREENSHOTS_DIR, { recursive: true });
        }

        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${ts}_${label}.png`;
        const filepath = join(SCREENSHOTS_DIR, filename);

        await page.screenshot({ path: filepath, fullPage: true });
        log.info('Screenshot saved', { path: filepath });
        return filepath;
    } catch (err) {
        log.warn('Failed to take screenshot', { label, error: err.message });
        return null;
    }
}

/**
 * Detect hCaptcha challenge on the page.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function detectCaptcha(page) {
    try {
        const content = await page.content();
        return (
            content.includes('hcaptcha') ||
            content.includes('h-captcha') ||
            (await page.locator('iframe[src*="hcaptcha"]').count()) > 0
        );
    } catch {
        return false;
    }
}

/**
 * Attempt to click the first matching selector from a list.
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @param {{ timeout?: number }} options
 * @returns {Promise<boolean>} True if a selector was found and clicked
 */
async function clickFirst(page, selectors, options = {}) {
    const timeout = options.timeout ?? 8000;

    for (const sel of selectors) {
        try {
            const locator = page.locator(sel).first();
            await locator.waitFor({ state: 'visible', timeout });
            await locator.click();
            log.info('Clicked element', { selector: sel });
            return true;
        } catch {
            // Try next selector
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Main checkout flow
// ---------------------------------------------------------------------------

/**
 * Executes the full checkout flow for a single product:
 *
 * 1. Loads session cookies and launches a stealth Chromium browser.
 * 2. Navigates to the product page and clicks "Add to Cart".
 * 3. Proceeds through the cart → checkout pipeline.
 * 4. Optionally applies store credits / gift cards.
 * 5. In dry-run mode, stops before placing the order.
 * 6. Places the order and captures a confirmation screenshot.
 *
 * If an hCaptcha challenge is detected at any point, the flow is aborted
 * and a critical alert is dispatched.
 *
 * @param {{ url: string, title: string, price: string }} product
 * @returns {Promise<{ success: boolean, dryRun?: boolean, orderId?: string, error?: string }>}
 */
export async function attemptCheckout(product) {
    log.info('🛒 Starting checkout attempt', {
        title: product.title,
        price: product.price,
        url: product.url,
    });

    let browser = null;
    let context = null;

    try {
        // ---- 1. Load session cookies ----
        const cookies = loadCookies();
        if (cookies.length === 0) {
            log.warn('No session cookies available — checkout will likely require login');
        }

        // ---- 2. Launch browser ----
        const launchOptions = {
            headless: config.headless,
        };
        if (config.browserPath) {
            launchOptions.executablePath = config.browserPath;
        }
        if (config.proxyUrl) {
            launchOptions.proxy = { server: config.proxyUrl };
        }

        browser = await chromium.launch(launchOptions);

        // ---- 3. Create context + inject cookies ----
        const stealthHeaders = getStealthHeaders();

        context = await browser.newContext({
            userAgent: stealthHeaders['User-Agent'],
            locale: 'en-US',
            timezoneId: 'America/New_York',
            viewport: { width: 1440, height: 900 },
            extraHTTPHeaders: {
                'Accept-Language': stealthHeaders['Accept-Language'],
            },
        });

        await injectCookies(context, cookies);
        const page = await context.newPage();

        // ---- 4. Navigate to product page ----
        log.info('Navigating to product page', { url: product.url });
        await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay();

        // Check for CAPTCHA
        if (await detectCaptcha(page)) {
            await takeScreenshot(page, 'captcha-detected');
            log.error('hCaptcha detected on product page');

            try {
                const { sendCriticalAlert } = await import('./alerts.js');
                await sendCriticalAlert({
                    message: `⚠️ CAPTCHA detected during checkout for: ${product.title}`,
                    url: product.url,
                });
            } catch (alertErr) {
                log.warn('Failed to send CAPTCHA alert', { error: alertErr.message });
            }

            return { success: false, error: 'CAPTCHA detected' };
        }

        // ---- 5. Click "Add to Cart" ----
        const addToCartSelectors = [
            'button[data-testid="add-to-cart"]',
            'button:has-text("Add to Cart")',
            '.add-to-cart-button',
            'button.add-to-cart',
            '[data-testid="addToCartButton"]',
        ];

        const addedToCart = await clickFirst(page, addToCartSelectors, { timeout: 10000 });
        if (!addedToCart) {
            await takeScreenshot(page, 'add-to-cart-failed');
            return { success: false, error: 'Could not find Add to Cart button' };
        }

        await humanDelay();
        await takeScreenshot(page, 'added-to-cart');

        // ---- 6. Wait for cart confirmation & navigate to cart ----
        // Some sites show a modal; others redirect.  We try both.
        try {
            // Wait for a cart-confirm modal or mini-cart to appear
            await page.waitForSelector(
                '[data-testid="cart-confirmation"], .cart-modal, .mini-cart',
                { timeout: 5000 },
            ).catch(() => {});
        } catch {
            // If no modal, proceed anyway
        }

        await humanDelay();

        log.info('Navigating to cart');
        await page.goto(config.pokemonCenter.cartUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        await humanDelay();

        if (await detectCaptcha(page)) {
            await takeScreenshot(page, 'captcha-cart');
            return { success: false, error: 'CAPTCHA detected' };
        }

        await takeScreenshot(page, 'cart-page');

        // ---- 7. Proceed to checkout ----
        const checkoutSelectors = [
            'button:has-text("Checkout")',
            'a:has-text("Checkout")',
            'button:has-text("Proceed to Checkout")',
            '[data-testid="checkout-button"]',
            '.checkout-button',
            'a[href*="/checkout"]',
        ];

        const clickedCheckout = await clickFirst(page, checkoutSelectors);
        if (!clickedCheckout) {
            // Fall back to direct navigation
            log.info('Checkout button not found — navigating directly');
            await page.goto(config.pokemonCenter.checkoutUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
        }

        await humanDelay();

        if (await detectCaptcha(page)) {
            await takeScreenshot(page, 'captcha-checkout');
            return { success: false, error: 'CAPTCHA detected' };
        }

        await takeScreenshot(page, 'checkout-page');

        // ---- 8. Apply store credits / gift cards ----
        if (config.useStoreCredits) {
            log.info('Attempting to apply store credits');
            try {
                const creditSelectors = [
                    'button:has-text("Apply Store Credit")',
                    'button:has-text("Use Store Credit")',
                    'button:has-text("Apply Gift Card")',
                    '[data-testid="apply-store-credit"]',
                    '.store-credit-toggle',
                    'input[name="giftCard"]',
                ];

                const appliedCredit = await clickFirst(page, creditSelectors, { timeout: 5000 });
                if (appliedCredit) {
                    log.info('Store credit / gift card section activated');
                    await humanDelay();
                    await takeScreenshot(page, 'store-credit-applied');
                } else {
                    log.info('No store credit / gift card section found — continuing');
                }
            } catch (creditErr) {
                log.warn('Error applying store credits', { error: creditErr.message });
            }
        }

        // ---- 9. Dry-run gate ----
        if (config.dryRun) {
            log.info('🏁 DRY RUN — would place order', {
                title: product.title,
                price: product.price,
            });
            await takeScreenshot(page, 'dry-run-final');
            return { success: true, dryRun: true };
        }

        // ---- 10. Place order ----
        log.info('Placing order…');
        const placeOrderSelectors = [
            'button:has-text("Place Order")',
            'button:has-text("Submit Order")',
            'button:has-text("Complete Order")',
            '[data-testid="place-order"]',
            '.place-order-button',
        ];

        const placedOrder = await clickFirst(page, placeOrderSelectors);
        if (!placedOrder) {
            await takeScreenshot(page, 'place-order-failed');
            return { success: false, error: 'Could not find Place Order button' };
        }

        await humanDelay();

        // ---- 11. Capture confirmation ----
        // Wait for the page to settle on confirmation
        try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        } catch {
            // Some sites don't navigate
        }

        await takeScreenshot(page, 'order-confirmation');

        // Try to extract an order ID from the confirmation page
        let orderId = null;
        try {
            const confirmationText = await page.textContent('body');
            const orderMatch = confirmationText.match(
                /order\s*(?:#|number|id)?[:\s]*([A-Z0-9-]{5,})/i,
            );
            if (orderMatch) {
                orderId = orderMatch[1];
                log.info('Order ID captured', { orderId });
            }
        } catch {
            log.debug('Could not extract order ID from confirmation page');
        }

        // ---- 12. Persist updated cookies ----
        try {
            const updatedCookies = await context.cookies();
            saveCookies(updatedCookies);
        } catch (cookieErr) {
            log.warn('Failed to save updated cookies', { error: cookieErr.message });
        }

        log.info('✅ Checkout complete', { orderId, title: product.title });
        return { success: true, orderId };
    } catch (err) {
        log.error('Checkout error', { error: err.message, stack: err.stack });

        // Best-effort screenshot of the error state
        if (context) {
            try {
                const pages = context.pages();
                if (pages.length > 0) {
                    await takeScreenshot(pages[0], 'checkout-error');
                }
            } catch {
                // swallow
            }
        }

        return { success: false, error: err.message };
    } finally {
        // ---- Cleanup ----
        try {
            if (context) await context.close();
        } catch { /* swallow */ }
        try {
            if (browser) await browser.close();
        } catch { /* swallow */ }
    }
}
