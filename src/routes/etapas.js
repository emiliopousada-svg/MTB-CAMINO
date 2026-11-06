// ============================================================
// ETAPAS: gestión de etapas del Camino de Santiago
// ============================================================
// Cada etapa es un subconjunto del track completo con sus propios
// puntos, métricas y estado de progreso.

import { DB } from '../core/db.js';
import { appState } from '../core/state.js';
import { computeMetrics, sliceTrack } from './gpx.js';

class EtapasManager {
  constructor() {
    this.caminoId = null;
    this.etapas = [];           // Array de etapas del camino actual
    this.selectedEtapa = null;  // Etapa seleccionada actualmente
    this.etapaPoints = [];      // Puntos de la etapa seleccionada
    this.etapaMetrics = null;   // Métricas de la etapa seleccionada
  }

  /**
   * Carga las etapas de un Camino desde su archivo JSON.
   * 
   * Formato esperado del JSON:
   * {
   *   "etapas": [
   *     {
   *       "numero": 1,
   *       "nombre": "Saint-Jean-Pied-de-Port - Roncesvalles",
   *       "inicio": "Saint-Jean-Pied-de-Port",
   *       "final": "Roncesvalles",
   *       "distanciaKm": 24.5,
   *       "desnivelPositivo": 1250,
   *       "desnivelNegativo": 450,
   *       "dificultad": "media",
   *       "puntoInicio": { "lat": 43.1642, "lon": -1.2386 },
   *       "puntoFinal": { "lat": 43.0345, "lon": -1.3167 },
   *       "indiceInicio": 0,
   *       "indiceFinal": 1245
   *     },
   *     ...
   *   ]
   * }
   * 
   * Los índices (indiceInicio, indiceFinal) se calculan automáticamente
   * si no vienen en el JSON, buscando los puntos más cercanos a las
   * coordenadas de inicio/fin.
   */
  async load(caminoId, archivoEtapas, trackPoints) {
    this.caminoId = caminoId;
    this.etapas = [];
    this.selectedEtapa = null;
    this.etapaPoints = [];
    this.etapaMetrics = null;

    try {
      const response = await fetch(`data/caminos/${archivoEtapas}`);
      if (!response.ok) throw new Error(`No se encontró ${archivoEtapas}`);
      
      const data = await response.json();
      const etapasRaw = data.etapas || [];

      // Calcular índices si no vienen
      for (let i = 0; i < etapasRaw.length; i++) {
        const e = etapasRaw[i];
        
        // Si no tiene índices, buscarlos en el track
        if (e.indiceInicio == null && e.puntoInicio) {
          e.indiceInicio = this._findClosestIndex(
            trackPoints, 
            e.puntoInicio.lat, 
            e.puntoInicio.lon
          );
        }
        if (e.indiceFinal == null && e.puntoFinal) {
          e.indiceFinal = this._findClosestIndex(
            trackPoints, 
            e.puntoFinal.lat, 
            e.puntoFinal.lon
          );
        }

        // Cargar estado desde DB
        const saved = await DB.get('etapas', `${caminoId}-${e.numero}`);
        
        this.etapas.push({
          id: `${caminoId}-${e.numero}`,
          caminoId,
          numero: e.numero,
          nombre: e.nombre || `Etapa ${e.numero}`,
          inicio: e.inicio || '',
          final: e.final || '',
          distanciaKm: e.distanciaKm || 0,
          desnivelPositivo: e.desnivelPositivo || 0,
          desnivelNegativo: e.desnivelNegativo || 0,
          dificultad: e.dificultad || 'media',
          puntoInicio: e.puntoInicio || null,
          puntoFinal: e.puntoFinal || null,
          indiceInicio: e.indiceInicio || 0,
          indiceFinal: e.indiceFinal || trackPoints.length - 1,
          status: saved?.status || 'pending',
          progress: saved?.progress || 0,
          completedAt: saved?.completedAt || null,
          trackPoints: null // Se rellena al seleccionar
        });
      }

      console.log(`✓ ${this.etapas.length} etapas cargadas para ${caminoId}`);
      return this.etapas;
    } catch (error) {
      console.error('Error cargando etapas:', error);
      return [];
    }
  }

  /**
   * Busca el índice del punto del track más cercano a una posición.
   */
  _findClosestIndex(points, lat, lon) {
    let minDist = Infinity;
    let minIndex = 0;
    
    for (let i = 0; i < points.length; i++) {
      const d = Math.hypot(points[i][0] - lat, points[i][1] - lon);
      if (d < minDist) {
        minDist = d;
        minIndex = i;
      }
    }
    
    return minIndex;
  }

  /**
   * Obtiene todas las etapas del camino actual.
   */
  getAll() {
    return this.etapas;
  }

  /**
   * Obtiene una etapa por número.
   */
  getByNumero(numero) {
    return this.etapas.find(e => e.numero === numero) || null;
  }

  /**
   * Selecciona una etapa y extrae sus puntos del track completo.
   * 
   * @param {Number} numero número de etapa
   * @param {Array} trackPoints puntos completos del Camino
   * @returns {Object} etapa seleccionada con puntos y métricas
   */
  select(numero, trackPoints) {
    const etapa = this.getByNumero(numero);
    if (!etapa) {
      console.error(`Etapa no encontrada: ${numero}`);
      return null;
    }

    // Extraer puntos de la etapa
    this.etapaPoints = sliceTrack(
      trackPoints,
      etapa.indiceInicio,
      etapa.indiceFinal
    );

    // Calcular métricas reales
    this.etapaMetrics = computeMetrics(this.etapaPoints);

    // Actualizar etapa con datos reales
    etapa.trackPoints = this.etapaPoints;
    etapa.distanciaKm = this.etapaMetrics.distanciaKm;
    etapa.desnivelPositivo = this.etapaMetrics.desnivelPositivo;
    etapa.desnivelNegativo = this.etapaMetrics.desnivelNegativo;

    this.selectedEtapa = etapa;
    appState.set('selectedStage', etapa);

    console.log(`✓ Etapa ${numero} seleccionada: ${etapa.nombre}`);
    return etapa;
  }

  /**
   * Obtiene la etapa seleccionada actualmente.
   */
  getSelected() {
    return this.selectedEtapa;
  }

  /**
   * Obtiene los puntos de la etapa seleccionada.
   */
  getSelectedPoints() {
    return this.etapaPoints;
  }

  /**
   * Obtiene las métricas de la etapa seleccionada.
   */
  getSelectedMetrics() {
    return this.etapaMetrics;
  }

  /**
   * Marca una etapa como "en progreso".
   */
  async start(numero) {
    const etapa = this.getByNumero(numero);
    if (!etapa) return false;

    etapa.status = 'in_progress';
    etapa.progress = 0;

    await DB.put('etapas', {
      ...etapa,
      updatedAt: Date.now()
    });

    appState.set('currentStageStatus', 'in_progress');
    console.log(`✓ Etapa ${numero} iniciada`);
    return true;
  }

  /**
   * Actualiza el progreso de una etapa (0..1).
   */
  async updateProgress(numero, progress) {
    const etapa = this.getByNumero(numero);
    if (!etapa) return false;

    etapa.progress = Math.max(0, Math.min(1, progress));

    await DB.put('etapas', {
      ...etapa,
      updatedAt: Date.now()
    });

    return true;
  }

  /**
   * Marca una etapa como completada.
   */
  async complete(numero) {
    const etapa = this.getByNumero(numero);
    if (!etapa) return false;

    etapa.status = 'completed';
    etapa.progress = 1;
    etapa.completedAt = Date.now();

    await DB.put('etapas', {
      ...etapa,
      updatedAt: Date.now()
    });

    appState.set('currentStageStatus', 'completed');
    console.log(`✓ Etapa ${numero} completada`);
    return true;
  }

  /**
   * Reinicia una etapa a estado "pending".
   */
  async reset(numero) {
    const etapa = this.getByNumero(numero);
    if (!etapa) return false;

    etapa.status = 'pending';
    etapa.progress = 0;
    etapa.completedAt = null;

    await DB.put('etapas', {
      ...etapa,
      updatedAt: Date.now()
    });

    return true;
  }

  /**
   * Obtiene la siguiente etapa pendiente.
   */
  getNextPending() {
    return this.etapas.find(e => e.status === 'pending') || null;
  }

  /**
   * Obtiene la etapa actualmente en progreso (si existe).
   */
  getInProgress() {
    return this.etapas.find(e => e.status === 'in_progress') || null;
  }

  /**
   * Obtiene estadísticas del camino.
   */
  getStats() {
    const total = this.etapas.length;
    const completed = this.etapas.filter(e => e.status === 'completed').length;
    const inProgress = this.etapas.filter(e => e.status === 'in_progress').length;
    const pending = this.etapas.filter(e => e.status === 'pending').length;

    let distanciaTotal = 0;
    let desnivelTotal = 0;

    this.etapas.forEach(e => {
      distanciaTotal += e.distanciaKm || 0;
      desnivelTotal += e.desnivelPositivo || 0;
    });

    return {
      total,
      completed,
      inProgress,
      pending,
      porcentaje: total ? ((completed / total) * 100).toFixed(1) : 0,
      distanciaTotalKm: distanciaTotal.toFixed(1),
      desnivelTotalM: Math.round(desnivelTotal)
    };
  }

  /**
   * Detecta automáticamente si el ciclista ha completado la etapa actual.
   * Se llama desde el módulo de GPS cuando el progreso llega al 100%.
   */
  async checkCompletion(progress) {
    if (!this.selectedEtapa) return false;
    if (this.selectedEtapa.status === 'completed') return false;

    if (progress >= 0.98) { // 98% para evitar falsos positivos
      await this.complete(this.selectedEtapa.numero);
      return true;
    }

    return false;
  }

  /**
   * Limpia el estado (al cambiar de Camino).
   */
  clear() {
    this.caminoId = null;
    this.etapas = [];
    this.selectedEtapa = null;
    this.etapaPoints = [];
    this.etapaMetrics = null;
  }
}

// Instancia global
export const etapasManager = new EtapasManager();