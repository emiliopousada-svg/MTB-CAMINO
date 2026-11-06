// ============================================================
// GPS: seguimiento en primer/segundo plano, wake lock, batería
// ============================================================
// Integra:
//   - geolocation.watchPosition (primer plano)
//   - @capacitor-community/background-geolocation (segundo plano)
//   - Wake Lock API (pantalla encendida)
//   - Battery API (avisos de batería baja)
//   - deviationDetector (alertas de desvío)
//   - etapasManager (progreso y final de etapa)
//   - IndexedDB (borrador persistente)

import { appState } from './state.js';
import { CONFIG } from './config.js';
import { DB } from './db.js';
import { deviationDetector } from '../routes/deviation.js';
import { etapasManager } from '../routes/etapas.js';

const RAD = Math.PI / 180;

// ------------------------------------------------------------
// UTILIDADES
// ------------------------------------------------------------

function distM(a, b) {
  const k = Math.cos(((a[0] + b[0]) / 2) * RAD);
  const dx = (b[1] - a[1]) * k * 111320;
  const dy = (b[0] - a[0]) * 110540;
  return Math.hypot(dx, dy);
}

function speedKmh(metersPerSec) {
  return (metersPerSec || 0) * 3.6;
}

function fmtClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ------------------------------------------------------------
// GPS MANAGER
// ------------------------------------------------------------

class GPSManager {
  constructor() {
    this.reset();
  }

  reset() {
    // Estado interno
    this.isTracking = false;
    this.isPaused = false;
    this.watchId = null;
    this.bgWatcherId = null;
    this.bgPlugin = null;
    this.wakeLock = null;

    // Última posición aceptada
    this.lastPos = null;          // [lat, lon]
    this.lastTimestamp = null;

    // Métricas de la sesión
    this.points = [];             // puntos grabados (formato interno)
    this.segments = [];           // segmentos (para polilíneas con pausas)
    this.movingMs = 0;            // tiempo en movimiento (ms)
    this.segStart = null;         // timestamp del inicio del segmento actual
    this.startedAt = null;        // timestamp de inicio de la sesión
    this.totalDistanceM = 0;
    this.elevationGain = 0;
    this.elevationLoss = 0;
    this.refEle = null;           // altitud de referencia para histéresis

    // Batería
    this.batteryApi = null;
    this.batteryWarnings = new Set();

    // Audio (alertas sonoras)
    this.audioCtx = null;

    // Token para invalidar callbacks obsoletos
    this._token = 0;
    this._bgToken = 0;

    // Suscriptores externos (UI, etc.)
    this._listeners = new Set();
  }

  // ------------------------------------------------------------
  // SUSCRIPCIONES (Pub/Sub simple)
  // ------------------------------------------------------------

  /**
   * Suscribirse a eventos del GPS.
   * Eventos: 'position', 'metrics', 'deviation', 'stage-complete', 'battery-warning'
   */
  on(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  _emit(event, data) {
    this._listeners.forEach(cb => {
      try { cb(event, data); } catch (e) { console.error('GPS listener error:', e); }
    });
  }

  // ------------------------------------------------------------
  // INICIALIZACIÓN
  // ------------------------------------------------------------

  /**
   * Inicializa el GPS: pide permisos, detecta plugin de fondo, etc.
   * Llamar UNA VEZ al arrancar la app.
   */
  async init() {
    // Detectar plugin de background geolocation (Capacitor)
    try {
      const cap = window.Capacitor;
      if (cap?.Plugins?.BackgroundGeolocation) {
        this.bgPlugin = cap.Plugins.BackgroundGeolocation;
        console.log('✓ BackgroundGeolocation disponible');
      }
    } catch (e) {
      console.warn('BackgroundGeolocation no disponible:', e);
    }

    // Pedir permisos de ubicación básicos
    try {
      if (navigator.geolocation) {
        await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 });
        });
        console.log('✓ Permiso de ubicación concedido');
      }
    } catch (e) {
      console.warn('Permiso de ubicación denegado o no disponible:', e);
    }

    // Inicializar AudioContext (para alertas sonoras)
    this._initAudio();
  }

  _initAudio() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try {
      this.audioCtx = new Ctor();
    } catch (e) {
      console.warn('AudioContext no disponible:', e);
    }
  }

  _resumeAudio() {
    if (this.audioCtx?.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  // ------------------------------------------------------------
  // SEGUIMIENTO
  // ------------------------------------------------------------

  /**
   * Inicia el seguimiento GPS.
   * Intenta primero el modo background; si falla, usa primer plano con wake lock.
   */
  async startTracking() {
    if (this.isTracking) return;

    this._token++;
    this.reset();
    this.isTracking = true;
    this.isPaused = false;
    this.startedAt = Date.now();
    this.segStart = Date.now();
    this._resumeAudio();

    appState.startRecording();

    // Intentar background geolocation
    const bgOk = await this._startBgWatcher();
    if (bgOk) {
      this._emit('tracking-started', { mode: 'background' });
      return;
    }

    // Fallback: primer plano con wake lock
    await this._acquireWakeLock();
    this._startForegroundWatcher();
    this._emit('tracking-started', { mode: 'foreground' });
  }

  /**
   * Pausa el seguimiento (conserva posición y progreso).
   */
  pauseTracking() {
    if (!this.isTracking || this.isPaused) return;

    if (this.segStart) {
      this.movingMs += Date.now() - this.segStart;
      this.segStart = null;
    }
    this.isPaused = true;
    appState.pauseRecording();

    this._stopBgWatcher();
    this._stopForegroundWatcher();
    this._releaseWakeLock();

    this._saveDraft();
    this._emit('tracking-paused');
  }

  /**
   * Reanuda el seguimiento desde donde se pausó.
   */
  async resumeTracking() {
    if (!this.isTracking || !this.isPaused) return;

    this.isPaused = false;
    this.segStart = Date.now();
    appState.resumeRecording();

    // Forzar nuevo segmento (el primer punto tras pausa abre tramo)
    this._forceNewSegment = true;

    const bgOk = await this._startBgWatcher();
    if (!bgOk) {
      await this._acquireWakeLock();
      this._startForegroundWatcher();
    }

    this._emit('tracking-resumed');
  }

  /**
   * Detiene el seguimiento y devuelve los datos de la sesión.
   */
  stopTracking() {
    if (!this.isTracking) return null;

    if (this.segStart) {
      this.movingMs += Date.now() - this.segStart;
      this.segStart = null;
    }

    this._stopBgWatcher();
    this._stopForegroundWatcher();
    this._releaseWakeLock();

    this.isTracking = false;
    this.isPaused = false;
    appState.stopRecording();

    // Borrar borrador
    DB.kvDel('gps_draft').catch(() => {});

    const session = {
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      movingTimeSec: Math.round(this.movingMs / 1000),
      totalTimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      distanceKm: this.totalDistanceM / 1000,
      elevationGain: Math.round(this.elevationGain),
      elevationLoss: Math.round(this.elevationLoss),
      points: this.points,
      segments: this.segments
    };

    this._emit('tracking-stopped', session);
    return session;
  }

  // ------------------------------------------------------------
  // WATCHERS (foreground y background)
  // ------------------------------------------------------------

  _startForegroundWatcher() {
    if (!navigator.geolocation) return;
    if (this.watchId != null) return;

    this.watchId = navigator.geolocation.watchPosition(
      pos => this._onPosition({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        altitude: pos.coords.altitude,
        speed: pos.coords.speed,
        heading: pos.coords.heading,
        time: pos.timestamp
      }),
      err => console.warn('GPS foreground error:', err),
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20000
      }
    );
  }

  _stopForegroundWatcher() {
    if (this.watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  async _startBgWatcher() {
    if (!this.bgPlugin) return false;

    const myToken = ++this._bgToken;
    try {
      const id = await this.bgPlugin.addWatcher({
        backgroundTitle: 'Camino MTB',
        backgroundMessage: 'Grabando tu etapa...',
        requestPermissions: true,
        stale: false,
        distanceFilter: 2,
        interval: 5000
      }, (loc, err) => {
        if (myToken !== this._bgToken) return;
        if (err) {
          console.warn('BG GPS error:', err);
          return;
        }
        if (!loc) return;
        this._onPosition({
          latitude: loc.latitude,
          longitude: loc.longitude,
          accuracy: loc.accuracy,
          altitude: loc.altitude,
          speed: loc.speed,
          heading: loc.heading ?? loc.bearing,
          time: loc.time
        });
      });

      if (myToken !== this._bgToken) {
        try { await this.bgPlugin.removeWatcher({ id }); } catch (e) {}
        return false;
      }

      this.bgWatcherId = id;
      return true;
    } catch (e) {
      console.warn('No se pudo iniciar GPS en segundo plano:', e);
      if (myToken === this._bgToken) this.bgWatcherId = null;
      return false;
    }
  }

  _stopBgWatcher() {
    if (!this.bgPlugin || this.bgWatcherId == null) return;
    const id = this.bgWatcherId;
    this._bgToken++;
    this.bgWatcherId = null;
    this.bgPlugin.removeWatcher({ id }).catch(() => {});
  }

  // ------------------------------------------------------------
  // PROCESAMIENTO DE POSICIONES
  // ------------------------------------------------------------

  _onPosition(loc) {
    if (!this.isTracking || this.isPaused) return;
    const token = this._token;

    const { latitude: lat, longitude: lon, accuracy, altitude, speed, heading, time } = loc;

    // Validación básica
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (accuracy != null && accuracy > CONFIG.GPS_MIN_ACCURACY * 2) return; // descartar muy malos

    const pos = [lat, lon];
    const timestamp = time || Date.now();

    // Calcular distancia desde el último punto
    let deltaM = 0;
    if (this.lastPos) {
      deltaM = distM(this.lastPos, pos);
    }

    // Filtro de distancia mínima (evita ruido cuando está parado)
    const minDist = this.lastPos ? CONFIG.MIN_POINT_DISTANCE : 0;
    if (deltaM < minDist && this.lastPos) {
      // No actualizar nada, pero sí emitir métricas por si cambió la velocidad
      this._emitMetrics();
      return;
    }

    // Crear punto en formato interno
    const newSegment = !this.lastPos || this._forceNewSegment;
    this._forceNewSegment = false;

    const point = [
      lat,
      lon,
      Number.isFinite(altitude) ? altitude : null,
      timestamp,
      null, // hr (pulsaciones, se rellenará con BLE si hay sensor)
      newSegment ? 1 : 0
    ];

    // Actualizar estado
    this.points.push(point);
    if (newSegment) this.segments.push([point]);
    else this.segments[this.segments.length - 1].push(point);

    this.totalDistanceM += deltaM;
    this.lastPos = pos;
    this.lastTimestamp = timestamp;

    // Desnivel con histéresis
    if (altitude != null) {
      if (this.refEle == null) {
        this.refEle = altitude;
      } else {
        const delta = altitude - this.refEle;
        if (delta >= 3) { this.elevationGain += delta; this.refEle = altitude; }
        else if (delta <= -3) { this.elevationLoss += -delta; this.refEle = altitude; }
      }
    }

    // Detector de desvíos
    const deviation = deviationDetector.check(lat, lon, accuracy);
    if (deviation.event) {
      this._emit('deviation', deviation);
      if (deviation.event === 'off-route') this._playOffRouteSound();
      else if (deviation.event === 'back-on-route') this._playBackOnRouteSound();
    }

    // Actualizar progreso de etapa
    const progress = deviationDetector.getProgress();
    etapasManager.updateProgress(
      etapasManager.getSelected()?.numero,
      progress
    ).then(async completed => {
      if (await etapasManager.checkCompletion(progress)) {
        this._emit('stage-complete', etapasManager.getSelected());
      }
    });

    // Emitir eventos
    this._emit('position', {
      pos,
      altitude,
      speed,
      heading,
      accuracy,
      timestamp,
      deltaM,
      deviation
    });

    this._emitMetrics();

    // Guardar borrador periódicamente
    if (this.points.length % 10 === 0) this._saveDraft();
  }

  _emitMetrics() {
    const movingMs = this.movingMs + (this.segStart ? Date.now() - this.segStart : 0);
    const movingSec = movingMs / 1000;
    const totalSec = this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;

    // Velocidad instantánea (últimos 5 puntos)
    let currentSpeed = 0;
    if (this.points.length >= 2) {
      const last = this.points[this.points.length - 1];
      const prev = this.points[Math.max(0, this.points.length - 5)];
      const dt = (last[3] - prev[3]) / 1000;
      if (dt > 0) {
        const d = distM([prev[0], prev[1]], [last[0], last[1]]);
        currentSpeed = speedKmh(d / dt);
      }
    }

    const avgSpeed = movingSec > 0 ? speedKmh(this.totalDistanceM / movingSec) : 0;
    const distanceRemaining = deviationDetector.getDistanceRemaining();

    const metrics = {
      distanceKm: this.totalDistanceM / 1000,
      distanceRemainingKm: distanceRemaining / 1000,
      elevationGain: Math.round(this.elevationGain),
      elevationLoss: Math.round(this.elevationLoss),
      movingTimeSec: Math.round(movingSec),
      totalTimeSec: Math.round(totalSec),
      movingTimeStr: fmtClock(Math.round(movingSec)),
      totalTimeStr: fmtClock(Math.round(totalSec)),
      currentSpeed: Math.round(currentSpeed * 10) / 10,
      avgSpeed: Math.round(avgSpeed * 10) / 10,
      pointsCount: this.points.length,
      progress: deviationDetector.getProgress()
    };

    this._emit('metrics', metrics);
  }

  // ------------------------------------------------------------
  // WAKE LOCK
  // ------------------------------------------------------------

  async _acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        console.log('Wake lock liberado');
      });
      console.log('✓ Wake lock activo');
    } catch (e) {
      console.warn('No se pudo activar wake lock:', e);
    }
  }

  _releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  // Re-adquirir wake lock al volver a primer plano
  _handleVisibility() {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && this.isTracking && !this.isPaused) {
        if (!this.bgWatcherId) await this._acquireWakeLock();
      } else if (document.visibilityState === 'hidden' && this.isTracking) {
        this._saveDraft();
      }
    });
  }

  // ------------------------------------------------------------
  // BORRADOR (persistencia)
  // ------------------------------------------------------------

  async _saveDraft() {
    if (!this.isTracking) return;
    try {
      await DB.kvSet('gps_draft', {
        startedAt: this.startedAt,
        movingMs: this.movingMs + (this.segStart ? Date.now() - this.segStart : 0),
        totalDistanceM: this.totalDistanceM,
        elevationGain: this.elevationGain,
        elevationLoss: this.elevationLoss,
        points: this.points,
        segments: this.segments,
        lastPos: this.lastPos,
        caminoId: appState.get('selectedCamino')?.id,
        etapaNumero: appState.get('selectedStage')?.numero,
        savedAt: Date.now()
      });
    } catch (e) {
      console.warn('No se pudo guardar borrador:', e);
    }
  }

  /**
   * Comprueba si hay un borrador pendiente y pregunta al usuario si recuperarlo.
   * Llamar al iniciar la app.
   */
  async checkDraft() {
    try {
      const draft = await DB.kvGet('gps_draft');
      if (!draft || !Array.isArray(draft.points) || draft.points.length === 0) return null;
      return draft;
    } catch (e) {
      return null;
    }
  }

  /**
   * Restaura una sesión desde un borrador.
   */
  async restoreDraft(draft) {
    this.reset();
    this.isTracking = true;
    this.isPaused = true;
    this.startedAt = draft.startedAt;
    this.movingMs = draft.movingMs || 0;
    this.totalDistanceM = draft.totalDistanceM || 0;
    this.elevationGain = draft.elevationGain || 0;
    this.elevationLoss = draft.elevationLoss || 0;
    this.points = draft.points || [];
    this.segments = draft.segments || [];
    this.lastPos = draft.lastPos;
    this._forceNewSegment = true;

    appState.set('isRecording', true);
    appState.set('isPaused', true);

    this._emit('draft-restored', draft);
    return true;
  }

  // ------------------------------------------------------------
  // BATERÍA
  // ------------------------------------------------------------

  async initBattery() {
    if (!navigator.getBattery) return;
    try {
      this.batteryApi = await navigator.getBattery();
      this.batteryApi.addEventListener('levelchange', () => this._checkBattery());
      this.batteryApi.addEventListener('chargingchange', () => this._checkBattery());
      this._checkBattery();
    } catch (e) {
      console.warn('Battery API no disponible:', e);
    }
  }

  _checkBattery() {
    if (!this.batteryApi) return;
    const level = Math.round(this.batteryApi.level * 100);
    const charging = this.batteryApi.charging;

    this._emit('battery', { level, charging });

    if (charging) return;

    if (level <= CONFIG.BATTERY_WARNING_CRITICAL && !this.batteryWarnings.has(10)) {
      this.batteryWarnings.add(10);
      this.batteryWarnings.add(20);
      this._emit('battery-warning', { level, critical: true });
    } else if (level <= CONFIG.BATTERY_WARNING_LOW && !this.batteryWarnings.has(20)) {
      this.batteryWarnings.add(20);
      this._emit('battery-warning', { level, critical: false });
    }
  }

  // ------------------------------------------------------------
  // SONIDOS
  // ------------------------------------------------------------

  _playTone(frequencies) {
    if (!this.audioCtx || this.audioCtx.state !== 'running') return;
    if (localStorage.getItem(CONFIG.STORAGE_KEYS.SOUND_ENABLED) === '0') return;

    const start = this.audioCtx.currentTime;
    frequencies.forEach((freq, i) => {
      const at = start + i * 0.22;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start(at);
      osc.stop(at + 0.17);
    });
  }

  _playOffRouteSound() {
    this._playTone([880, 660]);
    if (localStorage.getItem(CONFIG.STORAGE_KEYS.VIBRATION_ENABLED) !== '0') {
      navigator.vibrate?.([200, 100, 200]);
    }
  }

  _playBackOnRouteSound() {
    this._playTone([660, 880, 1040]);
  }
}

// Instancia global
export const gpsManager = new GPSManager();