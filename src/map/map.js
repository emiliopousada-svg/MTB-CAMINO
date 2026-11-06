// ============================================================
// MAP: Leaflet, rotación, marcador de posición, integración GPS
// ============================================================
// Implementa:
//   - Inicialización de Leaflet con rotación (leaflet-rotate)
//   - Capas de mapa (IGN España, OpenStreetMap)
//   - Marcador de posición actual con indicador de dirección
//   - Rotación automática del mapa según sentido de marcha
//   - Polilínea del track completo y tramo recorrido
//   - Botón de centrar en posición actual
//   - Integración con gpsManager (eventos de posición)

import { appState } from '../core/state.js';
import { gpsManager } from '../core/gps.js';
import { caminosManager } from '../routes/caminos.js';

class MapManager {
  constructor() {
    this.map = null;
    this.currentLayer = null;      // Capa de mapa base
    this.routeLayer = null;        // Polilínea del track completo
    this.trackedLayer = null;      // Polilínea del tramo recorrido
    this.marker = null;            // Marcador de posición actual
    this.following = true;         // Si el mapa sigue al marcador
    this.lastHeading = null;       // Último rumbo calculado
    this.mapRotation = 0;          // Rotación actual del mapa (grados)
    
    // Configuración
    this.defaultZoom = 15;
    this.minZoom = 10;
    this.maxZoom = 19;
  }

  // ------------------------------------------------------------
  // INICIALIZACIÓN
  // ------------------------------------------------------------

  /**
   * Inicializa el mapa Leaflet.
   * @param {String} containerId ID del elemento DOM donde se renderiza el mapa
   */
  init(containerId = 'map') {
    const container = document.getElementById(containerId);
    if (!container) {
      console.error(`Contenedor de mapa no encontrado: #${containerId}`);
      return;
    }

    // Crear mapa con soporte de rotación
    this.map = L.map(containerId, {
      center: [42.8782, -8.5448], // Santiago de Compostela por defecto
      zoom: this.defaultZoom,
      minZoom: this.minZoom,
      maxZoom: this.maxZoom,
      zoomControl: false,
      rotate: true,               // Habilitar rotación (requiere leaflet-rotate)
      bearing: 0
    });

    // Capa base: IGN España (mapas oficiales, mejor calidad)
    const ignLayer = L.tileLayer('https://www.ign.es/wmts/mapa-raster?layer=MTT&style=default&tilematrixset=GoogleMapsCompatible&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/jpeg&TileMatrix={z}&TileCol={x}&TileRow={y}', {
      attribution: '© Instituto Geográfico Nacional de España',
      maxZoom: this.maxZoom
    });

    // Capa base alternativa: OpenStreetMap
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: this.maxZoom
    });

    this.currentLayer = ignLayer;
    this.currentLayer.addTo(this.map);

    // Capas de rutas
    this.routeLayer = L.polyline([], {
      color: '#2d5016',
      weight: 4,
      opacity: 0.6,
      dashArray: '10, 5'
    }).addTo(this.map);

    this.trackedLayer = L.polyline([], {
      color: '#ff6b35',
      weight: 5,
      opacity: 0.9
    }).addTo(this.map);

    // Marcador de posición actual
    this.marker = L.marker([42.8782, -8.5448], {
      icon: this._createPositionIcon(),
      rotationAngle: 0,
      rotationOrigin: 'center center'
    }).addTo(this.map);

    // Controles
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    // Eventos
    this.map.on('movestart', () => {
      if (this.following) {
        this.following = false;
        this._updateCenterBtn();
      }
    });

    // Suscribirse a eventos del GPS
    gpsManager.on((event, data) => {
      if (event === 'position') {
        this._updatePosition(data);
      }
    });

    console.log('✓ Mapa inicializado');
  }

  /**
   * Crea el icono del marcador de posición actual.
   * Círculo azul con indicador de dirección (triángulo).
   */
  _createPositionIcon() {
    return L.divIcon({
      className: 'position-marker',
      html: `
        <div style="position: relative; width: 40px; height: 40px;">
          <div style="
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 20px;
            height: 20px;
            background: #4285f4;
            border: 3px solid white;
            border-radius: 50%;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          "></div>
          <div class="direction-indicator" style="
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%) rotate(0deg);
            width: 0;
            height: 0;
            border-left: 8px solid transparent;
            border-right: 8px solid transparent;
            border-bottom: 16px solid #4285f4;
            transform-origin: center 20px;
            transition: transform 0.3s ease;
          "></div>
        </div>
      `,
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });
  }

  // ------------------------------------------------------------
  // ACTUALIZACIÓN DE POSICIÓN
  // ------------------------------------------------------------

  /**
   * Actualiza la posición del marcador y opcionalmente rota el mapa.
   */
  _updatePosition(data) {
    const { pos, heading, accuracy } = data;
    if (!pos || !this.map) return;

    const [lat, lon] = pos;

    // Actualizar marcador
    this.marker.setLatLng([lat, lon]);

    // Calcular rumbo si no viene en los datos
    let currentHeading = heading;
    if (currentHeading == null && gpsManager.points.length >= 2) {
      const last = gpsManager.points[gpsManager.points.length - 1];
      const prev = gpsManager.points[gpsManager.points.length - 2];
      currentHeading = this._bearing(prev[0], prev[1], last[0], last[1]);
    }

    // Actualizar indicador de dirección
    if (currentHeading != null) {
      this._updateDirectionIndicator(currentHeading);
      this.lastHeading = currentHeading;
    }

    // Actualizar polilínea del tramo recorrido
    if (gpsManager.points.length > 0) {
      const coords = gpsManager.points.map(p => [p[0], p[1]]);
      this.trackedLayer.setLatLngs(coords);
    }

    // Rotar mapa si estamos siguiendo
    if (this.following && currentHeading != null) {
      this._rotateMap(currentHeading);
    }

    // Centrar mapa si estamos siguiendo
    if (this.following) {
      this.map.panTo([lat, lon], { animate: true, duration: 0.5 });
    }
  }

  /**
   * Actualiza el indicador de dirección del marcador.
   */
  _updateDirectionIndicator(heading) {
    const indicator = this.marker.getElement()?.querySelector('.direction-indicator');
    if (indicator) {
      indicator.style.transform = `translate(-50%, -50%) rotate(${heading}deg)`;
    }
  }

  /**
   * Rota el mapa para que el norte apunte en la dirección opuesta al sentido de marcha.
   * Esto hace que el ciclista siempre vea el camino "hacia arriba".
   */
  _rotateMap(heading) {
    if (!this.map || !this.map.rotate) return;

    // Calcular rotación: si el ciclista va hacia el norte (0°), el mapa no rota.
    // Si va hacia el este (90°), el mapa rota -90° para que el este apunte arriba.
    const targetRotation = -heading;

    // Suavizar la rotación (evitar saltos bruscos de 359° a 1°)
    const delta = targetRotation - this.mapRotation;
    const normalizedDelta = ((delta + 540) % 360) - 180;
    const newRotation = this.mapRotation + normalizedDelta;

    this.mapRotation = newRotation;
    this.map.setBearing(this.mapRotation);
  }

  /**
   * Calcula el rumbo entre dos puntos.
   */
  _bearing(lat1, lon1, lat2, lon2) {
    const RAD = Math.PI / 180;
    const dLon = (lon2 - lon1) * RAD;
    const y = Math.sin(dLon) * Math.cos(lat2 * RAD);
    const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) -
              Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos(dLon);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  // ------------------------------------------------------------
  // RUTAS
  // ------------------------------------------------------------

  /**
   * Muestra el track completo del Camino seleccionado.
   */
  showRoute(trackPoints) {
    if (!trackPoints || trackPoints.length < 2) return;

    const coords = trackPoints.map(p => [p[0], p[1]]);
    this.routeLayer.setLatLngs(coords);

    // Ajustar vista para ver todo el track
    const bounds = this.routeLayer.getBounds();
    if (bounds.isValid()) {
      this.map.fitBounds(bounds, { padding: [50, 50] });
    }

    console.log(`✓ Track mostrado: ${trackPoints.length} puntos`);
  }

  /**
   * Muestra solo el track de la etapa seleccionada.
   */
  showStage(stagePoints) {
    if (!stagePoints || stagePoints.length < 2) return;

    const coords = stagePoints.map(p => [p[0], p[1]]);
    this.routeLayer.setLatLngs(coords);

    const bounds = this.routeLayer.getBounds();
    if (bounds.isValid()) {
      this.map.fitBounds(bounds, { padding: [50, 50] });
    }

    console.log(`✓ Etapa mostrada: ${stagePoints.length} puntos`);
  }

  /**
   * Limpia las rutas del mapa.
   */
  clearRoutes() {
    this.routeLayer.setLatLngs([]);
    this.trackedLayer.setLatLngs([]);
  }

  // ------------------------------------------------------------
  // CONTROLES
  // ------------------------------------------------------------

  /**
   * Activa/desactiva el seguimiento automático del marcador.
   */
  setFollowing(enabled) {
    this.following = enabled;
    this._updateCenterBtn();

    if (enabled && gpsManager.lastPos) {
      this.map.panTo(gpsManager.lastPos, { animate: true });
      if (this.lastHeading != null) {
        this._rotateMap(this.lastHeading);
      }
    }
  }

  /**
   * Actualiza el estado visual del botón de centrar.
   */
  _updateCenterBtn() {
    const btn = document.getElementById('btn-center');
    if (btn) {
      btn.classList.toggle('active', this.following);
    }
  }

  /**
   * Centra el mapa en la posición actual.
   */
  centerOnPosition() {
    if (gpsManager.lastPos) {
      this.map.panTo(gpsManager.lastPos, { animate: true });
      this.setFollowing(true);
    }
  }

  /**
   * Cambia la capa base del mapa.
   */
  setBaseLayer(layerName) {
    if (!this.map) return;

    // Remover capa actual
    if (this.currentLayer) {
      this.map.removeLayer(this.currentLayer);
    }

    // Crear nueva capa
    if (layerName === 'ign') {
      this.currentLayer = L.tileLayer('https://www.ign.es/wmts/mapa-raster?layer=MTT&style=default&tilematrixset=GoogleMapsCompatible&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/jpeg&TileMatrix={z}&TileCol={x}&TileRow={y}', {
        attribution: '© Instituto Geográfico Nacional de España',
        maxZoom: this.maxZoom
      });
    } else if (layerName === 'osm') {
      this.currentLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: this.maxZoom
      });
    }

    this.currentLayer.addTo(this.map);
    console.log(`✓ Capa base cambiada: ${layerName}`);
  }

  /**
   * Invalida el tamaño del mapa (útil tras cambios de layout).
   */
  invalidateSize() {
    if (this.map) {
      this.map.invalidateSize();
    }
  }

  // ------------------------------------------------------------
  // LIMPIEZA
  // ------------------------------------------------------------

  /**
   * Destruye el mapa y libera recursos.
   */
  destroy() {
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.routeLayer = null;
    this.trackedLayer = null;
    this.marker = null;
  }
}

// Instancia global
export const mapManager = new MapManager();