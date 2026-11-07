/**
 * The Client half's registration id must BE THE PACKAGE NAME.
 *
 * The Host composes the web boot graph from each package's `dsh.client` declaration and keys every
 * row by `package.json` `name` (`reconcilePackage(packageName)` → `graphRow(packageName, …)`). The
 * browser loader looks the row up by that exact id. When the packages were renamed to the
 * `@corvus-dsh/*` scope, `client.js` kept the short id, so every boot reported:
 *
 *   plugins/…/client.js: loaded without registering "@corvus-dsh/dsh-memory" via __ModuleLoader__.load
 *
 * then re-executed the bundle as a fallback and died on `duplicate factory registration`. The page
 * never reached a usable state — and the failure was easy to misread as a Host fault.
 *
 * This test makes the contract explicit: ONE package, ONE id, and it is the scoped name.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))

test('client bundle registers the package name, not the short alias', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  // Strip comments first: the explanation above quotes the OLD id, and this assertion is about code.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
  const registered = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/u.exec(code)
  assert.ok(registered !== null, 'client.js must call __ModuleLoader__.load({ id, factory })')
  assert.equal(
    registered[1],
    pkg.name,
    `the boot graph keys this package as "${pkg.name}"; a different id is "loaded without registering"`,
  )
  assert.equal(pkg.dsh?.client?.platform, 'web', 'the package must still declare a web client half')
})
