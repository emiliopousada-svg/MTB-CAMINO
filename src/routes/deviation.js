// ============================================================
// DEVIATION: detección de desvíos del track con histéresis
// ============================================================
// Optimizado para funcionar en segundo plano con bajo consumo.
// Usa una ventana de búsqueda alrededor del último punto aceptado
// para evitar recorrer el track entero en cada actualización GPS.

import { CONFIG } from '../core/config.js';

const RAD = Math.PI / 180;
const DEG_PER_M_LAT = 1 / 110540;        // grados de lat por metro
const DEG_PER_M_LON = (lat) => 1 / (111320 * Math.cos(lat * RAD));

/**
 * Distancia en metros de un punto P al segmento A-B (proyección local).
 * Rápido y suficiente para distancias < 1 km.
 */
function pointSegDistM(p, a, b) {
  const k = Math.cos(p[0] * RAD);
  const ax = (a[1] - p[1]) * k * 111320;
  const ay = (a[0] - p[0]) * 110540;
  const bx = (b[1] - p[1]) * k * 111320;
  const by = (b[0] - p[0]) * 110540;
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * Rumbo en grados (0=norte,