import { CONFIG } from '../core/config.js';

const RAD = Math.PI / 180;

function distM(a, b) {
  const lat = ((a[0] + b[0]) / 2) * RAD;
  const dx = (b[1] - a[1]) * Math.cos(lat) * 111320;
  const dy = (b[0] - a[0]) * 110540;
  return Math.hypot(dx, dy);
}

function pointSegDistM(p, a, b) {
  const lat = p[0] * RAD;
  const ax = (a[1] - p[1]) * Math.cos(lat) * 111320;
  const ay = (a[0] - p[0]) * 110540;
  const bx = (b[1] - p[1]) * Math.cos(lat) * 111320;
  const by = (b[0] - p[0]) * 110540;

  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;

  let t = 0;
  if (l2 > 0) {
    t = -(ax * dx + ay * dy) / l2;
    t = Math.max(0, Math.min(1, t));
  }

  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(x, y);
}

function bearingDeg(a, b) {
  const lat1 = a[0] * RAD;
  const lat2 = b[0] * RAD;
  const dLon = (b[1] - a[1]) * RAD;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export class DeviationDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.track = null;
    this.threshold = CONFIG.DEFAULT_DEVIATION_THRESHOLD || 50;
    this.backThreshold = CONFIG.BACK_ON_ROUTE_THRESHOLD || 20;
    this.isOffRoute = false;
    this.lastAcceptedIndex = 0;
    this.lastAcceptedPos = null;
    this.lastDistance = 0;
  }

  setTrack(points) {
    this.track = Array.isArray(points) ? points : null;
    this.lastAcceptedIndex = 0;
    this.lastAcceptedPos = null;
    this.lastDistance = 0;
    this.isOffRoute = false;

    if (this.track && this.track.length > 0) {
      this.lastAcceptedPos = [this.track[0][0], this.track[0][1]];
    }
  }

  setThreshold(meters) {
    const value = Number(meters);
    this.threshold = Number.isFinite(value) && value > 0 ? value : 50;
    this.backThreshold = Math.max(5, this.threshold * 0.4);
  }

  _findNearest(lat, lon) {
    const track = this.track;
    if (!track || track.length < 2) return null;

    const p = [lat, lon];

    let bestSegDist = Infinity;
    let bestSegIndex = 0;
    let bestPointDist = Infinity;
    let bestPointIndex = 0;

    for (let i = 0; i < track.length - 1; i++) {
      const d = pointSegDistM(p, track[i], track[i + 1]);
      if (d < bestSegDist) {
        bestSegDist = d;
        bestSegIndex = i;
      }
    }

    for (let i = 0; i < track.length; i++) {
      const d = distM(p, track[i]);
      if (d < bestPointDist) {
        bestPointDist = d;
        bestPointIndex = i;
      }
    }

    let backIndex = Math.max(bestSegIndex + 1, bestPointIndex);
    backIndex = Math.max(backIndex, this.lastAcceptedIndex);
    backIndex = Math.min(backIndex, track.length - 1);

    return {
      index: bestSegIndex,
      pointIndex: bestPointIndex,
      backIndex: backIndex,
      segmentDist: bestSegDist,
      pointDist: bestPointDist
    };
  }

  check(lat, lon, accuracy) {
    if (accuracy === undefined) accuracy = null;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return {
        onTrack: !this.isOffRoute,
        distanceM: this.lastDistance,
        nearestIndex: this.lastAcceptedIndex,
        returnBearing: null,
        returnPoint: null,
        filteredOut: true,
        progress: this.getProgress(),
        event: null
      };
    }

    if (!this.track || this.track.length < 2) {
      return {
        onTrack: true,
        distanceM: 0,
        nearestIndex: 0,
        returnBearing: null,
        returnPoint: null,
        filteredOut: false,
        progress: 0,
        event: null
      };
    }

    const maxAccuracy = (CONFIG.GPS_MIN_ACCURACY || 25) * 2;

    if (accuracy != null && accuracy > maxAccuracy) {
      return {
        onTrack: !this.isOffRoute,
        distanceM: Math.round(this.lastDistance),
        nearestIndex: this.lastAcceptedIndex,
        returnBearing: null,
        returnPoint: null,
        filteredOut: true,
        progress: this.getProgress(),
        event: null
      };
    }

    const nearest = this._findNearest(lat, lon);
    if (!nearest) {
      return {
        onTrack: true,
        distanceM: 0,
        nearestIndex: 0,
        returnBearing: null,
        returnPoint: null,
        filteredOut: false,
        progress: 0,
        event: null
      };
    }

    const d = nearest.segmentDist;
    this.lastDistance = d;

    const wasOffRoute = this.isOffRoute;
    let newState = this.isOffRoute;

    if (!this.isOffRoute && d > this.threshold) {
      newState = true;
    } else if (this.isOffRoute && d < this.backThreshold) {
      newState = false;
    }

    this.isOffRoute = newState;

    if (!newState) {
      this.lastAcceptedIndex = nearest.backIndex;
      this.lastAcceptedPos = [lat, lon];
    }

    let event = null;
    if (!wasOffRoute && newState) event = 'off-route';
    if (wasOffRoute && !newState) event = 'back-on-route';

    const returnPoint = this.track[nearest.backIndex];

    return {
      onTrack: !newState,
      distanceM: Math.round(d),
      nearestIndex: nearest.index,
      returnIndex: nearest.backIndex,
      returnBearing: returnPoint ? bearingDeg([lat, lon], returnPoint) : null,
      returnPoint: returnPoint ? [returnPoint[0], returnPoint[1]] : null,
      filteredOut: false,
      progress: this.getProgress(),
      event: event
    };
  }

  getProgress() {
    if (!this.track || this.track.length < 2) return 0;
    return this.lastAcceptedIndex / (this.track.length - 1);
  }

  getDistanceRemaining() {
    if (!this.track || this.track.length < 2) return 0;

    let total = 0;
    for (let i = this.lastAcceptedIndex; i < this.track.length - 1; i++) {
      total += distM(this.track[i], this.track[i + 1]);
    }

    return total;
  }

  findClosestIndex(lat, lon) {
    const nearest = this._findNearest(lat, lon);
    return nearest ? nearest.backIndex : 0;
  }
}

export const deviationDetector = new DeviationDetector();