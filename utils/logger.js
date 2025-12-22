// utils/logger.js
export function logInfo(...args) {
  console.log(new Date().toISOString(), "INFO", ...args);
}
export function logWarn(...args) {
  console.warn(new Date().toISOString(), "WARN", ...args);
}
export function logError(...args) {
  console.error(new Date().toISOString(), "ERROR", ...args);
}
