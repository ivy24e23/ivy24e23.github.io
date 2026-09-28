/* HKU Access Map — app orchestration */
(() => {
  const $ = (id) => document.getElementById(id);
  const t = (k, p) => (p ? window.I18N.tf(k, p) : window.I18N.t(k));
  const L = () => window.__lang || "zh-HK";

  const fmtDist = (m) => {
    if (m >= 1000) return (m / 1000).toFixed(1) + " " + t("unit.km");
    return Math.round(m) + " " + t("unit.m");
  };
  const fmtDur = (s) => {
    if (s >= 60) return Math.round(s / 60) + " " + t("unit.min");
    return Math.round(s) + " " + t("unit.sec");
  };

  // Backend route labels -> i18n keys
  const LABEL_KEYS = {
    "推薦路線": "label.recommended",
    "最平坦路線": "label.flattest",
    "最短路線": "label.shortest",
    "公共交通路線": "label.transit",
    "備選路線": "label.alt",
  };
  const labelText = (lbl) => t(LABEL_KEYS[lbl] || lbl);

  const state = {
    settings: {
      language: "zh-HK",
      avoidStairs: true,
      preferRamps: true,
      preferElevators: true,
      maxSlopePercent: 8,
      voiceEnabled: false,
      highContrastMode: false,
      fontSize: "normal",
    },
    start: null,
    destination: null,
    startLabel: "",
    destLabel: "",
    routes: [],
    selectedId: null,
    pickMode: null,
    activeField: null,   // 'start' | 'end' — which input is being set
    slopeOn: false,
    facilities: [],
  };

  let map, voiceOn = false, speech = null;

  // ---------- navigation state ----------
  const NAV = {
    active: false,
    watchId: null,
    coords: [],
    steps: [],
    announced: new Set(),
    offWarned: false,
    userIdx: 0,
  };
  const NAV_SPEED = 1.2;      // walking speed m/s
  const ARRIVE_DIST = 20;     // m to destination -> arrived
  const ANNOUNCE_DIST = 40;   // m before a turn -> announce it
  const OFFROUTE_DIST = 40;   // m away from route -> off-route warning

  // ---------- settings persistence ----------
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem("hku-settings"));
      if (s) Object.assign(state.settings, s);
    } catch (e) {}
  }
  function saveSettings() {
    localStorage.setItem("hku-settings", JSON.stringify(state.settings));
  }

  function applySettingsToUI() {
    const s = state.settings;
    $("set-avoid-stairs").checked = s.avoidStairs;
    $("set-prefer-ramps").checked = s.preferRamps;
    $("set-prefer-elevators").checked = s.preferElevators;
    $("set-max-slope").value = String(s.maxSlopePercent);
    $("set-voice").checked = s.voiceEnabled;
    $("set-lang").value = s.language;
    $("set-contrast").checked = s.highContrastMode;
    $("set-font").value = s.fontSize;
    document.body.classList.toggle("high-contrast", s.highContrastMode);
    document.body.setAttribute("data-font", s.fontSize);
  }

  // ---------- i18n: apply current language to all static + dynamic UI ----------
  function applyLanguage() {
    window.__lang = state.settings.language;
    document.documentElement.lang = state.settings.language;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
    });
    // Keep special input labels (My location / picked) in sync with language.
    const genericLabels = new Set(["ft.myLocation", "ft.picked"]);
    const isGeneric = (val) => ["zh-HK", "zh-CN", "en"].some((l) => val === window.I18N.t("ft.myLocation", l) || val === window.I18N.t("ft.picked", l));
    const startVal = $("input-start").value;
    const endVal = $("input-end").value;
    if (isGeneric(startVal)) {
      state.startLabel = window.I18N.t("ft.myLocation", "en") === startVal || window.I18N.t("ft.myLocation", "zh-HK") === startVal || window.I18N.t("ft.myLocation", "zh-CN") === startVal ? t("ft.myLocation") : t("ft.picked");
      $("input-start").value = state.startLabel;
    }
    if (isGeneric(endVal)) {
      state.destLabel = window.I18N.t("ft.myLocation", "en") === endVal || window.I18N.t("ft.myLocation", "zh-HK") === endVal || window.I18N.t("ft.myLocation", "zh-CN") === endVal ? t("ft.myLocation") : t("ft.picked");
      $("input-end").value = state.destLabel;
    }
    // re-render any visible dynamic content in the new language
    if (state.routes.length && !$("route-list").classList.contains("hidden")) {
      renderRouteList();
    }
    if (state.routes.length && !$("route-detail").classList.contains("hidden")) {
      const r = state.routes.find((x) => x.id === state.selectedId);
      renderTurns(r);
      renderNearbyFacilities(r?.geometry?.coordinates || []);
    }
    // refresh the weather hint in the new language
    fetchWeather();
  }

  // ---------- nearby facilities (elevators / ramps) along the route ----------
  function renderNearbyFacilities(coordsWgs) {
    const box = $("route-nearby");
    if (!box) return;
    if (!state.facilities.length || !coordsWgs.length) { box.innerHTML = ""; return; }
    const NEAR = 60; // metres
    const found = [];
    for (const f of state.facilities) {
      const fc = [f.coordinate.longitude, f.coordinate.latitude];
      let best = Infinity;
      for (const c of coordsWgs) {
        const d = haversine(c, fc);
        if (d < best) best = d;
      }
      if (best <= NEAR) found.push({ f, d: best });
    }
    found.sort((a, b) => a.d - b.d);
    const icon = (tp) => ({ elevator: "🛗", ramp: "♿", accessible_entrance: "🚪", accessible_toilet: "🚻", disabled_parking: "🅿️" }[tp] || "♿");
    if (!found.length) {
      box.innerHTML = `<div class="nearby-title">${t("route.nearbyNone")}</div>`;
      return;
    }
    box.innerHTML =
      `<div class="nearby-title">${t("route.nearbyTitle")}</div>` +
      found
        .map(({ f, d }) => {
          const name = f.name || t("fac.type." + f.type) || f.type;
          const badge = f.certified ? `<span class="nearby-badge">✓</span>` : "";
          const extra = f.certified && f.description
            ? `<div class="nearby-desc">${f.description}</div>` : "";
          return `<div class="nearby-item">${badge}<span class="nearby-ic">${icon(f.type)}</span><span class="nearby-name">${name}</span><span class="nearby-dist">${Math.round(d)}m</span>${extra}</div>`;
        })
        .join("");
  }

  // ---------- phone LAN access ----------
  async function showLanUrl() {
    try {
      const r = await fetch("/api/v1/network");
      const d = await r.json();
      const wrap = $("lan-wrap");
      const list = $("lan-list");
      if (!wrap || !list) return;
      const urls = d.https_urls && d.https_urls.length ? d.https_urls : [];
      if (!urls.length) return;
      wrap.classList.remove("hidden");
      list.innerHTML = "";
      urls.forEach((u, i) => {
        const a = document.createElement("a");
        a.className = "lan-item" + (i === 0 ? " lan-primary" : "");
        a.href = u;
        a.target = "_blank";
        a.textContent = (i === 0 ? "★ " : "") + u;
        list.appendChild(a);
      });
    } catch (e) {}
  }

  function applyFacilityFilter() {
    const visible = new Set();
    document.querySelectorAll(".fac-filter").forEach((cb) => { if (cb.checked) visible.add(cb.value); });
    if (map) map.setFacilityFilter(visible);
  }

  // ---------- helpers ----------
  function showLoading(text) { $("loading-text").textContent = text; $("loading").classList.remove("hidden"); }
  function hideLoading() { $("loading").classList.add("hidden"); }
  function showBanner(text) { const b = $("status-banner"); b.textContent = text; b.classList.remove("hidden"); }
  function hideBanner() { $("status-banner").classList.add("hidden"); }

  // ---------- geolocation ----------
  function locate() {
    if (!navigator.geolocation) { showBanner(t("banner.locateFail")); return; }
    showLoading(t("loading.locate"));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coord = { longitude: pos.coords.longitude, latitude: pos.coords.latitude };
        setStart(coord, t("ft.myLocation"));
        map.setUserLocation(coord);
        hideLoading();
        showBanner(t("banner.startResolved", { start: t("ft.myLocation") }));
        // Reverse-geocode to replace "My location" with a real place name.
        HKUApi.reverse(coord.longitude, coord.latitude).then((name) => {
          if (name) setStart(coord, name);
        });
      },
      (err) => { hideLoading(); showBanner(t("banner.locateFail")); console.warn(err); },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  function setStart(coord, label) {
    state.start = coord;
    state.startLabel = label || t("ft.picked");
    $("input-start").value = state.startLabel;
    renderFromTo();
  }

  function setEnd(coord, label) {
    state.destination = coord;
    state.destLabel = label || t("ft.picked");
    $("input-end").value = state.destLabel;
    renderFromTo();
  }

  // ---------- from -> to summary bar ----------
  function renderFromTo() {
    const bar = $("from-to");
    if (!bar) return;
    const hasBoth = state.start && state.destination;
    bar.classList.toggle("hidden", !hasBoth);
    if (!hasBoth) return;
    const startTxt = state.startLabel || t("ft.picked");
    const endTxt = state.destLabel || t("ft.picked");
    $("ft-start").textContent = startTxt;
    $("ft-end").textContent = endTxt;
  }

  // ---------- routing ----------
  async function doRoute() {
    if (!state.start || !state.destination) {
      showBanner(t("banner.noStartEnd"));
      return;
    }
    showLoading(t("loading.route"));
    try {
      const routes = await HKUApi.getRoutes(state.start, state.destination, state.settings);
      state.routes = routes;
      hideLoading();
      // Show the from→to summary + route options. Stay on this screen —
      // do NOT jump into the detail/navigation view automatically.
      renderFromTo();
      renderRouteList();
      $("route-detail").classList.add("hidden");
      $("route-list").classList.remove("hidden");
      $("route-panel").classList.remove("hidden");
      const best = routes.find((r) => r.isBest) || routes[0];
      if (best) {
        state.selectedId = best.id;
        map.addRoutes(state.routes, best.id);
        renderRouteList();
      }
    } catch (e) {
      hideLoading();
      showBanner(t("banner.parseFail", { msg: e.message }));
    }
  }

  function renderRouteList() {
    const list = $("route-list");
    list.innerHTML = "";
    state.routes.forEach((r) => {
      const card = document.createElement("div");
      card.className = "route-card" + (r.id === state.selectedId ? " selected" : "");
      const slopeColor = r.maxSlope >= 8 ? "#FF4444" : r.maxSlope >= 6 ? "#FF8C00" : r.maxSlope >= 3 ? "#FFD700" : "#00C851";
      card.innerHTML = `
        <div class="rc-head">
          <span class="rc-label">${labelText(r.label)}</span>
          ${r.isBest ? `<span class="rc-best">${t("route.best")}</span>` : ""}
        </div>
        <div class="rc-metrics">
          <span>📏 ${fmtDist(r.distance)}</span>
          <span>⏱ ${fmtDur(r.duration)}</span>
          <span><span class="rc-slope-dot" style="background:${slopeColor}"></span>${t("route.slope")} ${r.maxSlope.toFixed(1)}%</span>
          <span class="rc-score">${t("route.score")} ${r.score}</span>
        </div>
        ${r.warnings && r.warnings.length ? `<div class="rc-warn">⚠ ${r.warnings.join("；")}</div>` : ""}
      `;
      card.onclick = () => selectRoute(r.id);
      list.appendChild(card);
    });
  }

  async function selectRoute(id) {
    state.selectedId = id;
    const route = state.routes.find((r) => r.id === id);
    if (!route) return;
    map.addRoutes(state.routes, id);
    renderRouteList();
    $("route-list").classList.add("hidden");
    $("route-detail").classList.remove("hidden");
    $("route-explain").textContent = t("route.explainLoading");
    $("turn-list").innerHTML = "";
    try {
      const res = await HKUApi.explain(route, state.settings.language);
      $("route-explain").textContent = res.text || t("route.noExplain");
      if (voiceOn) speak(res.text);
    } catch (e) {
      $("route-explain").textContent = t("route.explainFail");
    }
    renderTurns(route);
    renderNearbyFacilities(route.geometry?.coordinates || []);
  }

  async function refreshExplanation() {
    const route = state.routes.find((r) => r.id === state.selectedId);
    if (!route) return;
    try {
      const res = await HKUApi.explain(route, state.settings.language);
      $("route-explain").textContent = res.text || t("route.noExplain");
    } catch (e) {
      $("route-explain").textContent = t("route.explainFail");
    }
  }

  function renderTurns(route) {
    const steps = buildSteps(route.geometry?.coordinates || []);
    const wrap = $("turn-list");
    wrap.innerHTML = "";
    steps.forEach((s) => {
      const div = document.createElement("div");
      div.className = "turn-step";
      div.innerHTML = `
        <div class="turn-icon">${turnIcon(s.type)}</div>
        <div class="turn-text">${t("turn." + s.type)}<div class="turn-dist">${fmtDist(s.distance)}</div></div>`;
      wrap.appendChild(div);
    });
  }

  // ---------- turn-by-turn derivation ----------
  function bearing(a, b) {
    const φ1 = (a[1] * Math.PI) / 180, φ2 = (b[1] * Math.PI) / 180;
    const Δλ = ((b[0] - a[0]) * Math.PI) / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }
  function angleDiff(a, b) {
    let d = a - b;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  }
  function pathLength(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const dLat = (coords[i][1] - coords[i - 1][1]) * 110540;
      const dLng = (coords[i][0] - coords[i - 1][0]) * 111320 * Math.cos((coords[i][1] * Math.PI) / 180);
      total += Math.hypot(dLat, dLng);
    }
    return total;
  }
  function turnType(d) { return d > 25 ? "right" : d < -25 ? "left" : "straight"; }
  function turnIcon(ty) { return { straight: "⬆", left: "⬅", right: "➡", elevator: "🛗", ramp: "♿", arrive: "🏁" }[ty] || "⬆"; }
  function buildSteps(coords) {
    if (coords.length < 2) return [];
    const steps = [];
    let acc = [coords[0]];
    let prev = bearing(coords[0], coords[1]);
    for (let i = 1; i < coords.length; i++) {
      if (i === coords.length - 1) { acc.push(coords[i]); break; }
      const b = bearing(coords[i], coords[i + 1]);
      const d = angleDiff(b, prev);
      if (Math.abs(d) > 25) {
        acc.push(coords[i]);
        steps.push({ type: turnType(d), distance: pathLength(acc), index: i });
        acc = [coords[i]];
        prev = b;
      } else { acc.push(coords[i]); prev = b; }
    }
    if (acc.length >= 2) steps.push({ type: "arrive", distance: pathLength(acc), index: coords.length - 1 });
    return steps;
  }

  // ---------- geospatial helpers (for navigation) ----------
  function haversine(a, b) { // a,b = [lng,lat]
    const R = 6371000;
    const lat1 = a[1] * Math.PI / 180, lat2 = b[1] * Math.PI / 180;
    const dLat = (b[1] - a[1]) * Math.PI / 180, dLng = (b[0] - a[0]) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function pathDist(coords, from, to) {
    let d = 0;
    for (let i = from + 1; i <= to; i++) d += haversine(coords[i - 1], coords[i]);
    return d;
  }
  function nearestIndex(coords, lng, lat) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = haversine([coords[i][0], coords[i][1]], [lng, lat]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return { index: best, dist: bestD };
  }

  // ---------- walking navigation ----------
  function startNavigation() {
    const route = state.routes.find((r) => r.id === state.selectedId);
    if (!route || !route.geometry || !route.geometry.coordinates || route.geometry.coordinates.length < 2) {
      showBanner(t("banner.noDest")); return;
    }
    NAV.coords = route.geometry.coordinates;
    NAV.steps = buildSteps(NAV.coords);
    NAV.announced = new Set();
    NAV.offWarned = false;
    NAV.active = true;

    document.body.classList.add("nav-active");
    $("route-panel").classList.add("hidden");
    $("nav-panel").classList.remove("hidden");
    hideBanner();
    setVoice(true); // AMap-style: voice on by default during navigation (mutable via 🔊)

    const total = pathDist(NAV.coords, 0, NAV.coords.length - 1);
    if (voiceOn) speak(t("nav.start", { dist: fmtDist(total), time: fmtDur(total / NAV_SPEED) }));

    if (!navigator.geolocation) { showBanner(t("banner.geolocOff")); return; }
    NAV.watchId = navigator.geolocation.watchPosition(
      (pos) => updateNav(pos.coords.longitude, pos.coords.latitude, pos.coords.heading),
      (err) => { if (NAV.active) showBanner(t("banner.geolocOff")); console.warn(err); },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
  }

  function updateNav(lng, lat, heading) {
    if (!NAV.active) return;
    const coords = NAV.coords;
    const last = coords.length - 1;
    const { index: ni, dist: dToRoute } = nearestIndex(coords, lng, lat);
    NAV.userIdx = ni;

    // arrival
    const dEnd = haversine([coords[last][0], coords[last][1]], [lng, lat]);
    if (dEnd <= ARRIVE_DIST) { arriveNav(); return; }

    // off-route warning
    if (dToRoute > OFFROUTE_DIST) {
      if (!NAV.offWarned) {
        NAV.offWarned = true;
        if (voiceOn) speak(t("nav.offRoute"));
      }
    } else {
      NAV.offWarned = false;
    }

    // announce upcoming turns by proximity (not all at once)
    let nextStep = null;
    for (const s of NAV.steps) {
      if (s.index <= ni) { NAV.announced.add(s.index); continue; }
      const pd = pathDist(coords, ni, s.index);
      if (!NAV.announced.has(s.index) && pd <= ANNOUNCE_DIST) {
        NAV.announced.add(s.index);
        if (voiceOn) speak(t("turn." + s.type));
      }
      if (!nextStep) nextStep = s;
    }

    // nav panel
    if (nextStep) {
      const pd = pathDist(coords, ni, nextStep.index);
      $("nav-turn-icon").textContent = turnIcon(nextStep.type);
      $("nav-next-instr").textContent = t("turn." + nextStep.type);
      $("nav-next-dist").textContent = fmtDist(pd);
    } else {
      $("nav-turn-icon").textContent = "🏁";
      $("nav-next-instr").textContent = t("turn.arrive");
      $("nav-next-dist").textContent = fmtDist(dEnd);
    }
    const remaining = pathDist(coords, ni, last);
    $("nav-remaining").textContent = t("nav.remaining") + " " + fmtDist(remaining);
    $("nav-eta").textContent = t("nav.eta") + " " + fmtDur(remaining / NAV_SPEED);

    map.followUser([lng, lat], heading);
    map.drawRemainingRoute(coords, ni);
  }

  function arriveNav() {
    stopNavigation();
    if (voiceOn) speak(t("nav.arrived"));
    showBanner(t("nav.arrived"));
  }

  function stopNavigation() {
    NAV.active = false;
    if (NAV.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(NAV.watchId);
    NAV.watchId = null;
    document.body.classList.remove("nav-active");
    $("nav-panel").classList.add("hidden");
    $("route-panel").classList.remove("hidden");
    map.clearNavOverlay();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  // ---------- voice (pick a natural TTS voice, not the raspy default) ----------
  let voicesCache = [];
  function loadVoices() {
    if (!("speechSynthesis" in window)) return;
    voicesCache = window.speechSynthesis.getVoices() || [];
    if (typeof window.speechSynthesis.onvoiceschanged !== "undefined") {
      window.speechSynthesis.onvoiceschanged = () => {
        voicesCache = window.speechSynthesis.getVoices() || [];
      };
    }
  }
  function pickVoice(langKey) {
    // 繁體中文 (zh-HK) 必須用粵語聲線，否則會讀成普通話。
    if (langKey === "zh-HK") {
      const canto = voicesCache.find((v) => {
        const l = (v.lang || "").toLowerCase();
        const n = v.name || "";
        return l === "zh-hk" || l.startsWith("yue") || /粵|cantonese|yue/i.test(n + " " + l);
      });
      if (canto) return canto;
      const named = ["Google 粵語", "Sin-ji", "粵語", "Cantonese", "Yiu"]
        .map((nm) => voicesCache.find((x) => x.name === nm || x.name.indexOf(nm) === 0))
        .find(Boolean);
      if (named) return named;
    }
    const pref = {
      en: ["Samantha", "Google US English", "Microsoft Aria Online (Natural) - English (United States)", "Victoria", "Alex"],
      "zh-HK": ["Google 粵語", "Sin-ji", "粵語", "Yiu", "Cantonese"],
      "zh-CN": ["Ting-Ting", "Mei-Jia", "Sin-ji", "Google 普通话", "Huihui"],
    }[langKey] || [];
    for (const name of pref) {
      const v = voicesCache.find((x) => x.name === name || x.name.indexOf(name) === 0);
      if (v) return v;
    }
    const bcp = { en: "en", "zh-HK": "zh-HK", "zh-CN": "zh-CN" }[langKey] || "en";
    return voicesCache.find((x) => x.lang && x.lang.indexOf(bcp) === 0) || null;
  }
  function speak(text) {
    if (!("speechSynthesis" in window) || !text) return;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    const u = new SpeechSynthesisUtterance(text);
    const langKey = state.settings.language;
    u.lang = { "zh-HK": "zh-HK", "zh-CN": "zh-CN", en: "en-US" }[langKey] || "zh-HK";
    const v = pickVoice(langKey);
    if (v) u.voice = v;
    u.rate = 1.0;
    u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  }
  function setVoice(on) {
    voiceOn = on;
    $("btn-voice").classList.toggle("active", on);
    $("btn-nav-voice").classList.toggle("active", on);
    if (!on && "speechSynthesis" in window) speechSynthesis.cancel();
  }
  function toggleVoice() {
    setVoice(!voiceOn);
    if (voiceOn && !NAV.active) {
      const route = state.routes.find((r) => r.id === state.selectedId);
      if (route) speak($("route-explain").textContent);
    }
  }

  // ---------- speech recognition (mic) ----------
  function startMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showBanner(t("banner.noSpeech")); return; }
    const rec = new SR();
    rec.lang = { "zh-HK": "zh-HK", "zh-CN": "zh-CN", "en": "en-US" }[state.settings.language] || "zh-HK";
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      const field = state.activeField || "end";
      $(field === "start" ? "input-start" : "input-end").value = text;
      resolveInput(field);
    };
    rec.onerror = () => showBanner(t("banner.voiceFail"));
    rec.start();
  }

  // ---------- resolve a start/end text input into a coordinate ----------
  async function resolveInput(field) {
    const input = field === "start" ? "input-start" : "input-end";
    const text = $(input).value.trim();
    if (!text) return false;
    showLoading(t("loading.parse"));
    try {
      const parsed = await HKUApi.parseDestination(text, state.settings.language);
      hideLoading();
      if (parsed.coordinates) {
        const coord = { longitude: parsed.coordinates.longitude, latitude: parsed.coordinates.latitude };
        const label = parsed.destination || text || t("ft.picked");
        if (field === "start") setStart(coord, label);
        else setEnd(coord, label);
        map._whenReady(() => map.map.flyTo({ center: [coord.longitude, coord.latitude], zoom: 17 }));
        showBanner(t(field === "start" ? "banner.startResolved" : "banner.endResolved", { [field]: label }));
        return true;
      }
      showBanner(t("banner.resolveFail", { text }));
      return false;
    } catch (e) {
      hideLoading();
      showBanner(t("banner.parseFail", { msg: e.message }));
      return false;
    }
  }

  async function onRouteSearch() {
    // Re-resolve if the user edited an input after a previous selection.
    const startVal = $("input-start").value.trim();
    const endVal = $("input-end").value.trim();
    const startNeedsParse = startVal && startVal !== (state.startLabel || "");
    const endNeedsParse = endVal && endVal !== (state.destLabel || "");
    const startOk = startNeedsParse ? await resolveInput("start") : !!state.start;
    const endOk = endNeedsParse ? await resolveInput("end") : !!state.destination;
    if (startOk && endOk) {
      doRoute();
    } else {
      showBanner(t("banner.noStartEnd"));
    }
  }

  // ---------- crowdsource report ----------
  function report() {
    const type = prompt(t("report.typePrompt"), "wrong_slope");
    if (!type) return;
    const message = prompt(t("report.msgPrompt"), "") || "";
    HKUApi.report({
      routeId: state.selectedId,
      type,
      message,
      coordinate: state.destination,
    }).then(() => showBanner(t("banner.thanks"))).catch(() => showBanner(t("banner.reportFail")));
  }

  // ---------- map pick mode ----------
  function setPick(mode) {
    state.activeField = mode;
    state.pickMode = mode;
    map.onPick = handleMapPick;
    $("row-start").classList.toggle("active", mode === "start");
    $("row-end").classList.toggle("active", mode === "end");
    $("btn-pick-start").classList.toggle("active", mode === "start");
    $("btn-pick-end").classList.toggle("active", mode === "end");
    if (mode === "start") $("input-start").focus();
    else $("input-end").focus();
    showBanner(mode === "start" ? t("banner.pickStart") : t("banner.pickEnd"));
  }

  function handleMapPick(coord) {
    const mode = state.pickMode || state.activeField;
    if (!mode) return;
    const g = map._gcj([coord.longitude, coord.latitude]);
    map._addMarker(mode === "start" ? "start" : "dest", g,
      mode === "start" ? '<div class="start-marker"></div>' : '<div class="dest-marker">📍</div>');
    if (mode === "start") setStart(coord, t("ft.picked"));
    else setEnd(coord, t("ft.picked"));
    // Reverse-geocode to show a real place name (best-effort).
    HKUApi.reverse(coord.longitude, coord.latitude).then((name) => {
      if (name) {
        if (mode === "start") setStart(coord, name);
        else setEnd(coord, name);
      }
    });
    // Do NOT auto-route; user can edit the text or tap "Find route".
    state.pickMode = null;
    state.activeField = null;
    $("row-start").classList.remove("active");
    $("row-end").classList.remove("active");
    $("btn-pick-start").classList.remove("active");
    $("btn-pick-end").classList.remove("active");
    if (state.start && state.destination) {
      showBanner(t("banner.routeReady"));
    }
  }

  // ---------- weather (rainfall nowcast + slip warning) ----------
  const weatherState = { announced: false };

  async function fetchWeather() {
    const d = await HKUApi.weather(state.settings.language);
    if (!d) return;
    renderWeather(d);
  }

  function renderWeather(d) {
    const bar = $("weather-bar");
    if (!bar) return;
    bar.classList.remove("hidden", "raining", "slip");
    bar.classList.add("raining");
    if (d.slip_warning) bar.classList.add("slip");

    $("wb-icon").textContent = d.raining ? "🌧️" : d.rain_soon ? "🌦️" : "☀️";
    $("wb-status").textContent = d.intensity_label || "";
    const mm = d.near_mm != null ? d.near_mm : 0;
    $("wb-mm").textContent = (d.raining || d.rain_soon) ? mm + " mm" : "";
    $("wb-text").textContent = d.text || "";

    const slip = $("wb-slip");
    if (d.slip_warning && d.slip_message) {
      slip.classList.remove("hidden");
      $("wb-slip-title").textContent = t("weather.slipTitle");
      $("wb-slip-msg").textContent = d.slip_message;
    } else {
      slip.classList.add("hidden");
    }
    document.body.classList.add("weather-shown");

    // Announce once when rain/slip starts (only if voice is enabled).
    if (d.slip_warning && !weatherState.announced) {
      weatherState.announced = true;
      if (state.settings.voiceEnabled && d.text) speak(d.text);
    }
    if (!d.slip_warning) weatherState.announced = false;
  }

  // ---------- init ----------
  async function init() {
    loadSettings();
    applySettingsToUI();
    applyLanguage();
    map = new HKUMap("map");

    try {
      const h = await HKUApi.health();
      if (h && h.status === "static") {
        // No backend configured (e.g. GitHub Pages) — bundled data only.
        showBanner("🗺 演示模式：地圖／設施／坡度圖可瀏覽；路線規劃、AI 與天氣需要後端 (Demo mode: map & facilities only; routing/AI/weather need a backend)");
      } else {
        const missing = [];
        if (!h.deepseek_configured) missing.push("DeepSeek");
        if (!h.amap_configured) missing.push("高德 AMap");
        if (missing.length) showBanner(t("banner.demo", { keys: missing.join(" / ") }));
      }
    } catch (e) {}

    try {
      const facs = await HKUApi.getFacilities();
      state.facilities = facs;
      map.addFacilities(facs);
    } catch (e) { console.warn("facilities load failed", e); }

    loadVoices();
    showLanUrl();
    fetchWeather();
    setInterval(fetchWeather, 5 * 60 * 1000); // refresh every 5 min
    wireEvents();
  }

  function wireEvents() {
    // from/to inputs
    $("input-start").addEventListener("keydown", (e) => { if (e.key === "Enter") resolveInput("start"); });
    $("input-end").addEventListener("keydown", (e) => { if (e.key === "Enter") resolveInput("end"); });
    $("input-start").addEventListener("focus", () => { state.activeField = "start"; $("row-start").classList.add("active"); $("row-end").classList.remove("active"); });
    $("input-end").addEventListener("focus", () => { state.activeField = "end"; $("row-end").classList.add("active"); $("row-start").classList.remove("active"); });
    $("input-start").addEventListener("blur", () => { $("row-start").classList.remove("active"); });
    $("input-end").addEventListener("blur", () => { $("row-end").classList.remove("active"); });
    $("btn-mic-start").onclick = () => { state.activeField = "start"; startMic(); };
    $("btn-mic-end").onclick = () => { state.activeField = "end"; startMic(); };
    $("btn-route").onclick = onRouteSearch;

    $("btn-locate").onclick = locate;
    $("btn-pick-start").onclick = () => setPick("start");
    $("btn-pick-end").onclick = () => setPick("end");
    $("btn-clear").onclick = () => {
      if (NAV.active) stopNavigation();
      state.start = null; state.destination = null; state.startLabel = ""; state.destLabel = ""; state.routes = []; state.selectedId = null; state.activeField = null;
      $("input-start").value = ""; $("input-end").value = "";
      $("row-start").classList.remove("active"); $("row-end").classList.remove("active");
      map.clearRoutes(); map.clearMarkers && map.clearMarkers(); $("route-panel").classList.add("hidden"); hideBanner();
    };
    $("btn-slope").onclick = () => {
      state.slopeOn = !state.slopeOn;
      $("btn-slope").classList.toggle("active", state.slopeOn);
      map.toggleSlope(state.slopeOn);
    };
    $("btn-fac").onclick = () => {
      $("fac-legend").classList.toggle("hidden");
      $("btn-fac").classList.toggle("active", !$("fac-legend").classList.contains("hidden"));
    };
    $("btn-rain").onclick = () => {
      const on = !$("btn-rain").classList.contains("active");
      $("btn-rain").classList.toggle("active", on);
      map.toggleRainfall(on);
    };
    $("wb-close").onclick = () => {
      $("weather-bar").classList.add("hidden");
      document.body.classList.remove("weather-shown");
    };
    document.querySelectorAll(".fac-filter").forEach((cb) => {
      cb.addEventListener("change", applyFacilityFilter);
    });
    applyFacilityFilter();
    $("btn-back-list").onclick = () => { $("route-detail").classList.add("hidden"); $("route-list").classList.remove("hidden"); };
    $("btn-voice").onclick = toggleVoice;
    $("btn-report").onclick = report;
    $("btn-nav").onclick = startNavigation;
    $("btn-nav-exit").onclick = stopNavigation;
    $("btn-nav-voice").onclick = () => setVoice(!voiceOn);

    // settings modal
    function closeSettings() {
      const s = state.settings;
      const prevLang = s.language;
      s.avoidStairs = $("set-avoid-stairs").checked;
      s.preferRamps = $("set-prefer-ramps").checked;
      s.preferElevators = $("set-prefer-elevators").checked;
      s.maxSlopePercent = parseFloat($("set-max-slope").value);
      s.voiceEnabled = $("set-voice").checked;
      s.language = $("set-lang").value;
      s.highContrastMode = $("set-contrast").checked;
      s.fontSize = $("set-font").value;
      setVoice(s.voiceEnabled);
      saveSettings();
      applySettingsToUI();
      applyLanguage();
      $("settings-modal").classList.add("hidden");
      if (s.language !== prevLang && !$("route-detail").classList.contains("hidden")) {
        refreshExplanation();
      } else if (state.start && state.destination) {
        doRoute();
      }
    }
    $("btn-settings").onclick = () => $("settings-modal").classList.remove("hidden");
    $("btn-close-settings").onclick = closeSettings;
    $("btn-close-settings-x").onclick = closeSettings;
    $("settings-modal").onclick = (e) => { if (e.target === $("settings-modal")) closeSettings(); };
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("settings-modal").classList.contains("hidden")) closeSettings(); });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
