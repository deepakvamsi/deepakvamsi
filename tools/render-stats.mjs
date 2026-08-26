#!/usr/bin/env node
// Renders a language donut + activity stats as SVG.
// No dependencies: node >= 18 (global fetch).
//
//   GITHUB_TOKEN=... node tools/render-stats.mjs --user deepakvamsi
//   node tools/render-stats.mjs --mock          # synthetic data, no token

const TOP_N = 6; // languages listed individually; the rest fold into "Other"

const CX = 132; // donut centre
const CY = 150;
const R_OUT = 88;
const R_IN = 50;
const PAD = 28;

const LIGHT = {
    bg: '#ffffff',
    fg: '#1f2328',
    mut: '#57606a',
    line: '#d0d7de',
    hole: '#ffffff',
};
const DARK = {
    bg: '#22272e',
    fg: '#e6edf3',
    mut: '#9198a1',
    line: '#30363d',
    hole: '#22272e',
};

const OTHER_COLOR = '#8b949e';

const args = process.argv.slice(2);
const flag = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);

// ---------------------------------------------------------------- data

const QUERY = `query($login:String!) {
  user(login:$login) {
    followers { totalCount }
    repositories(first:100, ownerAffiliations:OWNER, isFork:false,
                 orderBy:{field:PUSHED_AT, direction:DESC}) {
      totalCount
      nodes {
        stargazerCount
        forkCount
        languages(first:10, orderBy:{field:SIZE, direction:DESC}) {
          edges { size node { name color } }
        }
      }
    }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
    }
  }
}`;

async function fetchStats(login, token) {
    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
            Authorization: `bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'render-stats',
        },
        body: JSON.stringify({ query: QUERY, variables: { login } }),
    });

    if (!res.ok) {
        throw new Error(`GitHub API ${res.status} ${res.statusText}: ${await res.text()}`);
    }
    const body = await res.json();
    if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
    if (!body.data || !body.data.user) throw new Error(`No such user: ${login}`);

    const u = body.data.user;
    const repos = u.repositories.nodes;

    const bytes = new Map();
    const colors = new Map();
    for (const r of repos) {
        for (const e of r.languages.edges) {
            bytes.set(e.node.name, (bytes.get(e.node.name) || 0) + e.size);
            if (e.node.color) colors.set(e.node.name, e.node.color);
        }
    }

    const langs = [...bytes.entries()]
        .map(([name, size]) => ({ name, size, color: colors.get(name) || OTHER_COLOR }))
        .sort((a, b) => b.size - a.size);

    const c = u.contributionsCollection;
    return {
        langs,
        stats: {
            repos: u.repositories.totalCount,
            stars: repos.reduce((s, r) => s + r.stargazerCount, 0),
            forks: repos.reduce((s, r) => s + r.forkCount, 0),
            followers: u.followers.totalCount,
            commits: c.totalCommitContributions,
            prs: c.totalPullRequestContributions,
            issues: c.totalIssueContributions,
        },
    };
}

function mockStats() {
    return {
        langs: [
            { name: 'Python', size: 412000, color: '#3572A5' },
            { name: 'Go', size: 268000, color: '#00ADD8' },
            { name: 'TypeScript', size: 131000, color: '#3178c6' },
            { name: 'Shell', size: 44000, color: '#89e051' },
            { name: 'Dockerfile', size: 12000, color: '#384d54' },
        ],
        stats: {
            repos: 14, stars: 37, forks: 6, followers: 21,
            commits: 486, prs: 39, issues: 12,
        },
    };
}

// ---------------------------------------------------------------- render

const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmt = (n) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;

const polar = (cx, cy, r, deg) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};

// Donut segment between two angles. A single arc cannot express a full circle,
// so a segment covering (almost) 360 degrees is drawn as two half rings.
function segment(a0, a1) {
    if (a1 - a0 >= 359.999) {
        return segment(a0, a0 + 180) + ' ' + segment(a0 + 180, a0 + 359.999);
    }
    const large = a1 - a0 > 180 ? 1 : 0;
    const [ox0, oy0] = polar(CX, CY, R_OUT, a0);
    const [ox1, oy1] = polar(CX, CY, R_OUT, a1);
    const [ix1, iy1] = polar(CX, CY, R_IN, a1);
    const [ix0, iy0] = polar(CX, CY, R_IN, a0);
    const f = (n) => n.toFixed(2);
    return (
        `M${f(ox0)},${f(oy0)} A${R_OUT},${R_OUT} 0 ${large} 1 ${f(ox1)},${f(oy1)} ` +
        `L${f(ix1)},${f(iy1)} A${R_IN},${R_IN} 0 ${large} 0 ${f(ix0)},${f(iy0)} Z`
    );
}

function render({ langs, stats }, { dark, animate, title }) {
    const t = dark ? DARK : LIGHT;

    // Fold everything past TOP_N into a single "Other" slice.
    const top = langs.slice(0, TOP_N);
    const restSize = langs.slice(TOP_N).reduce((s, l) => s + l.size, 0);
    const slices = restSize > 0
        ? [...top, { name: 'Other', size: restSize, color: OTHER_COLOR }]
        : top;

    const total = slices.reduce((s, l) => s + l.size, 0) || 1;

    let angle = 0;
    const arcs = slices.map((l, i) => {
        const sweep = (l.size / total) * 360;
        const d = segment(angle, angle + sweep);
        angle += sweep;
        const anim = animate
            ? `<animate attributeName="opacity" from="0" to="1" dur="0.5s" ` +
              `begin="${(i * 0.09).toFixed(2)}s" fill="freeze"/>`
            : '';
        return (
            `<path d="${d}" fill="${l.color}" opacity="${animate ? 0 : 1}">` +
            `<title>${esc(l.name)}: ${((l.size / total) * 100).toFixed(1)}%</title>${anim}</path>`
        );
    });

    // Legend sits to the right of the donut, one row per slice.
    const LX = CX + R_OUT + 34;
    const legend = slices.map((l, i) => {
        const y = 92 + i * 24;
        const pct = ((l.size / total) * 100).toFixed(1);
        return (
            `<g opacity="${animate ? 0 : 1}">` +
            (animate
                ? `<animate attributeName="opacity" from="0" to="1" dur="0.5s" ` +
                  `begin="${(0.25 + i * 0.07).toFixed(2)}s" fill="freeze"/>`
                : '') +
            `<rect x="${LX}" y="${y - 9}" width="11" height="11" rx="2.5" fill="${l.color}"/>` +
            `<text x="${LX + 19}" y="${y}" font-size="12.5" fill="${t.fg}">${esc(l.name)}</text>` +
            `<text x="${LX + 176}" y="${y}" font-size="12.5" fill="${t.mut}" ` +
            `text-anchor="end">${pct}%</text></g>`
        );
    });

    const W = LX + 176 + PAD;

    // Stat strip along the bottom.
    const items = [
        ['Repos', stats.repos],
        ['Stars', stats.stars],
        ['Forks', stats.forks],
        ['Followers', stats.followers],
        ['Commits', stats.commits],
        ['PRs', stats.prs],
    ];
    const stripY = Math.max(CY + R_OUT + 46, 92 + slices.length * 24 + 34);
    const colW = (W - PAD * 2) / items.length;

    const strip = items.map(([k, v], i) => {
        const x = PAD + colW * i + colW / 2;
        return (
            `<g opacity="${animate ? 0 : 1}">` +
            (animate
                ? `<animate attributeName="opacity" from="0" to="1" dur="0.5s" ` +
                  `begin="${(0.5 + i * 0.06).toFixed(2)}s" fill="freeze"/>`
                : '') +
            `<text x="${x.toFixed(1)}" y="${stripY}" font-size="17" font-weight="600" ` +
            `fill="${t.fg}" text-anchor="middle">${fmt(v)}</text>` +
            `<text x="${x.toFixed(1)}" y="${stripY + 16}" font-size="10.5" ` +
            `fill="${t.mut}" text-anchor="middle">${k}</text></g>`
        );
    });

    const H = stripY + 30 + PAD;
    const topLang = slices[0] ? slices[0].name : '—';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}: ${slices.length} languages, ${stats.repos} repos, ${stats.stars} stars">
  <style>text{font-family:"Segoe UI",Ubuntu,Helvetica,Arial,sans-serif}</style>
  <rect width="${W}" height="${H}" fill="${t.bg}"/>
  <text x="${PAD}" y="30" font-size="15" font-weight="600" fill="${t.fg}">${esc(title)}</text>
  <line x1="${PAD}" y1="${stripY - 30}" x2="${W - PAD}" y2="${stripY - 30}" stroke="${t.line}"/>
  <g>
    ${arcs.join('\n    ')}
  </g>
  <text x="${CX}" y="${CY - 2}" font-size="14" font-weight="600" fill="${t.fg}" text-anchor="middle">${esc(topLang)}</text>
  <text x="${CX}" y="${CY + 15}" font-size="10.5" fill="${t.mut}" text-anchor="middle">most used</text>
  ${legend.join('\n  ')}
  ${strip.join('\n  ')}
</svg>
`;
}

// ---------------------------------------------------------------- main

const user = flag('user', process.env.GH_USER || 'deepakvamsi');
const out = flag('out', 'assets/contrib-graph/stats-circle.svg');

const data = has('mock')
    ? mockStats()
    : await (async () => {
          const token = process.env.GITHUB_TOKEN;
          if (!token) {
              console.error('GITHUB_TOKEN is not set. Use --mock for a preview with synthetic data.');
              process.exit(1);
          }
          return fetchStats(user, token);
      })();

const { mkdirSync, writeFileSync } = await import('fs');
const { dirname } = await import('path');

const title = `@${user} — languages & activity`;
for (const [suffix, dark] of [
    ['', false],
    ['-dark', true],
]) {
    const file = out.replace(/\.svg$/, `${suffix}.svg`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, render(data, { dark, animate: true, title }));
    console.log(`wrote ${file}`);
}
