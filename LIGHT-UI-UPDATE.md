# VISION.IQ — Light Neumorphism UI Update

This update refreshes the existing Traffic Counting Dashboard UI to a light neumorphic theme inspired by the supplied VISION.IQ reference.

## What changed
- Reworked the global palette to soft light gray surfaces, raised cards, inset controls, and readable slate text.
- Updated the traffic series palette: Car (emerald), Motorcycle (amber), People (sky blue).
- Updated the SVG chart labels, grid, hover markers, and series colors for the light canvas.
- Updated login, navigation rail, summary cards, camera monitor windows, tables, filters, status bar, and responsive layouts.
- Added Prompt, Inter, and JetBrains Mono font loading with system fallbacks.

## What was intentionally preserved
- Existing HTML element IDs and data attributes used by the application.
- Existing JavaScript behavior, chart interactions, filters, history, playlist analysis, login, and user management.
- Existing Node.js server routes, API proxy, FastAPI upstream contract, and API key handling.
- Existing PostgreSQL/FastAPI project files.

## Deployment
1. Back up the current dashboard folder and its `data/users.json` user database.
2. Extract this ZIP to a separate folder and compare/merge with the deployed project.
3. Copy `.env.example` to `.env` and fill in the real `UPSTREAM_API_BASE`, `UPSTREAM_API_KEY`, and a strong initial admin username/password.
4. Restore your existing `data/users.json` backup into the `data/` folder if you want to retain existing dashboard accounts and permissions. Do not overwrite it with a blank file.
5. Start/restart the Node.js service using your existing deployment method.
6. Open the dashboard and verify Overview, Trend, History, Analysis, login, camera selection, and refresh behavior.

## Security note
Real `.env` files and `data/users.json` were deliberately excluded from this ZIP. The example environment file contains placeholders only. Keep production secrets and user records in your deployment backup, not in source archives.

## Validation performed
- `npm run check` passed (Node.js syntax checks for server and application modules).
- Local HTTP smoke test passed for dashboard HTML, CSS, login, and authenticated `/api/meta` response.
- The upstream health route correctly requires an authenticated dashboard session; no real upstream database writes were performed.
