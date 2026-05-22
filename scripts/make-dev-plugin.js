#!/usr/bin/env node
// Generate ./dev/ — a sibling plugin root with a distinct logseq.id so the
// marketplace-installed release of this plugin and a local "Load unpacked
// plugin" copy can coexist in Logseq. Run after `npm run build`, then point
// Logseq's Load unpacked plugin at ./dev/.

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const devDir = path.join(root, 'dev')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

if (!fs.existsSync(path.join(root, 'build', 'index.html'))) {
  console.error('build/index.html not found — run `npm run build` first.')
  process.exit(1)
}

fs.rmSync(devDir, { recursive: true, force: true })
fs.mkdirSync(devDir)

const devPkg = {
  name: `${pkg.name}-dev`,
  version: pkg.version,
  private: true,
  description: `${pkg.description} (dev)`,
  main: pkg.main,
  homepage: pkg.homepage,
  logseq: {
    ...pkg.logseq,
    id: `${pkg.logseq.id}-dev`,
    title: `(Dev) ${pkg.logseq.title}`,
  },
}
fs.writeFileSync(path.join(devDir, 'package.json'), JSON.stringify(devPkg, null, 2) + '\n')

for (const name of ['build', 'logo.png']) {
  const target = path.join(root, name)
  if (!fs.existsSync(target)) continue
  fs.symlinkSync(path.relative(devDir, target), path.join(devDir, name))
}

console.log(`Dev plugin root ready at ${devDir}`)
console.log(`In Logseq: Plugins → Load unpacked plugin → select ${devDir}`)
