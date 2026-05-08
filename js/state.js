/**
 * MedSwift Global State (Vanilla JS)
 * Simple pub/sub pattern to replace Zustand.
 */
class StateManager {
  constructor(initialState) {
    this.state = initialState;
    this.listeners = {};
  }

  get(key) {
    return this.state[key];
  }

  set(key, value) {
    this.state[key] = value;
    this.notify(key, value);
  }

  update(key, fn) {
    this.set(key, fn(this.state[key]));
  }

  subscribe(key, listener) {
    if (!this.listeners[key]) this.listeners[key] = [];
    this.listeners[key].push(listener);
  }

  notify(key, value) {
    if (this.listeners[key]) {
      this.listeners[key].forEach(listener => listener(value));
    }
  }
}

export const appState = new StateManager({
  scanStatus: 'idle',
  currentScan: null,
  scanHistory: [],
  isOnline: navigator.onLine,
  ecoCoordinates: [],
  syncQueueLength: 0
});
