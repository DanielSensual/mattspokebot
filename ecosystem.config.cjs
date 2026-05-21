/**
 * Matt's Pokemon Center Bot — PM2 Ecosystem
 * Single persistent process monitoring + auto-purchasing
 */

module.exports = {
    apps: [
        {
            name: 'matt-pokemon-monitor',
            script: 'src/index.js',
            instances: 1,
            watch: false,
            autorestart: true,
            max_restarts: 15,
            restart_delay: 10000,
            error_file: './logs/pm2-error.log',
            out_file: './logs/pm2-out.log',
            merge_logs: true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            env: {
                NODE_ENV: 'production',
                TZ: 'America/New_York',
            },
        },
    ],
};
