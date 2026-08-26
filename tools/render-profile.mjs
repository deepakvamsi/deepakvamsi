#!/usr/bin/env node
// Renders one composite profile SVG:
//   - isometric map of the last 30 days of contributions (left)
//   - log-scale radar of commits / issues / PRs / reviews (top right)
//   - language donut + legend (bottom left)
//   - repos / stars / forks / followers strip (bottom right)
//
// No dependencies: node >= 18 (global fetch).
//
//   GITHUB_TOKEN=... node tools/render-profile.mjs --user deepakvamsi
//   node tools/render-profile.mjs --mock          # synthetic data, no token

const DAYS = 30;
const TOP_N = 6; // languages listed individually; the rest fold into "Other"

// ---- canvas -----------------------------------------------------------
const W = 920;
const H = 566;
const PAD = 28;
const SPLIT = 356; // y of the divider between the map/radar row and the rest

// ---- isometric map ----------------------------------------------------
const TILE_W = 34;
const TILE_H = 19;
const MAX_H = 72;
const MIN_H = 4;
const ISO_CX = 268; // centre of the map column
const ISO_TOP = 74; // y of the tallest possible bar's apex

// ---- radar ------------------------------------------------------------
const RAD_CX = 726;
const RAD_CY = 202;
const RAD_R = 104;

// ---- donut ------------------------------------------------------------
const DON_CX = 116;
const DON_CY = 452;
const DON_OUT = 70;
const DON_IN = 39;

const LIGHT = {
    bg: '#ffffff', fg: '#1f2328', mut: '#57606a', line: '#d0d7de', grid: '#e4e8ed',
    levels: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
    radar: '#2da44e',
};
const DARK = {
    bg: '#22272e', fg: '#e6edf3', mut: '#9198a1', line: '#30363d', grid: '#2d333b',
    levels: ['#2d333b', '#0e4429', '#006d32', '#26a641', '#39d353'],
    radar: '#39d353',
};

const OTHER_COLOR = '#8b949e';

const args = process.argv.slice(2);
const flag = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);

// ---------------------------------------------------------------- data

const QUERY = `query($login:String!, $from:DateTime!, $to:DateTime!) {
  user(login:$login) {
    followers { totalCount }
    contributionsCollection(from:$from, to:$to) {
      contributionCalendar {
        weeks { contributionDays { date contributionCount contributionLevel } }
      }
    }
    lifetime: contributionsCollection {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
    }
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
  }
}`;

const LEVELS = {
    NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2,
    THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4,
};

async function fetchAll(login, token) {
    const to = new Date();
    const from = new Date(to.getTime() - (DAYS - 1) * 864e5);
    from.setUTCHours(0, 0, 0, 0);

    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
            Authorization: `bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'render-profile',
        },
        body: JSON.stringify({
            query: QUERY,
            variables: { login, from: from.toISOString(), to: to.toISOString() },
        }),
    });

    if (!res.ok) {
        throw new Error(`GitHub API ${res.status} ${res.statusText}: ${await res.text()}`);
    }
    const body = await res.json();
    if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
    if (!body.data || !body.data.user) throw new Error(`No such user: ${login}`);

    const u = body.data.user;

    const days = u.contributionsCollection.contributionCalendar.weeks
        .flatMap((w) => w.contributionDays)
        .map((d) => ({
            date: d.date,
            count: d.contributionCount,
            level: LEVELS[d.contributionLevel] || 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-DAYS);

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

    const lt = u.lifetime;
    return {
        days,
        langs,
        // Clockwise from the top: Commit, Issue, PullReq, Review, Repo.
        radar: [
            ['Commit', lt.totalCommitContributions],
            ['Issue', lt.totalIssueContributions],
            ['PullReq', lt.totalPullRequestContributions],
            ['Review', lt.totalPullRequestReviewContributions],
            ['Repo', u.repositories.totalCount],
        ],
        stats: {
            repos: u.repositories.totalCount,
            stars: repos.reduce((s, r) => s + r.stargazerCount, 0),
            forks: repos.reduce((s, r) => s + r.forkCount, 0),
            followers: u.followers.totalCount,
        },
    };
}

function mockAll() {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const today = new Date();
    const days = Array.from({ length: DAYS }, (_, i) => {
        const d = new Date(today.getTime() - (DAYS - 1 - i) * 864e5);
        const weekend = [0, 6].includes(d.getUTCDay());
        const count = Math.floor(rnd() * (weekend ? 4 : 14));
        const level = count === 0 ? 0 : count < 3 ? 1 : count < 6 ? 2 : count < 10 ? 3 : 4;
        return { date: d.toISOString().slice(0, 10), count, level };
    });
    return {
        days,
        langs: [
            { name: 'Python', size: 412000, color: '#3572A5' },
            { name: 'JavaScript', size: 339000, color: '#f1e05a' },
            { name: 'Go', size: 118000, color: '#00ADD8' },
            { name: 'Jupyter Notebook', size: 83000, color: '#DA5B0B' },
            { name: 'TypeScript', size: 38000, color: '#3178c6' },
        ],
        radar: [
            ['Commit', 486], ['Issue', 27], ['PullReq', 39],
            ['Review', 12], ['Repo', 14],
        ],
        stats: { repos: 14, stars: 37, forks: 6, followers: 21 },
    };
}

// ---------------------------------------------------------------- helpers

const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmt = (n) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;

const shade = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
        Math.max(0, Math.min(255, Math.round(c * f))),
    );
    return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
};

const polar = (cx, cy, r, deg) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};

const f2 = (n) => n.toFixed(2);

const fadeIn = (begin, dur = 0.5) =>
    `<animate attributeName="opacity" from="0" to="1" dur="${dur}s" ` +
    `begin="${begin.toFixed(2)}s" fill="freeze"/>`;

// ---------------------------------------------------------------- iso map

const faces = (cx, cy, h) => ({
    top: [
        [cx, cy - h],
        [cx + TILE_W / 2, cy - h + TILE_H / 2],
        [cx, cy - h + TILE_H],
        [cx - TILE_W / 2, cy - h + TILE_H / 2],
    ],
    left: [
        [cx - TILE_W / 2, cy - h + TILE_H / 2],
        [cx, cy - h + TILE_H],
        [cx, cy + TILE_H],
        [cx - TILE_W / 2, cy + TILE_H / 2],
    ],
    right: [
        [cx, cy - h + TILE_H],
        [cx + TILE_W / 2, cy - h + TILE_H / 2],
        [cx + TILE_W / 2, cy + TILE_H / 2],
        [cx, cy + TILE_H],
    ],
});

const pts = (p) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

function isoMap(days, t, animate) {
    const max = Math.max(1, ...days.map((d) => d.count));
    const first = new Date(days[0].date + 'T00:00:00Z');
    const shift = first.getUTCDay();

    const cells = days.map((d, i) => {
        const slot = shift + i;
        return { ...d, col: Math.floor(slot / 7), row: slot % 7 };
    });

    const xs = cells.map((c) => (c.col - c.row) * (TILE_W / 2));
    const minX = Math.min(...xs) - TILE_W / 2;
    const maxX = Math.max(...xs) + TILE_W / 2;

    const ox = ISO_CX - (minX + maxX) / 2;
    const oy = ISO_TOP + MAX_H;

    const ordered = [...cells].sort((a, b) => a.col + a.row - (b.col + b.row));

    return ordered
        .map((c) => {
            const cx = ox + (c.col - c.row) * (TILE_W / 2);
            const cy = oy + (c.col + c.row) * (TILE_H / 2);
            const h = c.count === 0 ? MIN_H : MIN_H + (c.count / max) * (MAX_H - MIN_H);

            const base = t.levels[c.level];
            const f = faces(cx, cy, h);
            const f0 = faces(cx, cy, MIN_H);
            const delay = ((c.col + c.row) * 0.045).toFixed(3);

            const poly = (fill, from, to) =>
                `<polygon points="${pts(animate ? from : to)}" fill="${fill}">` +
                (animate
                    ? `<animate attributeName="points" from="${pts(from)}" to="${pts(to)}" ` +
                      `dur="0.85s" begin="${delay}s" fill="freeze" calcMode="spline" ` +
                      `keyTimes="0;1" keySplines="0.2 0.9 0.3 1"/>`
                    : '') +
                '</polygon>';

            return (
                `<g><title>${c.date}: ${c.count}</title>` +
                poly(shade(base, 0.72), f0.left, f.left) +
                poly(shade(base, 0.55), f0.right, f.right) +
                poly(base, f0.top, f.top) +
                '</g>'
            );
        })
        .join('\n    ');
}

// ---------------------------------------------------------------- radar

function radar(axes, t, animate) {
    // Log scale: values here span orders of magnitude, so a linear radar would
    // collapse everything except commits into the centre.
    const peak = Math.max(1, ...axes.map(([, v]) => v));
    const decades = Math.max(1, Math.ceil(Math.log10(peak + 1)));
    const scale = (v) => (RAD_R * Math.log10(v + 1)) / Math.log10(10 ** decades + 1);

    const step = 360 / axes.length;
    const out = [];

    // Concentric rings, one per decade, labelled 1 / 10 / 100 / 1K ...
    for (let d = 1; d <= decades; d++) {
        const r = scale(10 ** d - 1);
        const ring = axes
            .map((_, i) => polar(RAD_CX, RAD_CY, r, i * step))
            .map(([x, y]) => `${f2(x)},${f2(y)}`)
            .join(' ');
        out.push(
            `<polygon points="${ring}" fill="none" stroke="${t.grid}" stroke-width="1"/>`,
        );
        out.push(
            `<text x="${RAD_CX + 4}" y="${f2(RAD_CY - r + 11)}" font-size="9" ` +
            `fill="${t.mut}" opacity="0.85">${fmt(10 ** d)}</text>`,
        );
    }

    // Spokes and axis labels.
    axes.forEach(([name, v], i) => {
        const [ex, ey] = polar(RAD_CX, RAD_CY, RAD_R, i * step);
        out.push(
            `<line x1="${RAD_CX}" y1="${RAD_CY}" x2="${f2(ex)}" y2="${f2(ey)}" ` +
            `stroke="${t.grid}" stroke-width="1"/>`,
        );

        const [lx, ly] = polar(RAD_CX, RAD_CY, RAD_R + 22, i * step);
        const anchor = Math.abs(lx - RAD_CX) < 2 ? 'middle' : lx > RAD_CX ? 'start' : 'end';
        out.push(
            `<text x="${f2(lx)}" y="${f2(ly + 4)}" font-size="11" font-weight="600" ` +
            `fill="${t.fg}" text-anchor="${anchor}">${esc(name)}</text>`,
        );
        out.push(
            `<text x="${f2(lx)}" y="${f2(ly + 17)}" font-size="10.5" ` +
            `fill="${t.mut}" text-anchor="${anchor}">${fmt(v)}</text>`,
        );
    });

    // The data polygon itself.
    const shape = axes
        .map(([, v], i) => polar(RAD_CX, RAD_CY, scale(v), i * step))
        .map(([x, y]) => `${f2(x)},${f2(y)}`)
        .join(' ');
    const flat = axes
        .map((_, i) => polar(RAD_CX, RAD_CY, 0, i * step))
        .map(([x, y]) => `${f2(x)},${f2(y)}`)
        .join(' ');

    out.push(
        `<polygon points="${animate ? flat : shape}" fill="${t.radar}" ` +
        `fill-opacity="0.28" stroke="${t.radar}" stroke-width="2" stroke-linejoin="round">` +
        (animate
            ? `<animate attributeName="points" from="${flat}" to="${shape}" dur="0.9s" ` +
              `begin="0.35s" fill="freeze" calcMode="spline" keyTimes="0;1" ` +
              `keySplines="0.2 0.9 0.3 1"/>`
            : '') +
        '</polygon>',
    );

    axes.forEach(([name, v], i) => {
        const [x, y] = polar(RAD_CX, RAD_CY, scale(v), i * step);
        out.push(
            `<circle cx="${f2(x)}" cy="${f2(y)}" r="3.5" fill="${t.radar}" ` +
            `opacity="${animate ? 0 : 1}"><title>${esc(name)}: ${v}</title>` +
            (animate ? fadeIn(1.05) : '') +
            '</circle>',
        );
    });

    return out.join('\n    ');
}

// ---------------------------------------------------------------- donut

function donutSegment(a0, a1) {
    if (a1 - a0 >= 359.999) {
        return donutSegment(a0, a0 + 180) + ' ' + donutSegment(a0 + 180, a0 + 359.999);
    }
    const large = a1 - a0 > 180 ? 1 : 0;
    const [ox0, oy0] = polar(DON_CX, DON_CY, DON_OUT, a0);
    const [ox1, oy1] = polar(DON_CX, DON_CY, DON_OUT, a1);
    const [ix1, iy1] = polar(DON_CX, DON_CY, DON_IN, a1);
    const [ix0, iy0] = polar(DON_CX, DON_CY, DON_IN, a0);
    return (
        `M${f2(ox0)},${f2(oy0)} A${DON_OUT},${DON_OUT} 0 ${large} 1 ${f2(ox1)},${f2(oy1)} ` +
        `L${f2(ix1)},${f2(iy1)} A${DON_IN},${DON_IN} 0 ${large} 0 ${f2(ix0)},${f2(iy0)} Z`
    );
}

function donut(langs, t, animate) {
    const top = langs.slice(0, TOP_N);
    const rest = langs.slice(TOP_N).reduce((s, l) => s + l.size, 0);
    const slices = rest > 0
        ? [...top, { name: 'Other', size: rest, color: OTHER_COLOR }]
        : top;
    const total = slices.reduce((s, l) => s + l.size, 0) || 1;

    let angle = 0;
    const arcs = slices.map((l, i) => {
        const sweep = (l.size / total) * 360;
        const d = donutSegment(angle, angle + sweep);
        angle += sweep;
        return (
            `<path d="${d}" fill="${l.color}" opacity="${animate ? 0 : 1}">` +
            `<title>${esc(l.name)}: ${((l.size / total) * 100).toFixed(1)}%</title>` +
            (animate ? fadeIn(0.5 + i * 0.08) : '') +
            '</path>'
        );
    });

    const LX = DON_CX + DON_OUT + 34;
    const legend = slices.map((l, i) => {
        const y = 400 + i * 21;
        const pct = ((l.size / total) * 100).toFixed(1);
        return (
            `<g opacity="${animate ? 0 : 1}">` +
            (animate ? fadeIn(0.65 + i * 0.06) : '') +
            `<rect x="${LX}" y="${y - 9}" width="10" height="10" rx="2.5" fill="${l.color}"/>` +
            `<text x="${LX + 17}" y="${y}" font-size="12" fill="${t.fg}">${esc(l.name)}</text>` +
            `<text x="${LX + 172}" y="${y}" font-size="12" fill="${t.mut}" ` +
            `text-anchor="end">${pct}%</text></g>`
        );
    });

    const topLang = slices[0] ? slices[0].name : '—';
    const label =
        `<text x="${DON_CX}" y="${DON_CY - 1}" font-size="12.5" font-weight="600" ` +
        `fill="${t.fg}" text-anchor="middle">${esc(topLang)}</text>` +
        `<text x="${DON_CX}" y="${DON_CY + 14}" font-size="9.5" fill="${t.mut}" ` +
        `text-anchor="middle">most used</text>`;

    return arcs.join('\n    ') + '\n    ' + label + '\n    ' + legend.join('\n    ');
}

// ---------------------------------------------------------------- compose

function render(data, { dark, animate, title }) {
    const t = dark ? DARK : LIGHT;
    const { days, langs, stats } = data;

    const total = days.reduce((s, d) => s + d.count, 0);
    const active = days.filter((d) => d.count > 0).length;
    const busiest = days.reduce((a, b) => (b.count > a.count ? b : a));

    const items = [
        ['Repos', stats.repos],
        ['Stars', stats.stars],
        ['Forks', stats.forks],
        ['Followers', stats.followers],
    ];
    const SX = 560;
    const colW = (W - PAD - SX) / items.length;
    const strip = items.map(([k, v], i) => {
        const x = SX + colW * i + colW / 2;
        return (
            `<g opacity="${animate ? 0 : 1}">` +
            (animate ? fadeIn(0.8 + i * 0.07) : '') +
            `<text x="${f2(x)}" y="432" font-size="21" font-weight="600" fill="${t.fg}" ` +
            `text-anchor="middle">${fmt(v)}</text>` +
            `<text x="${f2(x)}" y="450" font-size="10.5" fill="${t.mut}" ` +
            `text-anchor="middle">${k}</text></g>`
        );
    });

    const caption = `${total} contributions · ${active}/${DAYS} active days · peak ${busiest.count} on ${busiest.date}`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}: ${total} contributions in the last ${DAYS} days, ${stats.repos} repos, ${stats.stars} stars">
  <style>text{font-family:"Segoe UI",Ubuntu,Helvetica,Arial,sans-serif}</style>
  <rect width="${W}" height="${H}" fill="${t.bg}"/>

  <text x="${PAD}" y="34" font-size="17" font-weight="600" fill="${t.fg}">${esc(title)}</text>
  <text x="${PAD}" y="52" font-size="11.5" fill="${t.mut}">${esc(caption)}</text>
  <text x="${W - PAD}" y="34" font-size="11.5" fill="${t.mut}" text-anchor="end">lifetime activity</text>

  <g>
    ${isoMap(days, t, animate)}
  </g>

  <g>
    ${radar(data.radar, t, animate)}
  </g>

  <line x1="${PAD}" y1="${SPLIT}" x2="${W - PAD}" y2="${SPLIT}" stroke="${t.line}"/>
  <text x="${PAD}" y="${SPLIT + 22}" font-size="11" font-weight="600" fill="${t.mut}">LANGUAGES</text>
  <text x="${SX}" y="${SPLIT + 22}" font-size="11" font-weight="600" fill="${t.mut}">PROFILE</text>

  <g>
    ${donut(langs, t, animate)}
  </g>

  ${strip.join('\n  ')}
</svg>
`;
}

// ---------------------------------------------------------------- main

const user = flag('user', process.env.GH_USER || 'deepakvamsi');
const out = flag('out', 'assets/contrib-graph/profile.svg');

const data = has('mock')
    ? mockAll()
    : await (async () => {
          const token = process.env.GITHUB_TOKEN;
          if (!token) {
              console.error('GITHUB_TOKEN is not set. Use --mock for a preview with synthetic data.');
              process.exit(1);
          }
          return fetchAll(user, token);
      })();

const { mkdirSync, writeFileSync } = await import('fs');
const { dirname } = await import('path');

const title = `@${user}`;
for (const [suffix, dark] of [
    ['', false],
    ['-dark', true],
]) {
    const file = out.replace(/\.svg$/, `${suffix}.svg`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, render(data, { dark, animate: true, title }));
    console.log(`wrote ${file}`);
}
