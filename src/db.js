/**
 * Pokemon Center Bot — SQLite Database Module
 *
 * Singleton better-sqlite3 instance with WAL mode.
 * Manages: watchlist, purchase_history, session_state, monitor_state.
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '..', 'matt-pokemon.db');

/** @type {Database.Database | null} */
let _db = null;

/**
 * Initialize the database schema (idempotent).
 * @param {Database.Database} db
 */
function initSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS watchlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            max_price REAL DEFAULT 999.99,
            enabled INTEGER DEFAULT 1,
            last_checked_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS purchase_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_url TEXT NOT NULL,
            product_name TEXT,
            amount REAL,
            status TEXT DEFAULT 'attempted',
            order_id TEXT,
            screenshot_path TEXT,
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS session_state (
            id INTEGER PRIMARY KEY DEFAULT 1,
            cookies_json TEXT,
            last_validated_at DATETIME,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS monitor_state (
            product_url TEXT PRIMARY KEY,
            consecutive_failures INTEGER DEFAULT 0,
            last_status TEXT,
            last_checked_at DATETIME,
            paused INTEGER DEFAULT 0
        );
    `);

    log.info('Database schema initialized', { path: DB_PATH });
}

/**
 * Get the singleton database instance.
 * Creates the database file and schema on first call.
 *
 * @returns {Database.Database} The better-sqlite3 database instance
 */
export function getDb() {
    if (_db) return _db;

    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');

    log.info('Database connection opened', { path: DB_PATH });
    initSchema(_db);

    // Graceful shutdown
    const cleanup = () => {
        if (_db?.open) {
            _db.close();
            log.info('Database connection closed');
        }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });

    return _db;
}

// ---------------------------------------------------------------------------
// Watchlist helpers
// ---------------------------------------------------------------------------

/**
 * Add a product to the watchlist.
 *
 * @param {string} url - Full Pokemon Center product URL
 * @param {string} name - Human-readable product name
 * @param {number} [maxPrice=999.99] - Maximum price to auto-purchase
 * @returns {{ id: number, url: string, name: string, max_price: number }}
 */
export function addProduct(url, name, maxPrice = 999.99) {
    const db = getDb();

    const stmt = db.prepare(`
        INSERT INTO watchlist (url, name, max_price)
        VALUES (?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
            name = excluded.name,
            max_price = excluded.max_price,
            enabled = 1
    `);

    const result = stmt.run(url, name, maxPrice);

    // Also ensure a monitor_state row exists
    db.prepare(`
        INSERT OR IGNORE INTO monitor_state (product_url) VALUES (?)
    `).run(url);

    log.info('Product added to watchlist', { id: result.lastInsertRowid, url, name, maxPrice });

    return {
        id: Number(result.lastInsertRowid),
        url,
        name,
        max_price: maxPrice,
    };
}

/**
 * Retrieve all enabled, non-paused products from the watchlist.
 * Joins watchlist with monitor_state to filter out paused products.
 *
 * @returns {Array<{ id: number, url: string, name: string, max_price: number, last_checked_at: string | null }>}
 */
export function getActiveProducts() {
    const db = getDb();

    return db.prepare(`
        SELECT w.id, w.url, w.name, w.max_price, w.last_checked_at
        FROM watchlist w
        LEFT JOIN monitor_state m ON w.url = m.product_url
        WHERE w.enabled = 1
          AND COALESCE(m.paused, 0) = 0
        ORDER BY w.id ASC
    `).all();
}

// ---------------------------------------------------------------------------
// Purchase history helpers
// ---------------------------------------------------------------------------

/**
 * Record a purchase attempt in the history table.
 *
 * @param {{ productUrl: string, productName?: string, amount?: number, status?: string, orderId?: string, screenshotPath?: string, errorMessage?: string }} data
 * @returns {{ id: number }}
 */
export function recordPurchase(data) {
    const db = getDb();

    const stmt = db.prepare(`
        INSERT INTO purchase_history
            (product_url, product_name, amount, status, order_id, screenshot_path, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
        data.productUrl,
        data.productName || null,
        data.amount ?? null,
        data.status || 'attempted',
        data.orderId || null,
        data.screenshotPath || null,
        data.errorMessage || null,
    );

    log.info('Purchase recorded', {
        id: result.lastInsertRowid,
        url: data.productUrl,
        status: data.status || 'attempted',
    });

    return { id: Number(result.lastInsertRowid) };
}

// ---------------------------------------------------------------------------
// Monitor state helpers
// ---------------------------------------------------------------------------

/**
 * Update the monitoring state for a product URL.
 * Increments consecutive_failures when failed=true, resets to 0 otherwise.
 *
 * @param {string} url - Product URL
 * @param {string} status - Status label (e.g. 'in_stock', 'out_of_stock', 'error')
 * @param {boolean} failed - Whether this check was a failure
 */
export function updateMonitorState(url, status, failed) {
    const db = getDb();
    const now = new Date().toISOString();

    // Upsert monitor_state row
    db.prepare(`
        INSERT INTO monitor_state (product_url, consecutive_failures, last_status, last_checked_at, paused)
        VALUES (?, ?, ?, ?, 0)
        ON CONFLICT(product_url) DO UPDATE SET
            consecutive_failures = CASE
                WHEN ? = 1 THEN consecutive_failures + 1
                ELSE 0
            END,
            last_status = ?,
            last_checked_at = ?
    `).run(
        url,
        failed ? 1 : 0,
        status,
        now,
        failed ? 1 : 0,
        status,
        now,
    );

    // Also update watchlist last_checked_at
    db.prepare(`
        UPDATE watchlist SET last_checked_at = ? WHERE url = ?
    `).run(now, url);

    log.debug('Monitor state updated', { url, status, failed });
}

/**
 * Pause monitoring for a product by setting paused=1 in monitor_state.
 *
 * @param {string} url - Product URL to pause
 */
export function pauseProduct(url) {
    const db = getDb();

    db.prepare(`
        UPDATE monitor_state SET paused = 1 WHERE product_url = ?
    `).run(url);

    log.warn('Product monitoring paused', { url });
}
