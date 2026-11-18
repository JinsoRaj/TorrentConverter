/** A tiny LRU cache for byte buffers, bounded by entry count and total bytes. */
export class LRUCache {
  #map = new Map();
  #bytes = 0;

  constructor({ maxEntries = 500, maxBytes = 64 * 1024 * 1024 } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get(key) {
    const value = this.#map.get(key);
    if (value === undefined) return undefined;
    // Re-insert to mark as most recently used.
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key, value) {
    const size = value.byteLength ?? 0;
    if (size > this.maxBytes || this.maxEntries < 1) return;
    this.delete(key);
    this.#map.set(key, value);
    this.#bytes += size;
    while (this.#map.size > this.maxEntries || this.#bytes > this.maxBytes) {
      this.delete(this.#map.keys().next().value);
    }
  }

  delete(key) {
    const value = this.#map.get(key);
    if (value === undefined) return;
    this.#bytes -= value.byteLength ?? 0;
    this.#map.delete(key);
  }

  get size() {
    return this.#map.size;
  }

  get bytes() {
    return this.#bytes;
  }
}
