/**
 * Generates the two hero assets in assets/ from one source of truth.
 *
 *   hero.svg / hero.png  — the README hero. Read at full width, so it carries
 *                          the per-phase descriptions.
 *   card.svg / card.png  — the pi.dev gallery thumbnail (package.json pi.image).
 *
 * Both are authored at 960x600, an exact 16:10, because pi.dev's
 * .packages-card-preview-frame is `aspect-ratio: 16/10` with `object-fit: cover`
 * at 168px wide — a non-16:10 source loses the overflow to the crop. At that
 * size everything shrinks by 0.175x, which is what splits the two files: the
 * README hero's 9.5px tile descriptions would render at 1.7px on the card, so
 * the card drops them and spends the space on the headline instead (88px ->
 * 15.4px, against 62px -> 10.8px for the hero's). The card also keeps the
 * headline to two lines — a third would land on the tiles — which is why
 * "Local AI Workflows." rides one line there and breaks over two on the hero.
 *
 * PNG export shells out to rsvg-convert at 2x (1920x1200) when it is on PATH;
 * the SVGs are always written.
 *
 *   bun run scripts/gen-hero.ts
 */
import {spawnSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const W = 960
const H = 600
const M = 44

// GitHub-dark, matching the remote view and the rest of assets/.
const C = {
    bg: '#0d1117',
    bg2: '#010409',
    border: '#30363d',
    text: '#e6edf3',
    muted: '#8b949e',
    dim: '#6e7681',
    purple: '#a371f7',
    purpleDeep: '#8957e5'
}

const FONT =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, 'Liberation Sans', Arial, sans-serif"

interface Phase {
    label: string
    desc: [string, string, string]
    stroke: string
    tile: string
    icon: string
}

const PHASES: Phase[] = [
    {
        label: 'REFINE',
        desc: ['Clarify and', 'structure the', 'request'],
        stroke: C.purple,
        tile: '#1e1633',
        icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/>'
    },
    {
        label: 'RESEARCH',
        desc: ['Parallel research', 'agents gather', 'information'],
        stroke: '#58a6ff',
        tile: '#0d2440',
        icon: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5 16 16"/>'
    },
    {
        label: 'GRILL',
        desc: ['Cross-examine', 'findings to', 'surface gaps'],
        stroke: '#f778ba',
        tile: '#33172a',
        icon: '<path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-3.8-.9L3.5 21l1.9-4.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 8.5-8.5 8.5 8.5 0 0 1 7.5 7.5z"/><path d="M9.6 9.4a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.6-2.5 2.6"/><path d="M12 16.4h.01"/>'
    },
    {
        label: 'COMPOSE',
        desc: ['Create detailed', 'implementation', 'spec'],
        stroke: '#3fb950',
        tile: '#0f2a1b',
        icon: '<path d="M12.5 20.5H21"/><path d="M16.7 3.6a2.1 2.1 0 0 1 3 3L7.5 18.8 3.5 20l1.2-4z"/>'
    },
    {
        label: 'CRITIQUE',
        desc: ['Self-critique for', 'quality and', 'completeness'],
        stroke: '#d29922',
        tile: '#2d2410',
        icon: '<path d="M12 21.5s7.5-3.8 7.5-9.5V5.2L12 2.5 4.5 5.2V12c0 5.7 7.5 9.5 7.5 9.5z"/>'
    }
]

const open = (ariaLabel: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}" role="img" aria-label="${ariaLabel}">`

const defs = () => `
  <defs>
    <clipPath id="frame"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.bg}"/><stop offset="1" stop-color="${C.bg2}"/>
    </linearGradient>
    <linearGradient id="hl" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#b183f9"/><stop offset="1" stop-color="${C.purpleDeep}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>`

// pi in a broken circle, drawn as paths so the mark never depends on a font.
const logo = (x: number, y: number, s: number, size: number) => {
    const mark = `<g transform="translate(${x},${y}) scale(${s})" fill="none" stroke="${C.purple}" stroke-width="${(2.1 / s).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M30.18 4.98A20 20 0 1 0 41.66 14.61"/>
    <path d="M13.5 17H34.5M19.5 17V32M28.5 17V32"/>
  </g>`
    const tx = (x + 44 * s + size * 0.34).toFixed(0)
    const ty = (y + 22 * s + size * 0.355).toFixed(0)
    return `${mark}
  <text x="${tx}" y="${ty}" font-size="${size}" font-weight="700" fill="${C.text}" letter-spacing="-0.5">pi-task</text>`
}

type Pt = [number, number]

// Normalised ridge profile: [distance toward the summit, height]. The two flanks
// differ so the silhouette does not read as mirrored.
const LEFT: Pt[] = [
    [0, 0],
    [0.12, 0.3],
    [0.2, 0.2],
    [0.34, 0.56],
    [0.44, 0.46],
    [0.57, 0.73],
    [0.69, 0.64],
    [0.81, 0.87],
    [0.9, 0.8],
    [1, 1]
]
const RIGHT: Pt[] = [
    [0.92, 0.79],
    [0.84, 0.88],
    [0.72, 0.6],
    [0.62, 0.68],
    [0.47, 0.41],
    [0.36, 0.49],
    [0.24, 0.23],
    [0.14, 0.31],
    [0, 0]
]

const ridge = (cx: number, sy: number, hw: number, by: number): Pt[] => {
    const h = by - sy
    return [
        ...LEFT.map(([t, v]): Pt => [cx - hw + t * hw, by - v * h]),
        ...RIGHT.map(([t, v]): Pt => [cx + (1 - t) * hw, by - v * h])
    ]
}

const poly = (pts: Pt[]) =>
    pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('')

interface MountainOpts {
    cx: number
    sy: number
    hw: number
    by?: number
    o?: number
    flag?: boolean
}

const mountain = ({cx, sy, hw, by = H, o = 1, flag = true}: MountainOpts) => {
    const pts = ridge(cx, sy, hw, by)
    const [fx, fy] = pts[LEFT.length - 1]
    let s = `<g clip-path="url(#frame)" fill="none" stroke="${C.purple}" stroke-linecap="round" stroke-linejoin="round" opacity="${o}">`

    for (const back of [
        ridge(cx - hw * 0.62, sy + (by - sy) * 0.42, hw * 0.7, by),
        ridge(cx + hw * 0.68, sy + (by - sy) * 0.5, hw * 0.66, by)
    ]) {
        s += `<path d="${poly(back)}" stroke-width="1.4" opacity="0.16"/>`
    }

    // summit-to-base fan plus a strut under every ridge vertex: the wireframe.
    const fan: string[] = []
    for (let i = 0; i <= 8; i++) {
        const bx = (cx - hw + (i / 8) * hw * 2).toFixed(1)
        fan.push(`M${fx.toFixed(1)} ${fy.toFixed(1)}L${bx} ${by}`)
    }
    s += `<path d="${fan.join('')}" stroke-width="1" opacity="0.1"/>`
    const struts = pts
        .slice(1, -1)
        .map(([x, y]) => `M${x.toFixed(1)} ${y.toFixed(1)}L${x.toFixed(1)} ${by}`)
        .join('')
    s += `<path d="${struts}" stroke-width="1" opacity="0.13"/>`
    s += `<path d="${poly(pts)}" stroke-width="2.2" opacity="0.55"/>`

    // the ascent: base to summit, dashed, node at every stop
    const asc = [pts[0], pts[2], pts[4], pts[6], pts[8], pts[LEFT.length - 1]]
    s += `<path d="${poly(asc)}" stroke-width="1.8" stroke-dasharray="7 6" opacity="0.75"/>`
    for (const [x, y] of asc) {
        s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${C.purple}" stroke="none" opacity="0.9"/>`
    }

    if (flag) {
        s += `<path d="M${fx.toFixed(1)} ${fy.toFixed(1)}L${fx.toFixed(1)} ${(fy - 48).toFixed(1)}" stroke-width="2.6" opacity="0.95"/>`
        s += `<path d="M${fx.toFixed(1)} ${(fy - 48).toFixed(1)}h44l-10 13h-34z" fill="${C.purpleDeep}" stroke="none"/>`
        s += `<text x="${(fx + 15).toFixed(1)}" y="${(fy - 37).toFixed(1)}" font-size="15" font-weight="700" fill="#fff" stroke="none">&#960;</text>`
    }
    return `${s}</g>`
}

const arrow = (x: number, y: number, w: number) =>
    `<path d="M${x.toFixed(1)} ${y}h${w}M${(x + w - 6).toFixed(1)} ${y - 5}l6 5-6 5" fill="none" stroke="${C.dim}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`

const tile = (p: Phase, x: number, y: number, size: number, iconScale: number) => {
    const ix = (x + size / 2 - 12 * iconScale).toFixed(1)
    const iy = (y + size / 2 - 12 * iconScale).toFixed(1)
    return `<rect x="${x.toFixed(1)}" y="${y}" width="${size}" height="${size}" rx="${(size * 0.22).toFixed(1)}" fill="${p.tile}" stroke="${p.stroke}" stroke-opacity="0.28" stroke-width="1.2"/>
  <g transform="translate(${ix},${iy}) scale(${iconScale})" fill="none" stroke="${p.stroke}" stroke-width="${(1.9 / iconScale).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">${p.icon}</g>`
}

// First line carries the promise in plain white; the rest is the gradient.
// Line count differs per asset: the hero has the vertical room to break
// "Local AI / Workflows." over two lines at full size, the card does not.
const headline = (lines: string[], baseline: number, size: number, tracking: number) =>
    lines
        .map(
            (line, i) =>
                `<text x="${M}" y="${baseline + i * Math.round(size * 1.1)}" font-size="${size}" font-weight="700" fill="${i ? 'url(#hl)' : C.text}" letter-spacing="${tracking}">${line}</text>`
        )
        .join('\n  ')

/** README hero: full detail, read at full width. */
function hero() {
    const size = 74
    const left = 470
    const gap = (W - M - left - size * PHASES.length) / (PHASES.length - 1)
    const sub = [
        'pi-task orchestrates every request',
        'through a fixed pipeline to produce',
        'implementation specs you can trust.'
    ]
    let s =
        open(
            'pi-task — Deterministic Local AI Workflows. Every request runs a fixed pipeline: refine to clarify and structure it, research to gather information in parallel, grill to cross-examine the findings, compose to write the implementation spec, critique to check it for quality and completeness.'
        ) + defs()
    s += mountain({cx: 560, sy: 372, hw: 320, o: 0.5})
    s += `\n  ${logo(M, 34, 0.82, 30)}`
    s += `\n  ${headline(['Deterministic', 'Local AI', 'Workflows.'], 186, 62, -2)}`
    s += `\n  <rect x="${M}" y="354" width="72" height="4" rx="2" fill="${C.purpleDeep}"/>`
    sub.forEach((line, i) => {
        s += `\n  <text x="${M}" y="${398 + i * 25}" font-size="17" fill="${C.muted}">${line}</text>`
    })
    PHASES.forEach((p, i) => {
        const x = left + i * (size + gap)
        const mid = (x + size / 2).toFixed(1)
        s += `\n  ${tile(p, x, 132, size, 1.5)}`
        s += `\n  <text x="${mid}" y="${132 + size + 21}" text-anchor="middle" font-size="11.5" font-weight="700" fill="${C.text}" letter-spacing="0.4">${p.label}</text>`
        p.desc.forEach((d, j) => {
            s += `\n  <text x="${mid}" y="${132 + size + 39 + j * 12}" text-anchor="middle" font-size="9.5" fill="${C.muted}">${d}</text>`
        })
        if (i < PHASES.length - 1) s += `\n  ${arrow(x + size + gap / 2 - 7, 132 + size / 2, 14)}`
    })
    return `${s}\n</svg>\n`
}

/** Gallery card: nothing on it dies at 168px wide. */
function card() {
    const size = 66
    const step = (W - M * 2) / PHASES.length
    let s =
        open(
            'pi-task — Deterministic Local AI Workflows. Five fixed phases: refine, research, grill, compose, critique.'
        ) + defs()
    s += mountain({cx: 660, sy: 250, hw: 330, o: 0.26, flag: false})
    s += `\n  ${logo(M, 28, 0.95, 36)}`
    s += `\n  ${headline(['Deterministic', 'Local AI Workflows.'], 268, 88, -4)}`
    s += `\n  <rect x="${M}" y="404" width="104" height="7" rx="3.5" fill="${C.purpleDeep}"/>`
    PHASES.forEach((p, i) => {
        const cx = M + step * (i + 0.5)
        s += `\n  ${tile(p, cx - size / 2, 452, size, 1.45)}`
        s += `\n  <text x="${cx.toFixed(1)}" y="${452 + size + 25}" text-anchor="middle" font-size="18" font-weight="700" fill="${C.muted}" letter-spacing="0.6">${p.label}</text>`
        if (i < PHASES.length - 1) s += `\n  ${arrow(cx + step / 2 - 10, 452 + size / 2, 20)}`
    })
    return `${s}\n</svg>\n`
}

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

for (const [name, svg] of [
    ['hero', hero()],
    ['card', card()]
] as const) {
    const svgPath = join(assets, `${name}.svg`)
    const pngPath = join(assets, `${name}.png`)
    writeFileSync(svgPath, svg)
    // 2x export: the gallery card is 168px CSS, which is 336 device px on a
    // retina display, and the README hero is read far wider than 960.
    const png = spawnSync('rsvg-convert', ['-w', String(W * 2), svgPath, '-o', pngPath], {
        stdio: 'inherit'
    })
    if (png.error || png.status !== 0) {
        console.log(`${name}.svg written — install rsvg-convert to re-export ${name}.png`)
    } else {
        console.log(`${name}.svg + ${name}.png (${W * 2}x${H * 2})`)
    }
}
