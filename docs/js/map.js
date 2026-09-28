/* HKU Access Map — MapLibre wrapper (routes, facilities, slope heatmap) */
class HKUMap {
  constructor(container) {
    this.markers = {};
    this._ready = false;
    this._readyCbs = [];
    this.onPick = null;
    this.navMarker = null;

    this.map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        // AMap/AutoNavi basemap (GCJ-02). Works across the GFW, unlike OSM.
        sources: {
          amap: {
            type: "raster",
            tiles: [
              "https://wprd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=7&x={x}&y={y}&z={z}",
              "https://wprd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=7&x={x}&y={y}&z={z}",
              "https://wprd03.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=7&x={x}&y={y}&z={z}",
              "https://wprd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=7&x={x}&y={y}&z={z}",
            ],
            tileSize: 256,
            attribution: "© AutoNavi 高德地图",
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { "background-color": "#e9eef2" } },
          { id: "amap", type: "raster", source: "amap" },
        ],
      },
      center: [114.1396, 22.283],
      zoom: 16,
      attributionControl: { compact: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    this.map.on("click", (e) => {
      if (this.onPick) {
        // Map is GCJ-02; give the app WGS-84 so it can talk to the backend.
        const w = window.gcj02ToWgs84(e.lngLat.lng, e.lngLat.lat);
        this.onPick({ longitude: w[0], latitude: w[1] });
      }
    });
    this.map.on("load", () => {
      this._ready = true;
      this._readyCbs.forEach((f) => f());
    });
  }

  // WGS-84 -> GCJ-02 for displaying on the AMap basemap.
  _gcj(coord) {
    const g = window.wgs84ToGcj02(coord[0], coord[1]);
    return [g[0], g[1]];
  }

  onReady(cb) {
    if (this._ready) cb();
    else this._readyCbs.push(cb);
  }

  _whenReady(fn) {
    this.onReady(fn);
  }

  setUserLocation(coord) {
    const g = this._gcj([coord.longitude, coord.latitude]);
    this._addMarker(
      "user",
      g,
      '<div style="width:18px;height:18px;border-radius:50%;background:#1e90ff;border:3px solid #fff;box-shadow:0 0 0 4px rgba(30,144,255,.35)"></div>'
    );
    this.map.flyTo({ center: g, zoom: 17 });
  }

  _addMarker(key, lngLat, html) {
    if (this.markers[key]) this.markers[key].remove();
    const el = document.createElement("div");
    el.innerHTML = html;
    const m = new maplibregl.Marker({ element: el.firstElementChild }).setLngLat(lngLat).addTo(this.map);
    this.markers[key] = m;
  }

  clearRoutes() {
    ["route-lines", "route-casing"].forEach((id) => {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    });
    if (this.map.getSource("route-segments")) this.map.removeSource("route-segments");
    ["start", "dest"].forEach((k) => {
      if (this.markers[k]) { this.markers[k].remove(); delete this.markers[k]; }
    });
  }

  clearMarkers() {
    ["start", "dest", "user"].forEach((k) => {
      if (this.markers[k]) { this.markers[k].remove(); delete this.markers[k]; }
    });
  }

  _slopeColor(s) {
    if (s >= 8) return "#FF4444";
    if (s >= 6) return "#FF8C00";
    if (s >= 3) return "#FFD700";
    return "#00C851";
  }

  _slope(a, b) {
    if (a.length > 2 && b.length > 2 && a[2] != null && b[2] != null) {
      const dLat = (b[1] - a[1]) * 110540;
      const dLng = (b[0] - a[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180);
      const horiz = Math.hypot(dLat, dLng);
      return horiz > 0 ? (Math.abs(b[2] - a[2]) / horiz) * 100 : 0;
    }
    return 0;
  }

  addRoutes(routes, selectedId) {
    this._whenReady(() => {
      this.clearRoutes();
      if (!routes.length) return;
      const sel = routes.find((r) => r.id === selectedId) || routes[0];
      const features = [];
      routes.forEach((r) => {
        const coords = (r.geometry?.coordinates || []).map((c) => {
          const g = this._gcj(c);
          return [g[0], g[1], c[2]]; // keep elevation for slope colouring
        });
        for (let i = 1; i < coords.length; i++) {
          const a = coords[i - 1], b = coords[i];
          const slope = this._slope(a, b);
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: [a, b] },
            properties: { color: this._slopeColor(slope), selected: r.id === sel.id },
          });
        }
      });
      this.map.addSource("route-segments", {
        type: "geojson",
        data: { type: "FeatureCollection", features },
      });
      this.map.addLayer({
        id: "route-casing", type: "line", source: "route-segments",
        paint: { "line-color": "#ffffff", "line-width": ["case", ["get", "selected"], 9, 4], "line-opacity": 0.5, "line-cap": "round", "line-join": "round" },
      });
      this.map.addLayer({
        id: "route-lines", type: "line", source: "route-segments",
        paint: { "line-color": ["get", "color"], "line-width": ["case", ["get", "selected"], 6, 3], "line-opacity": ["case", ["get", "selected"], 0.95, 0.55], "line-cap": "round", "line-join": "round" },
      });
      const gc = (sel.geometry?.coordinates || []).map((c) => this._gcj(c));
      if (gc.length) {
        const start = gc[0], end = gc[gc.length - 1];
        this._addMarker("start", [start[0], start[1]], '<div class="start-marker"></div>');
        this._addMarker("dest", [end[0], end[1]], '<div class="dest-marker">📍</div>');
        this._fitCoords(gc);
      }
    });
  }

  _fitCoords(coords) {
    if (!coords.length) return;
    const lngs = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    this.map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 80, maxZoom: 18, duration: 600 }
    );
  }

  addFacilities(facilities) {
    this._whenReady(() => {
      facilities.forEach((f) => {
        const color = {
          elevator: "#2196F3", ramp: "#4CAF50", accessible_entrance: "#9C27B0",
          accessible_toilet: "#00BCD4", disabled_parking: "#FF9800",
        }[f.type] || "#888";
        const icon = { elevator: "🛗", ramp: "♿", accessible_entrance: "🚪", accessible_toilet: "🚻", disabled_parking: "🅿️" }[f.type] || "♿";
        const g = this._gcj([f.coordinate.longitude, f.coordinate.latitude]);
        const el = document.createElement("div");
        el.className = "facility-marker"
          + (f.type === "elevator" ? " facility-elevator" : "")
          + (f.certified ? " facility-certified" : "");
        el.style.background = color;
        el.textContent = icon;
        el.title = f.name + (f.certified ? " ✓" : "");
        el.dataset.type = f.type;
        const marker = new maplibregl.Marker({ element: el }).setLngLat(g).addTo(this.map);
        // Tap to show details (name + floor connectivity for lifts).
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const desc = f.description ? `<div class="pop-desc">${f.description}</div>` : "";
          const badge = f.certified
            ? `<div class="pop-badge">✓ ${window.t ? window.t("fac.official") : "官方認證"}</div>` : "";
          const popup = new maplibregl.Popup({ offset: 18, closeButton: true })
            .setLngLat(g)
            .setHTML(`<div class="fac-popup"><strong>${f.name}</strong>${badge}${desc}</div>`);
          popup.addTo(this.map);
        });
      });
    });
  }

  setFacilityFilter(visibleTypes) {
    document.querySelectorAll(".facility-marker").forEach((el) => {
      el.style.display = visibleTypes.has(el.dataset.type) ? "" : "none";
    });
  }

  toggleSlope(on) {
    this._whenReady(async () => {
      if (on) {
        if (!this.map.getSource("slopes")) {
          const data = await HKUApi.getSlopes();
          if (data && data.features) {
            data.features.forEach((ft) => {
              if (ft.geometry && ft.geometry.coordinates) {
                ft.geometry.coordinates = this._gcj(ft.geometry.coordinates);
              }
            });
          }
          this.map.addSource("slopes", { type: "geojson", data });
          this.map.addLayer({
            id: "slope-circles", type: "circle", source: "slopes",
            paint: {
              "circle-radius": 7, "circle-opacity": 0.55,
              "circle-color": ["interpolate", ["linear"], ["get", "slope"], 0, "#00C851", 3, "#FFD700", 6, "#FF8C00", 8, "#FF4444"],
            },
          });
        } else if (!this.map.getLayer("slope-circles")) {
          this.map.addLayer({ id: "slope-circles", type: "circle", source: "slopes",
            paint: { "circle-radius": 7, "circle-opacity": 0.55,
              "circle-color": ["interpolate", ["linear"], ["get", "slope"], 0, "#00C851", 3, "#FFD700", 6, "#FF8C00", 8, "#FF4444"] } });
        }
      } else {
        if (this.map.getLayer("slope-circles")) this.map.removeLayer("slope-circles");
      }
    });
  }

  toggleRainfall(on) {
    this._whenReady(async () => {
      const paint = {
        "circle-radius": ["interpolate", ["linear"], ["get", "rain"], 0, 4, 2, 9, 10, 16],
        "circle-opacity": ["interpolate", ["linear"], ["get", "rain"], 0, 0.0, 0.1, 0.28, 2, 0.55, 10, 0.72],
        "circle-color": ["interpolate", ["linear"], ["get", "rain"],
          0, "#9ecbff", 0.5, "#5aa9ff", 2, "#2f7fe0", 10, "#103a8a"],
        "circle-stroke-width": 0,
      };
      if (on) {
        if (!this.map.getSource("rainfall")) {
          const data = await HKUApi.rainfallGrid();
          if (data && data.features) {
            data.features.forEach((ft) => {
              if (ft.geometry && ft.geometry.coordinates) {
                ft.geometry.coordinates = this._gcj(ft.geometry.coordinates);
              }
            });
          }
          this.map.addSource("rainfall", { type: "geojson", data: data || { type: "FeatureCollection", features: [] } });
          this.map.addLayer({ id: "rainfall-circles", type: "circle", source: "rainfall", paint });
        } else if (!this.map.getLayer("rainfall-circles")) {
          this.map.addLayer({ id: "rainfall-circles", type: "circle", source: "rainfall", paint });
        }
      } else {
        if (this.map.getLayer("rainfall-circles")) this.map.removeLayer("rainfall-circles");
      }
    });
  }

  // ---------- navigation mode ----------
  followUser(lngLatWgs, heading) {
    const g = this._gcj(lngLatWgs); // lngLatWgs = [lng, lat] in WGS-84
    if (this.markers && this.markers.user) {
      this.markers.user.remove();
      delete this.markers.user;
    }
    if (!this.navMarker) {
      const el = document.createElement("div");
      el.className = "user-nav-marker";
      el.innerHTML = '<div class="user-nav-arrow">➤</div>';
      this.navMarker = new maplibregl.Marker({ element: el }).setLngLat(g).addTo(this.map);
    } else {
      this.navMarker.setLngLat(g);
    }
    const arrow = this.navMarker.getElement().querySelector(".user-nav-arrow");
    if (arrow && heading != null && !isNaN(heading)) {
      arrow.style.transform = `rotate(${heading}deg)`;
    }
    this.map.easeTo({ center: g, duration: 700 });
  }

  drawRemainingRoute(coordsWgs, fromIdx) {
    this._whenReady(() => {
      const remain = coordsWgs.slice(fromIdx).map((c) => this._gcj(c));
      if (!remain.length) return;
      if (this.map.getLayer("nav-remaining")) this.map.removeLayer("nav-remaining");
      if (this.map.getSource("nav-remaining")) this.map.removeSource("nav-remaining");
      this.map.addSource("nav-remaining", {
        type: "geojson",
        data: { type: "Feature", geometry: { type: "LineString", coordinates: remain } },
      });
      this.map.addLayer({
        id: "nav-remaining", type: "line", source: "nav-remaining",
        paint: {
          "line-color": "#1e90ff", "line-width": 8,
          "line-opacity": 0.95, "line-cap": "round", "line-join": "round",
        },
      });
    });
  }

  clearNavOverlay() {
    if (this.map.getLayer("nav-remaining")) this.map.removeLayer("nav-remaining");
    if (this.map.getSource("nav-remaining")) this.map.removeSource("nav-remaining");
    if (this.navMarker) { this.navMarker.remove(); this.navMarker = null; }
  }
}
