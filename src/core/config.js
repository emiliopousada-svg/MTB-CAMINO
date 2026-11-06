// Configuración global de Camino MTB

export const CONFIG = {
  // Umbrales de desvío de ruta (en metros)
  DEVIATION_THRESHOLDS: {
    LOW: 30,
    MEDIUM: 50,
    HIGH: 100
  },
  DEFAULT_DEVIATION_THRESHOLD: 50,
  
  // Umbrales de reincorporación (histéresis)
  BACK_ON_ROUTE_THRESHOLD: 20,
  
  // Filtro de precisión GPS (metros)
  GPS_MIN_ACCURACY: 25,
  
  // Distancia mínima entre puntos del track (metros)
  MIN_POINT_DISTANCE: 5,
  
  // Intervalo de guardado de borrador (ms)
  DRAFT_SAVE_INTERVAL: 10000,
  
  // Intervalo de polling de batería (ms)
  BATTERY_POLL_INTERVAL: 60000,
  
  // Umbrales de batería
  BATTERY_WARNING_LOW: 20,
  BATTERY_WARNING_CRITICAL: 10,
  
  // Tipos de actividad
  ACTIVITY_TYPES: {
    mtb: { icon: '🚵', label: 'MTB' },
    gravel: { icon: '🚴', label: 'Gravel' },
    cycling: { icon: '🚲', label: 'Ciclismo' }
  },
  
  // Claves de localStorage
  STORAGE_KEYS: {
    SELECTED_CAMINO: 'camino_selected',
    SELECTED_STAGE: 'camino_stage',
    DEVIATION_THRESHOLD: 'camino_deviation',
    THEME: 'camino_theme',
    SOUND_ENABLED: 'camino_sound',
    VIBRATION_ENABLED: 'camino_vibration'
  }
};