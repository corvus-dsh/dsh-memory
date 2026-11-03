import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
const token = process.env.GITHUB_TOKEN
const owner = "corvus-dsh", repo = "dsh-memory"
const H = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "dsh-memory-publish", "Content-Type": "application/json" }
const api = async (method, path, body) => {
  const r = await fetch(`https://api.github.com${path}`, { method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${j.message ?? ""}`)
  return j
}
const root = process.cwd()
const skip = new Set(["node_modules", ".git", ".dsh-memory"])
const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full)
    else files.push(relative(root, full).split(sep).join("/"))
  }
}
walk(".")
// An empty repository cannot accept a tree; seed it with the README via Contents API.
const seedPath = "README.md"
const initial = await api("PUT", `/repos/${owner}/${repo}/contents/${seedPath}`, {
  message: "release: v0.1.0",
  content: readFileSync(join(root, seedPath)).toString("base64"),
  branch: "main",
})
const baseTree = initial.commit.tree.sha
const tree = files.filter((p) => p !== seedPath).map((path) => ({ path, mode: "100644", type: "blob", content: readFileSync(join(root, path), "utf8") }))
console.log("files:", files.length, "| seed:", initial.commit.sha.slice(0, 8))
const created = await api("POST", `/repos/${owner}/${repo}/git/trees`, { base_tree: baseTree, tree })
const commit = await api("POST", `/repos/${owner}/${repo}/git/commits`, { message: "release: v0.1.0", tree: created.sha, parents: [initial.commit.sha] })
await api("PATCH", `/repos/${owner}/${repo}/git/refs/heads/main`, { sha: commit.sha, force: false })
const tag = await api("POST", `/repos/${owner}/${repo}/git/tags`, { tag: "v0.1.0", message: "dsh-memory 0.1.0", object: commit.sha, type: "commit" })
await api("POST", `/repos/${owner}/${repo}/git/refs`, { ref: "refs/tags/v0.1.0", sha: tag.sha })
await api("PUT", `/repos/${owner}/${repo}/topics`, { names: ["dsh-plugin", "dsh", "deepseek-harness", "agent-memory", "skills", "memory"] })
const notes = readFileSync("README.md", "utf8")
const release = await api("POST", `/repos/${owner}/${repo}/releases`, {
  tag_name: "v0.1.0",
  name: "dsh-memory 0.1.0（预发布）— 让经验变成技能",
  body: notes.slice(0, 6000),
  prerelease: true,
  draft: false,
})
console.log("commit:", commit.sha.slice(0, 8))
console.log("release:", release.html_url)
