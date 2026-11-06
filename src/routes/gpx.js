// ============================================================
// GPX: parseo, métricas, simplificación y exportación de tracks
// ============================================================
// Formato interno de punto (compatible con MTB Camboya):
//   [lat, lon, elevacion, timestamp, pulsaciones, inicioTramo]
//    0    1    2          3          4             5
// inicioTramo = 1 marca el primer punto de un segmento nuevo
// (cambio de trkseg o reanudación tras pausa).

const RADIO_TIERRA = 6371000; // metros
const RAD = Math.PI / 180;

/**
 * Distancia en metros entre dos puntos [lat, lon] (haversine).
 */
export function dist(a, b) {
  const dLat = (b[0] - a[0]) * RAD;
  const dLon = (b[1] - a[1]) * RAD;
  const lat1 = a[0] * RAD;
  const lat2 = b[0] * RAD;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIO_TIERRA * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Rumbo en grados (0 = norte) de a hacia b.
 */
export function bearing(a, b) {
  const lat1 = a[0] * RAD;
  const lat2 = b[0] * RAD;
  const dLon = (b[1] - a[1]) * RAD;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
            Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

// ------------------------------------------------------------
// PARSEO
// ------------------------------------------------------------

function textOf(node, tag) {
  const el = node.getElementsByTagName(tag)[0];
  return el ? el.textContent.trim() : null;
}

/**
 * Parsea un GPX. Devuelve puntos, waypoints y nombre.
 * Lanza Error si el XML no es válido o no contiene track.
 */
export function parseGPX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('El archivo GPX está dañado o no es XML válido.');
  }

  const points = [];
  const segments = doc.getElementsByTagName('trkseg');

  for (let s = 0; s < segments.length; s++) {
    const trkpts = segments[s].getElementsByTagName('trkpt');
    for (let i = 0; i < trkpts.length; i++) {
      const p = trkpts[i];
      const lat = parseFloat(p.getAttribute('lat'));
      const lon = parseFloat(p.getAttribute('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const eleRaw = textOf(p, 'ele');
      const ele = eleRaw !== null ? parseFloat(eleRaw) : null;
      const timeRaw = textOf(p, 'time');
      const time = timeRaw ? Date.parse(timeRaw) : null;

      // Pulsaciones opcionales (extensión gpxtpx:hr)
      let hr = null;
      const hrNode = p.getElementsByTagName('gpxtpx:hr')[0] ||
                     p.getElementsByTagName('hr')[0];
      if (hrNode) hr = parseInt(hrNode.textContent, 10) || null;

      points.push([
        lat, lon,
        Number.isFinite(ele) ? ele : null,
        Number.isFinite(time) ? time : null,
        hr,
        i === 0 ? 1 : 0
      ]);
    }
  }

  // Algunos GPX sólo traen ruta (rte) en lugar de track
  if (!points.length) {
    const rtepts = doc.getElementsByTagName('rtept');
    for (let i = 0; i < rtepts.length; i++) {
      const lat = parseFloat(rtepts[i].getAttribute('lat'));
      const lon = parseFloat(rtepts[i].getAttribute('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const eleRaw = textOf(rtepts[i], 'ele');
      const ele = eleRaw !== null ? parseFloat(eleRaw) : null;
      points.push([lat, lon, Number.isFinite(ele) ? ele : null, null, null, i === 0 ? 1 : 0]);
    }
  }

  if (points.length < 2) {
    throw new Error('El GPX no contiene suficientes puntos de track.');
  }

  // Waypoints (albergues, fuentes, etc. que vengan en el propio GPX)
  const waypoints = [];
  const wpts = doc.getElementsByTagName('wpt');
  for (let i = 0; i < wpts.length; i++) {
    const lat = parseFloat(wpts[i].getAttribute('lat'));
    const lon = parseFloat(wpts[i].getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    waypoints.push({
      lat, lon,
      name: textOf(wpts[i], 'name') || `Punto ${i + 1}`,
      desc: textOf(wpts[i], 'desc') || '',
      sym: textOf(wpts[i], 'sym') || ''
    });
  }

  const name = textOf(doc, 'name') || null;
  return { name, points, waypoints };
}

/**
 * Detecta el formato y parsea GPX, KML o GeoJSON.
 */
export function parseTrack(text, filename = '') {
  const ext = filename.toLowerCase().split('.').pop();
  const head = text.trim().slice(0, 200);

  if (ext === 'gpx' || head.includes('<gpx')) return parseGPX(text);

  if (ext === 'geojson' || ext === 'json' || head.startsWith('{')) {
    return parseGeoJSON(text);
  }
  if (ext === 'kml' || head.includes('<kml')) {
    return parseKML(text);
  }
  // Último intento: XML genérico
  return parseGPX(text);
}

function parseGeoJSON(text) {
  const data = JSON.parse(text);
  const coords = [];

  const pushLine = (line) => {
    line.forEach((c, i) => {
      if (!Array.isArray(c) || c.length < 2) return;
      coords.push([c[1], c[0], c[2] ?? null, null, null, i === 0 ? 1 : 0]);
    });
  };

  const walk = (geom) => {
    if (!geom) return;
    if (geom.type === 'LineString') pushLine(geom.coordinates);
    else if (geom.type === 'MultiLineString') geom.coordinates.forEach(pushLine);
    else if (geom.type === 'GeometryCollection') geom.geometries.forEach(walk);
  };

  if (data.type === 'FeatureCollection') {
    data.features.forEach(f => walk(f.geometry));
  } else if (data.type === 'Feature') {
    walk(data.geometry);
  } else {
    walk(data);
  }

  if (coords.length < 2) throw new Error('El GeoJSON no contiene ninguna línea.');
  return { name: data.name || null, points: coords, waypoints: [] };
}

function parseKML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const blocks = doc.getElementsByTagName('coordinates');
  const points = [];

  for (let b = 0; b < blocks.length; b++) {
    const pairs = blocks[b].textContent.trim().split(/\s+/);
    pairs.forEach((pair, i) => {
      const [lon, lat, ele] = pair.split(',').map(parseFloat);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      points.push([lat, lon, Number.isFinite(ele) ? ele : null, null, null, i === 0 ? 1 : 0]);
    });
  }

  if (points.length < 2) throw new Error('El KML no contiene coordenadas válidas.');
  return { name: textOf(doc, 'name'), points, waypoints: [] };
}

// ------------------------------------------------------------
// MÉTICAS
// ------------------------------------------------------------

/**
 * Calcula distancia acumulada, desnivel y pendientes.
 * El desnivel usa histéresis para no inflarlo con el ruido del GPS.
 *
 * @param {Array} points  puntos en formato interno
 * @param {Number} umbral metros de subida mínima para contabilizar
 * @returns {Object} métricas del track
 */
export function computeMetrics(points, umbral = 3) {
  const cum = new Array(points.length).fill(0);
  const gainCum = new Array(points.length).fill(0);
  const lossCum = new Array(points.length).fill(0);

  let distancia = 0, gain = 0, loss = 0;
  let refEle = points[0]?.[2] ?? null;

  for (let i = 1; i < points.length; i++) {
    distancia += dist(points[i - 1], points[i]);
    cum[i] = distancia;

    const ele = points[i][2];
    if (ele != null && refEle != null) {
      const delta = ele - refEle;
      if (delta >= umbral) { gain += delta; refEle = ele; }
      else if (delta <= -umbral) { loss += -delta; refEle = ele; }
    } else if (ele != null && refEle == null) {
      refEle = ele;
    }

    gainCum[i] = gain;
    lossCum[i] = loss;
  }

  const valid = points.map(p => p[2]).filter(e => e != null);

  return {
    distanciaM: distancia,
    distanciaKm: distancia / 1000,
    desnivelPositivo: Math.round(gain),
    desnivelNegativo: Math.round(loss),
    altitudMin: valid.length ? Math.min(...valid) : null,
    altitudMax: valid.length ? Math.max(...valid) : null,
    tieneElevacion: valid.length > 1,
    cum,        // distancia acumulada (m) por índice de punto
    gainCum,    // desnivel positivo acumulado (m) por índice
    lossCum     // desnivel negativo acumulado (m) por índice
  };
}

/**
 * Pendiente en % entre dos índices del track.
 */
export function slopeBetween(points, cum, i, j) {
  const d = cum[j] - cum[i];
  if (d < 1) return 0;
  const a = points[i][2], b = points[j][2];
  if (a == null || b == null) return 0;
  return ((b - a) / d) * 100;
}

// ------------------------------------------------------------
// SIMPLIFICACIÓN (Ramer–Douglas–Peucker)
// ------------------------------------------------------------
// Un Camino completo puede tener 50.000+ puntos. Simplificar a
// ~5-10 m de tolerancia reduce el coste de CPU/batería sin perder
// precisión útil para navegar en bici.

function perpDist(p, a, b) {
  const k = Math.cos(p[0] * RAD);
  const ax = 0, ay = 0;
  const bx = (b[1] - a[1]) * k * 111320, by = (b[0] - a[0]) * 110540;
  const px = (p[1] - a[1]) * k * 111320, py = (p[0] - a[0]) * 110540;
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px * dx + py * dy) / l2) : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Reduce el número de puntos conservando la forma del trazado.
 * @param {Number} toleranciaM metros de error máximo permitido
 */
export function simplify(points, toleranciaM = 8) {
  if (points.length < 3) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  // Conservar siempre los inicios de tramo
  points.forEach((p, i) => { if (p[5] === 1) keep[i] = 1; });

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = 0, index = -1;
    for (let i = first + 1; i < last; i++) {
      if (keep[i]) continue;
      const d = perpDist(points[i], points[first], points[last]);
      if (d > maxD) { maxD = d; index = i; }
    }
    if (maxD > toleranciaM && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

// ------------------------------------------------------------
// EXPORTACIÓN
// ------------------------------------------------------------

function escapeXML(s) {
  return String(s).replace(/[<>&'"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

/**
 * Genera un GPX 1.1 a partir de puntos en formato interno.
 */
export function toGPX(points, name = 'Camino MTB') {
  const segments = [];
  points.forEach(p => {
    if (p[5] === 1 || !segments.length) segments.push([]);
    segments[segments.length - 1].push(p);
  });

  const body = segments.map(seg =>
    '    <trkseg>\n' + seg.map(p => {
      let s = `      <trkpt lat="${p[0].toFixed(7)}" lon="${p[1].toFixed(7)}">`;
      if (p[2] != null) s += `<ele>${p[2].toFixed(1)}</ele>`;
      if (p[3] != null) s += `<time>${new Date(p[3]).toISOString()}</time>`;
      if (p[4] != null) {
        s += `<extensions><gpxtpx:TrackPointExtension>` +
             `<gpxtpx:hr>${p[4]}</gpxtpx:hr>` +
             `</gpxtpx:TrackPointExtension></extensions>`;
      }
      return s + '</trkpt>';
    }).join('\n') + '\n    </trkseg>'
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Camino MTB"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata><name>${escapeXML(name)}</name></metadata>
  <trk>
    <name>${escapeXML(name)}</name>
${body}
  </trk>
</gpx>`;
}

/**
 * Recorta un subconjunto del track entre dos índices (para etapas).
 */
export function sliceTrack(points, desde, hasta) {
  const slice = points.slice(desde, hasta + 1).map(p => p.slice());
  if (slice.length) slice[0][5] = 1;
  return slice;
}