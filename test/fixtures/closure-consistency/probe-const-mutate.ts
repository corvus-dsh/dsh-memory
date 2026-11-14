// 8 行最小复现：const-mutate 检测探针（用户提供）。
// module-level const 对象被变异方法（.set/.clear/.delete）调用时，
// closure 必须把它报成 mutable: ["cache (const-mutated)"]。
const cache = new Map()
export function get(key) {
  return cache.get(key)
}
export function put(key, value) {
  cache.set(key, value)
  return cache
}
export function reset() {
  cache.clear()
  return cache
}