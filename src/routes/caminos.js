// ============================================================
// CAMINOS: gestión del catálogo y selección de Caminos de Santiago
// ============================================================
// Este módulo orquesta: catálogo → track GPX → etapas → detector de desvíos

import { DB } from '../core/db.js';
import { appState } from '../core/state.js';
import { CONFIG } from '../core/config.js';
import { parseTrack, computeMetrics, simplify } from './gpx.js';
import { etapasManager } from './etapas.js';
import { deviationDetector } from './deviation.js';

class CaminosManager {
  constructor() {
    this.caminos = [];              // Catálogo completo
    this.selectedCamino = null;     // Camino seleccionado actualmente
    this.trackPoints = [];          // Puntos del track (simplificados)
    this.trackPointsRaw = [];       // Puntos del track (completos, sin simplificar)
    this.trackMetrics = null;       // Métricas del track completo
  }

  // ------------------------------------------------------------
  // CATÁLOGO
  // ------------------------------------------------------------

  /**
   * Carga el catálogo de Caminos desde data/caminos/index.json
   */
  async loadCatalog() {
    try {
      const response = await fetch('data/caminos/index.json');
      if (!response.ok) throw new Error('No se pudo cargar el catálogo de caminos');
      
      const data = await response.json();
      this.caminos = data.caminos || [];
      
      console.log(`✓ Catálogo cargado: ${this.caminos.length} caminos`);
      return this.caminos;
    } catch (error) {
      console.error('Error cargando catálogo de caminos:', error);
      return [];
    }
  }

  /**
   * Obtiene todos los caminos del catálogo.
   */
  getAll() {
    return this.caminos;
  }

  /**
   * Obtiene un camino por su ID.
   */
  getById(id) {
    return this.caminos.find(c => c.id === id) || null;
  }

  /**
   * Filtra caminos por dificultad.
   */
  filterByDifficulty(dificultad) {
    return this.caminos.filter(c => c.dificultad === dificultad);
  }

  /**
   * Ordena caminos por distancia.
   */
  sortByDistance(ascending = true) {
    return [...this.caminos].sort((a, b) => {
      return ascending 
        ? a.distanciaTotalKm - b.distanciaTotalKm
        : b.distanciaTotalKm - a.distanciaTotalKm;
    });
  }

  /**
   * Busca caminos por nombre, descripción, inicio o final.
   */
  search(query) {
    const lowerQuery = query.toLowerCase();
    return this.caminos.filter(c => 
      c.nombre.toLowerCase().includes(lowerQuery) ||
      c.descripcion.toLowerCase().includes(lowerQuery) ||
      c.inicio.toLowerCase().includes(lowerQuery) ||
      c.final.toLowerCase().includes(lowerQuery)
    );
  }

  // ------------------------------------------------------------
  // SELECCIÓN Y CARGA DE TRACK
  // ------------------------------------------------------------

  /**
   * Selecciona un Camino y carga su track GPX.
   * 
   * @param {String} caminoId ID del camino
   * @returns {Object} camino seleccionado con track y métricas
   */
  async select(caminoId) {
    const camino = this.getById(caminoId);
    if (!camino) {
      console.error(`Camino no encontrado: ${caminoId}`);
      return null;
    }

    this.selectedCamino = camino;
    appState.set('selectedCamino', camino);

    // Guardar selección en localStorage
    try {
      localStorage.setItem(CONFIG.STORAGE_KEYS.SELECTED_CAMINO, caminoId);
    } catch (error) {
      console.warn('No se pudo guardar la selección:', error);
    }

    // Cargar track GPX
    try {
      const response = await fetch(`data/caminos/${camino.archivoTrack}`);
      if (!response.ok) throw new Error(`No se encontró ${camino.archivoTrack}`);
      
      const gpxText = await response.text();
      const parsed = parseTrack(gpxText, camino.archivoTrack);
      
      this.trackPointsRaw = parsed.points;
      this.trackPoints = simplify(parsed.points, 8); // Simplificar a 8m de tolerancia
      this.trackMetrics = computeMetrics(this.trackPoints);

      console.log(`✓ Track cargado: ${this.trackPoints.length} puntos (${this.trackPointsRaw.length} originales)`);
      console.log(`  Distancia: ${this.trackMetrics.distanciaKm.toFixed(1)} km`);
      console.log(`  Desnivel +: ${this.trackMetrics.desnivelPositivo} m`);
      console.log(`  Desnivel -: ${this.trackMetrics.desnivelNegativo} m`);

      // Cargar etapas
      await etapasManager.load(caminoId, camino.archivoEtapas, this.trackPoints);

      // Configurar detector de desvíos
      deviationDetector.setTrack(this.trackPoints);
      const threshold = parseInt(localStorage.getItem(CONFIG.STORAGE_KEYS.DEVIATION_THRESHOLD)) || CONFIG.DEFAULT_DEVIATION_THRESHOLD;
      deviationDetector.setThreshold(threshold);

      return {
        ...camino,
        trackPoints: this.trackPoints,
        metrics: this.trackMetrics,
        etapas: etapasManager.getAll()
      };
    } catch (error) {
      console.error('Error cargando track del camino:', error);
      return null;
    }
  }

  /**
   * Restaura el Camino seleccionado previamente.
   */
  async restoreSelection() {
    try {
      const savedId = localStorage.getItem(CONFIG.STORAGE_KEYS.SELECTED_CAMINO);
      if (savedId && this.getById(savedId)) {
        return await this.select(savedId);
      }
    } catch (error) {
      console.warn('No se pudo restaurar la selección:', error);
    }
    return null;
  }

  /**
   * Obtiene el Camino seleccionado actualmente.
   */
  getSelected() {
    return this.selectedCamino;
  }

  /**
   * Obtiene los puntos del track (simplificados).
   */
  getTrackPoints() {
    return this.trackPoints;
  }

  /**
   * Obtiene los puntos del track (completos, sin simplificar).
   */
  getTrackPointsRaw() {
    return this.trackPointsRaw;
  }

  /**
   * Obtiene las métricas del track completo.
   */
  getTrackMetrics() {
    return this.trackMetrics;
  }

  // ------------------------------------------------------------
  // PROGRESO Y ESTADÍSTICAS
  // ------------------------------------------------------------

  /**
   * Obtiene el progreso del Camino (etapas completadas).
   */
  async getProgress(caminoId = null) {
    const id = caminoId || this.selectedCamino?.id;
    if (!id) return { total: 0, completed: 0, percentage: '0' };

    try {
      const etapas = await DB.getByIndex('etapas', 'caminoId', id);
      const completed = etapas.filter(e => e.status === 'completed');
      const camino = this.getById(id);
      
      return {
        total: camino?.numEtapas || etapas.length,
        completed: completed.length,
        percentage: ((completed.length / (camino?.numEtapas || etapas.length || 1)) * 100).toFixed(1)
      };
    } catch (error) {
      console.error('Error obteniendo progreso:', error);
      return { total: 0, completed: 0, percentage: '0' };
    }
  }

  /**
   * Obtiene información detallada del Camino.
   */
  async getDetails(caminoId = null) {
    const id = caminoId || this.selectedCamino?.id;
    const camino = this.getById(id);
    if (!camino) return null;

    const progress = await this.getProgress(id);
    
    return {
      ...camino,
      progress,
      trackLoaded: this.selectedCamino?.id === id && this.trackPoints.length > 0,
      metrics: this.selectedCamino?.id === id ? this.trackMetrics : null
    };
  }

  /**
   * Obtiene estadísticas completas del Camino seleccionado.
   */
  getStats() {
    if (!this.selectedCamino || !this.trackMetrics) return null;

    const etapaStats = etapasManager.getStats();

    return {
      camino: this.selectedCamino,
      track: this.trackMetrics,
      etapas: etapaStats
    };
  }

  // ------------------------------------------------------------
  // CONFIGURACIÓN
  // ------------------------------------------------------------

  /**
   * Cambia el umbral de desvío (30, 50 o 100 metros).
   */
  setDeviationThreshold(meters) {
    deviationDetector.setThreshold(meters);
    try {
      localStorage.setItem(CONFIG.STORAGE_KEYS.DEVIATION_THRESHOLD, String(meters));
    } catch (error) {
      console.warn('No se pudo guardar el umbral:', error);
    }
    console.log(`✓ Umbral de desvío: ${meters} m`);
  }

  /**
   * Obtiene el umbral de desvío actual.
   */
  getDeviationThreshold() {
    return deviationDetector.threshold;
  }

  // ------------------------------------------------------------
  // LIMPIEZA
  // ------------------------------------------------------------

  /**
   * Limpia el estado (al cambiar de Camino o cerrar la app).
   */
  clear() {
    this.selectedCamino = null;
    this.trackPoints = [];
    this.trackPointsRaw = [];
    this.trackMetrics = null;
    etapasManager.clear();
    deviationDetector.reset();
  }
}

// Instancia global
export const caminosManager = new CaminosManager();