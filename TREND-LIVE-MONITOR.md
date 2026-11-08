# Trend Live Monitor update

The Trend page is now a dedicated real-time monitor:

- Uses the same live endpoint and in-browser rolling sample buffer as Overview.
- Displays one selected camera and one large real-time chart.
- Refreshes using the global automatic refresh interval (10s/30s/1m/5m/10m).
- Shows compact horizontal KPI cards for the latest cumulative Car, Motorcycle, and People counters.
- Removes the historical search controls and result table from the Trend page. Historical search/export remains available from the History page.
- Full-screen expands the chart monitor area; press Escape to exit.
- No backend, API, database, or authentication changes.

Note: the real-time chart accumulates samples in browser memory while the page is open, matching Overview. Reloading the page starts a fresh in-memory chart window from the latest live reading.
