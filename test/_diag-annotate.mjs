/**
 * 临时诊断包装：失败时把原因写进 GitHub annotation。
 *
 * 为什么：CI 的 job 日志需要认证才能拉取（403），而 annotation 可以匿名读。
 * `node --test` 的失败信息只进日志、不进 annotation，于是"红了但不知道为什么"。
 *
 * 用法：`const t2 = ...` 见下方；把测试的 `test(` 换成 `t2(` 即可。
 * **本文件是临时诊断件**，定位后删除。
 */
const emit = (level, text) => {
  const one = String(text).replace(/\r?\n/gu, ' ⏎ ').slice(0, 850)
  console.log(`::${level}::ANNOTATE ${one}`)
}

export const annotate = async (name, body) => {
  emit('notice', `START ${name}`)
  try {
    const value = await body()
    emit('notice', `OK ${name}`)
    return value
  } catch (error) {
    emit('error', `FAIL ${name}: ${error?.name ?? 'Error'}: ${error?.message ?? error}`)
    throw error
  }
}
