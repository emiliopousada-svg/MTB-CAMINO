/* Contenedor del perfil de elevación */
#elevation-profile {
  width: 100%;
  height: 120px;
  position: relative;
  background: #f5f5f5;
  border-top: 1px solid #ddd;
}

/* Tooltip del perfil */
.elevation-tooltip {
  white-space: nowrap;
}

/* Panel inferior con métricas (opcional) */
.metrics-panel {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: white;
  padding: 15px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  border-top: 1px solid #ddd;
  z-index: 100;
}

.metric-item {
  text-align: center;
}

.metric-value {
  font-size: 24px;
  font-weight: bold;
  color: #2d5016;
}

.metric-label {
  font-size: 12px;
  color: #666;
  margin-top: 4px;
}