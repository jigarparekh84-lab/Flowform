/**
 * Decision Brief export — Markdown + printable HTML.
 */

import { parseMoneyM, parsePercent, type BriefState, type Scenario } from './sampleNetwork'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function recommendLine(rec: Scenario, ref: Scenario): string {
  const costDelta =
    parseMoneyM(rec.kpis.cost.value) - parseMoneyM(ref.kpis.cost.value)
  const serviceDelta =
    parsePercent(rec.kpis.service.value) - parsePercent(ref.kpis.service.value)
  const parts = [
    `Prefer “${rec.name}” over ${ref.name}`,
    costDelta <= 0
      ? `saving $${Math.abs(costDelta).toFixed(1)}M annualized cost`
      : `at +$${costDelta.toFixed(1)}M cost`,
    serviceDelta >= 0
      ? `with +${serviceDelta.toFixed(1)}pp service`
      : `with ${serviceDelta.toFixed(1)}pp service`,
  ]
  return parts.join(' ') + '.'
}

export function buildBriefMarkdown(args: {
  brief: BriefState
  scenarios: Scenario[]
  projectName: string
  horizon: string
}): string {
  const { brief, scenarios, projectName, horizon } = args
  const ref = scenarios.find((s) => s.id === 'baseline') ?? scenarios[0]
  const rec =
    scenarios.find((s) => s.id === brief.recommendedScenarioId) ?? ref
  const cards = (
    brief.comparedIds.length
      ? brief.comparedIds
      : [ref.id, rec.id]
  )
    .map((id) => scenarios.find((s) => s.id === id))
    .filter((s): s is Scenario => !!s)

  const lines: string[] = [
    `# Decision Brief — ${projectName}`,
    '',
    `**Horizon:** ${horizon}  `,
    `**Generated:** ${new Date().toLocaleString()}  `,
    `**Recommended:** ${rec.name} (${rec.tag})  `,
    `**Reference:** ${ref.name}`,
    '',
    '## Recommendation',
    '',
    recommendLine(rec, ref),
    '',
    '## Scenario comparison',
    '',
    '| Scenario | Tag | Cost | Service | CapEx | CO₂ | Risk |',
    '|----------|-----|------|---------|-------|-----|------|',
  ]

  for (const s of cards) {
    lines.push(
      `| ${s.name} | ${s.tag} | ${s.kpis.cost.value} | ${s.kpis.service.value} | ${s.kpis.capex.value} | ${s.kpis.co2.value} | ${s.kpis.risk.value} |`,
    )
  }

  lines.push('', '## Assumptions', '')
  for (const a of brief.assumptions) {
    lines.push(`- [${a.checked ? 'x' : ' '}] ${a.label}`)
  }

  if (brief.notes.trim()) {
    lines.push('', '## Notes', '', brief.notes.trim())
  }

  if (rec.optimizeMeta) {
    lines.push(
      '',
      '## Optimize meta',
      '',
      `- Heuristic: ${rec.optimizeMeta.heuristic}`,
      `- Opened: ${rec.optimizeMeta.openedIds.join(', ') || '—'}`,
      `- Closed: ${rec.optimizeMeta.closedIds.join(', ') || '—'}`,
      `- Service: ${rec.optimizeMeta.servicePct.toFixed(1)}%`,
      `- CapEx used: $${rec.optimizeMeta.capexUsedM}M`,
    )
  }

  lines.push('', '---', '', '_Exported from Flowform — network design studio._', '')
  return lines.join('\n')
}

export function buildBriefHtml(args: {
  brief: BriefState
  scenarios: Scenario[]
  projectName: string
  horizon: string
}): string {
  const mdLike = buildBriefMarkdown(args)
  const { brief, scenarios, projectName, horizon } = args
  const ref = scenarios.find((s) => s.id === 'baseline') ?? scenarios[0]
  const rec =
    scenarios.find((s) => s.id === brief.recommendedScenarioId) ?? ref
  const cards = (
    brief.comparedIds.length
      ? brief.comparedIds
      : [ref.id, rec.id]
  )
    .map((id) => scenarios.find((s) => s.id === id))
    .filter((s): s is Scenario => !!s)

  const rows = cards
    .map(
      (s) => `<tr class="${s.id === rec.id ? 'rec' : ''}${s.id === ref.id ? ' ref' : ''}">
  <td><strong>${esc(s.name)}</strong>${s.id === rec.id ? ' <em>Recommended</em>' : ''}${s.id === ref.id ? ' <em>Reference</em>' : ''}</td>
  <td>${esc(s.tag)}</td>
  <td>${esc(s.kpis.cost.value)}</td>
  <td>${esc(s.kpis.service.value)}</td>
  <td>${esc(s.kpis.capex.value)}</td>
  <td>${esc(s.kpis.co2.value)}</td>
  <td>${esc(s.kpis.risk.value)}</td>
</tr>`,
    )
    .join('\n')

  const assumptions = brief.assumptions
    .map(
      (a) =>
        `<li class="${a.checked ? 'on' : 'off'}">${a.checked ? '☑' : '☐'} ${esc(a.label)}</li>`,
    )
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Decision Brief — ${esc(projectName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    max-width: 880px; margin: 2rem auto; padding: 0 1.25rem 3rem; line-height: 1.5; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e8e8; background: #111; }
    table { border-color: #333; }
    th, td { border-color: #333; }
    tr.rec { background: #132a1a; }
    tr.ref { background: #1a2030; }
    .banner { background: #1a2838; border-color: #2a4a6a; }
  }
  h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
  .banner { border: 1px solid #c5d8f0; background: #eef5ff; border-radius: 10px; padding: 1rem 1.15rem; margin-bottom: 1.5rem; }
  .banner h2 { margin: 0 0 0.35rem; font-size: 1.15rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.92rem; margin: 1rem 0 1.5rem; }
  th, td { border: 1px solid #ddd; padding: 0.45rem 0.6rem; text-align: left; }
  th { background: #f4f4f5; }
  tr.rec { background: #ecfdf5; }
  tr.ref { background: #f8fafc; }
  ul { padding-left: 1.1rem; }
  li.off { opacity: 0.55; }
  .notes { white-space: pre-wrap; border-left: 3px solid #94a3b8; padding-left: 0.85rem; }
  .foot { margin-top: 2rem; font-size: 0.8rem; color: #888; }
  @media print {
    body { margin: 0; max-width: none; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
  <p class="no-print" style="text-align:right"><button onclick="window.print()">Print / Save as PDF</button></p>
  <h1>Decision Brief — ${esc(projectName)}</h1>
  <p class="meta">Horizon: ${esc(horizon)} · Generated ${esc(new Date().toLocaleString())}</p>
  <div class="banner">
    <h2>Recommendation: ${esc(rec.name)}</h2>
    <p>${esc(recommendLine(rec, ref))}</p>
  </div>
  <h2>Scenario comparison</h2>
  <table>
    <thead>
      <tr><th>Scenario</th><th>Tag</th><th>Cost</th><th>Service</th><th>CapEx</th><th>CO₂</th><th>Risk</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <h2>Assumptions</h2>
  <ul>
${assumptions}
  </ul>
  ${
    brief.notes.trim()
      ? `<h2>Notes</h2><div class="notes">${esc(brief.notes.trim())}</div>`
      : ''
  }
  <p class="foot">Exported from Flowform — network design studio.</p>
  <!-- source-md
${mdLike.replace(/--\>/g, '-->')}
  -->
</body>
</html>`
}

export function downloadTextFile(filename: string, body: string, mime: string) {
  const blob = new Blob([body], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
