const counters = new Map();

export const metrics = {
  inc(name, val = 1) {
    counters.set(name, (counters.get(name) || 0) + val);
  },
  get(name) {
    return counters.get(name) || 0;
  },
  reset() {
    counters.clear();
  },
  scrape() {
    return Array.from(counters.entries())
      .map(([k, v]) => `${k} ${v}`)
      .join('\n');
  },
};

export default metrics;
