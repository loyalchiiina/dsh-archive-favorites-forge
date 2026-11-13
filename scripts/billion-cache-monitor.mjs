#!/usr/bin/env node
// billion-cache-monitor.mjs —— billion-context 垃圾缓存监测/清理 CLI（无新增依赖）
//
// 用法：
//   node scripts/billion-cache-monitor.mjs                      只读诊断（默认，保留最近 7 天图片缓存）
//   node scripts/billion-cache-monitor.mjs --json               机器可读 JSON
//   node scripts/billion-cache-monitor.mjs --keep-days 14       保留最近 14 天图片缓存
//   node scripts/billion-cache-monitor.mjs --clean --yes        真实清理（删除进回收站）
//   node scripts/billion-cache-monitor.mjs --clean --yes --include-rebuild   连可重建缓存一起清理
//
// 依赖：仅本插件 lib/billion-cache.js 与其内部依赖（Node 内置 + PowerShell 回收站）。
import { diagnoseBillionCache, cleanupBillionCache, BILLION_CACHE_VERSION } from '../lib/billion-cache.js'

function parseArgs(argv) {
  const o = { keepDays: 7, json: false, clean: false, yes: false, includeRebuild: false, help: false }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--clean') o.clean = true
    else if (a === '--yes') o.yes = true
    else if (a === '--include-rebuild') o.includeRebuild = true
    else if (a === '--keep-days') o.keepDays = Number(argv[++i])
    else if (a.startsWith('--keep-days=')) o.keepDays = Number(a.split('=')[1])
    else if (a === '--help' || a === '-h') o.help = true
  }
  return o
}

function fmt(n) {
  const b = Number(n) || 0
  if (b < 1024) return b + ' B'
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'
  if (b < 1073741824) return (b / 1048576).toFixed(2) + ' MB'
  return (b / 1073741824).toFixed(2) + ' GB'
}

function usage() {
  console.log('billion-context 垃圾缓存监测 v' + BILLION_CACHE_VERSION)
  console.log('  node scripts/billion-cache-monitor.mjs [--json] [--keep-days N]')
  console.log('  node scripts/billion-cache-monitor.mjs --clean --yes [--include-rebuild] [--keep-days N]')
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) { usage(); return }

  const report = await diagnoseBillionCache({}, { keepDays: args.keepDays })
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log('billion-context 垃圾缓存诊断 v' + report.version + '  扫描 ' + report.scannedAt + '  保留窗口 ' + report.keepDays + ' 天')
  console.log('根目录：')
  for (const r of report.roots) {
    console.log('  ' + (r.exists ? '[存在] ' : '[缺失] ') + fmt(r.bytes).padStart(10) + '  ' + r.label + '  ' + r.dir)
  }
  const s = report.summary
  console.log('')
  console.log('分类统计：')
  for (const k of Object.keys(s.byKind)) {
    const v = s.byKind[k]
    console.log('  ' + v.kindLabel.padEnd(14) + ' 条目 ' + String(v.count).padStart(3) + '  合计 ' + fmt(v.bytes))
  }
  console.log('')
  console.log('总计 ' + s.totalEntries + ' 条 / ' + fmt(s.totalBytes)
    + ' ｜ 可直接清理 ' + s.deletableCount + ' 条 / ' + fmt(s.deletableBytes)
    + ' ｜ 可重建缓存 ' + s.rebuildCount + ' 条 / ' + fmt(s.rebuildBytes))

  const actionable = report.entries.filter(function (e) { return e.deletable || e.rebuild })
  if (actionable.length) {
    console.log('')
    console.log('可处理条目：')
    for (const e of actionable) {
      const tag = e.deletable ? '[可删]' : '[可重建]'
      console.log('  ' + tag + ' ' + fmt(e.bytes).padStart(10) + '  ' + String(e.ageDays).padStart(6) + '天  ' + e.path)
    }
  }

  if (!args.clean) return
  if (!args.yes) {
    console.log('')
    console.log('未加 --yes，不做任何删除。确认要清理请追加 --yes（删除进回收站）。')
    return
  }

  console.log('')
  console.log('开始清理（进回收站）' + (args.includeRebuild ? '，含可重建缓存' : '，仅可安全删除项') + '…')
  const result = await cleanupBillionCache({}, {}, {
    dryRun: false,
    includeRebuild: args.includeRebuild,
    keepDays: args.keepDays,
    onProgress: function (p) {
      console.log('  [' + p.done + '/' + p.total + '] 已释放 ' + fmt(p.bytesFreed) + '  ' + p.current)
    },
  })
  console.log('')
  console.log('清理完成：删除 ' + result.deleted.length + ' 项｜跳过 ' + result.skipped.length
    + '｜失败 ' + result.failures.length + '｜释放 ' + fmt(result.bytesFreed))
  if (result.failures.length) {
    for (const f of result.failures.slice(0, 10)) console.log('  失败：' + f.path + ' —— ' + f.reason)
  }
}

main().catch(function (error) {
  console.error('诊断/清理失败：' + (error && error.message ? error.message : String(error)))
  process.exitCode = 1
})
