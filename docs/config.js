/* HKU Access Map — deployment configuration
 *
 * ⚠️  NEVER PUT API KEYS IN THIS FILE.
 * This file is served to every visitor's browser — anything here is public.
 * Real keys belong in your BACKEND host's environment variables (or locally in
 * ~/.config/hku-access-map/secrets.env, which is never uploaded).
 *
 * ── Static mode (default, works on GitHub Pages with zero keys) ──────────────
 *      window.__API_BASE__ = "";
 *    Works:  basemap tiles, facilities (lifts / ramps / toilets), slope layer.
 *    Off:    route planning, AI parsing, weather, reverse-geocoding.
 *
 * ── Full mode (host the Python backend somewhere, keep keys server-side) ─────
 *   1. Deploy backend/ to Render / Railway / Fly.io / Koyeb (free tiers exist).
 *   2. In THAT host's dashboard, set env vars:
 *          DEEPSEEK_API_KEY=...
 *          AMAP_API_KEY=...
 *   3. Put its URL below, e.g.:
 *          window.__API_BASE__ = "https://hku-access-map.onrender.com";
 */
window.__API_BASE__ = "";
