/* HKU Access Map — API client
 *
 * Two modes:
 *  1) Full mode  — window.__API_BASE__ points at a hosted backend
 *                  (e.g. "https://hku-access-map.onrender.com"). Routing / AI /
 *                  weather all work; keys stay on the server, never in the browser.
 *  2) Static mode — __API_BASE__ is empty (GitHub Pages with no backend).
 *                  Facilities + slope layers load from bundled ./data/*.json.
 *                  Basemap tiles need no key. Routing/AI gracefully unavailable.
 */
const HKUApi = (() => {
  // Origin of the backend. "" means same-origin (local dev via start.sh).
  const API_ORIGIN =
    typeof window !== "undefined" && window.__API_BASE__
      ? String(window.__API_BASE__).replace(/\/+$/, "")
      : "";
  const BASE = API_ORIGIN + "/api/v1";

  // True when no backend is configured -> use bundled local data only.
  const isStatic = () => !API_ORIGIN;

  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // Bundled data shipped inside the static site (no key required).
  async function localJSON(path) {
    try {
      const r = await fetch(path);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  return {
    async health() {
      try {
        const r = await fetch(API_ORIGIN + "/health");
        return await r.json();
      } catch (e) {
        return { status: "static", deepseek_configured: false, amap_configured: false };
      }
    },
    async parseDestination(text, language) {
      if (isStatic()) throw new Error("static-mode");
      return postJSON(`${BASE}/ai/parse`, { text, language });
    },
    async getRoutes(start, end, settings) {
      if (isStatic()) throw new Error("static-mode");
      return postJSON(`${BASE}/route`, { start, end, settings });
    },
    async explain(route, language) {
      if (isStatic()) throw new Error("static-mode");
      return postJSON(`${BASE}/ai/explain`, { route, language: language || "zh-HK" });
    },
    async score(route) {
      if (isStatic()) throw new Error("static-mode");
      return postJSON(`${BASE}/ai/score`, { route });
    },
    async navHint(current, next, distance) {
      if (isStatic()) throw new Error("static-mode");
      return postJSON(`${BASE}/ai/nav-hint`, { current, next, distance });
    },
    async getFacilities(type) {
      try {
        const url = type ? `${BASE}/facilities?type=${type}` : `${BASE}/facilities`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        // Static mode: fall back to the bundled facility list.
        const data = await localJSON("./data/facilities.json");
        if (!data) return [];
        return type ? data.filter((f) => f.type === type) : data;
      }
    },
    async getSlopes() {
      try {
        const r = await fetch(`${BASE}/facilities/slopes`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        const g = await localJSON("./data/slopes.geojson");
        return g || { type: "FeatureCollection", features: [] };
      }
    },
    async report(payload) {
      if (isStatic()) return { ok: false, static: true };
      return postJSON(`${BASE}/report`, payload);
    },
    async reverse(lng, lat) {
      if (isStatic()) return null;
      try {
        const r = await fetch(`${BASE}/reverse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ longitude: lng, latitude: lat }),
        });
        if (!r.ok) return null;
        const d = await r.json();
        return d.full || d.name || null;
      } catch (e) {
        return null;
      }
    },
    async weather(lang) {
      if (isStatic()) return null;
      try {
        const r = await fetch(`${BASE}/weather?lang=${encodeURIComponent(lang || "zh-HK")}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        return null;
      }
    },
    async rainfallGrid() {
      if (isStatic()) return null;
      try {
        const r = await fetch(`${BASE}/weather/rainfall-grid`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        return null;
      }
    },
  };
})();
