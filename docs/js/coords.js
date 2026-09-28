/* Coordinate conversion WGS-84 <-> GCJ-02 (same math as the Python backend).
 * AMap/AutoNavi basemap & tiles use GCJ-02, while our data & GPS are WGS-84.
 * We keep all app logic in WGS-84 and only convert at the map-display boundary. */
(function () {
  const PI = Math.PI;
  function outOfChina(lng, lat) {
    return !(lng > 72.004 && lng < 137.8347 && lat > 0.8293 && lat < 55.8271);
  }
  function tLat(x, y) {
    let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
    r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
    r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
    return r;
  }
  function tLng(x, y) {
    let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
    r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
    r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
    return r;
  }
  function wgs84ToGcj02(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    let dLat = tLat(lng - 105, lat - 35);
    let dLng = tLng(lng - 105, lat - 35);
    const radLat = (lat / 180) * PI;
    const magic = Math.sin(radLat);
    const m2 = 1 - 0.00669342162296594323 * magic * magic;
    const sqrtMagic = Math.sqrt(m2);
    dLat = (dLat * 180) / ((6378245 * (1 - 0.00669342162296594323)) / (m2 * sqrtMagic) * PI);
    dLng = (dLng * 180) / (6378245 / sqrtMagic * Math.cos(radLat) * PI);
    return [lng + dLng, lat + dLat];
  }
  function gcj02ToWgs84(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    let wlng = lng, wlat = lat;
    for (let i = 0; i < 5; i++) {
      const g = wgs84ToGcj02(wlng, wlat);
      const dLng = g[0] - lng;
      const dLat = g[1] - lat;
      if (Math.abs(dLng) < 1e-10 && Math.abs(dLat) < 1e-10) break;
      wlng -= dLng;
      wlat -= dLat;
    }
    return [wlng, wlat];
  }
  window.wgs84ToGcj02 = wgs84ToGcj02;
  window.gcj02ToWgs84 = gcj02ToWgs84;
})();
