# StorageMan Dashboard

StorageMan is a NestJS dashboard for monitoring Storj storage nodes and Sia hosts from one local web UI. It proxies node APIs through backend endpoints, normalizes the responses, and presents revenue, storage, bandwidth, wallet, contract, and health metrics in a static dashboard served from the same app.

## Features

- Unified overview for Storj and Sia node performance.
- Per-node status, revenue, storage usage, and bandwidth metrics.
- Sia wallet and contract summaries with configurable date ranges.
- Storj payout, held amount, distributed amount, audit, QUIC, and disk summaries.
- Static frontend served by NestJS with API endpoints at `/api/storj` and `/api/sia`.

## Getting Started

1. Install dependencies (requires Node.js 18+):

   ```bash
   npm install
   ```

2. Configure environment variables:

   Copy `.env.example` to `.env` and fill in your private values.

   - `STORJ_NODES_JSON` – Preferred option. JSON array of Storj node configs. Today each entry only needs `host`. Wrap the JSON in single quotes in `.env`.
   - `SIA_NODES_JSON` – Preferred option. JSON array of Sia node configs with `host`, optional `username`, optional `password`, and optional `walletHost`. Wrap the JSON in single quotes in `.env`.
   - Legacy flat env vars still work as fallback, but the public config format is the JSON form above.

   The server loads `.env` automatically at startup.

3. Run the application:

   ```bash
   npm run start:dev
   ```

   The server listens on `http://localhost:3000` and serves the UI from `/`.

## Available Scripts

- `npm run start` – Run the application using Nest CLI.
- `npm run start:dev` – Run in watch mode.
- `npm run start:prod` – Run the compiled production bundle.
- `npm run build` – Build the production bundle into `dist`.
- `npm run lint` – Lint the project with ESLint.
- `npm run test` – Run unit tests with Jest.

## Project Structure

- `src/storj` contains the Storj API controller, summary service, and response types.
- `src/sia` contains the Sia API controller, summary service, announce endpoint, and response types.
- `public` holds the static HTML, CSS, and JavaScript dashboard assets.

The frontend consumes the backend endpoints at `/api/storj` and `/api/sia` to render the latest data.
