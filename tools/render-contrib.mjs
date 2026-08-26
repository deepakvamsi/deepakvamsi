#!/usr/bin/env node
// Renders an isometric SVG of the last N days of GitHub contributions.
// No dependencies: node >= 18 (global fetch), plain string templating.
//
//   GITHUB_TOKEN=... node tools/render-contrib.mjs --user deepakvamsi
//   node tools/render-contrib.mjs --mock          # synthetic data, no token

const DAYS = 30;

const TILE_W = 26; // isometric tile width
const TILE_H = 15; // isometric tile depth
const MAX_H = 62; // tallest bar, px
const MIN_H = 3; // a zero-contribution day is still a visible slab
const PAD = 34;

// GitHub contribution greens: [empty, l1, l2, l3, l4]
const PALETTE = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];
const DARK_PALETTE = ['#2d333b', '#0e4429', '#006d32', '#26a641', '#39d353'];

const args = process.argv.slice(2);
const flag = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);

// ---------------------------------------------------------------- data

const QUERY = `query($login:String!, $from:DateTime!, $to:DateTime!) {
  user(login:$login) {
    contributionsCollection(from:$from, to:$to) {
      contributionCalendar {
        weeks { contributionDays { date contributionCount contributionLevel } }
      }
    }
  }
}`;

const LEVELS = {
    NONE: 0,
    FIRST_QUARTILE: 1,
    SECOND_QUARTILE: 2,
    THIRD_QUARTILE: 3,
    FOURTH_QUARTILE: 4,
};

async function fetchDays(login, token) {
    const to = new Date();
    const from = new Date(to.getTime() - (DAYS - 1) * 864e5);
    from.setUTCHours(0, 0, 0, 0);

    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
            Authorization: `bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'render-contrib',
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

    return body.data.user.contributionsCollection.contributionCalendar.weeks
        .flatMap((w) => w.contributionDays)
        .map((d) => ({
            date: d.date,
            count: d.contributionCount,
            level: LEVELS[d.contributionLevel] || 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-DAYS);
}

function mockDays() {
    // Deterministic pseudo-random so repeated previews are comparable.
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const today = new Date();
    return Array.from({ length: DAYS }, (_, i) => {
        const d = new Date(today.getTime() - (DAYS - 1 - i) * 864e5);
        const weekend = [0, 6].includes(d.getUTCDay());
        const count = Math.floor(rnd() * (weekend ? 4 : 14));
        const level = count === 0 ? 0 : count < 3 ? 1 : count < 6 ? 2 : count < 10 ? 3 : 4;
        return { date: d.toISOString().slice(0, 10), count, level };
    });
}

// ---------------------------------------------------------------- render

const shade = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
        Math.max(0, Math.min(255, Math.round(c * f))),
    );
    return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
};

// Isometric block faces for a bar of height h whose base-tile centre is (cx, cy).
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

const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function render(days, { dark, animate, title }) {
    const pal = dark ? DARK_PALETTE : PALETTE;
    const fg = dark ? '#adbac7' : '#57606a';
    const bg = dark ? '#22272e' : '#ffffff';

    const max = Math.max(1, ...days.map((d) => d.count));

    const total = days.reduce((s, d) => s + d.count, 0);
    const busiest = days.reduce((a, b) => (b.count > a.count ? b : a));
    const active = days.filter((d) => d.count > 0).length;
    const caption = `${total} contributions · ${active}/${DAYS} active days · peak ${busiest.count} on ${busiest.date}`;

    // Column = week, row = weekday. Week 0 is the week containing the oldest day.
    const first = new Date(days[0].date + 'T00:00:00Z');
    const originShift = first.getUTCDay();

    const cells = days.map((d, i) => {
        const slot = originShift + i;
        return { ...d, col: Math.floor(slot / 7), row: slot % 7 };
    });

    const cols = Math.max(...cells.map((c) => c.col)) + 1;

    // Measure the raw isometric extent at origin (0,0), then translate so the
    // whole diamond — including the tallest bar — sits inside the viewport.
    const xs = cells.map((c) => (c.col - c.row) * (TILE_W / 2));
    const ys = cells.map((c) => (c.col + c.row) * (TILE_H / 2));
    const minX = Math.min(...xs) - TILE_W / 2;
    const maxX = Math.max(...xs) + TILE_W / 2;
    const maxY = Math.max(...ys) + TILE_H;

    const TITLE_Y = 26;
    const headroom = TITLE_Y + 14 + MAX_H; // title baseline + gap + tallest bar

    // Captions are wider than the diamond at this tile size, so the canvas
    // width is whichever of the two actually needs the room.
    const captionW = Math.ceil(caption.length * 5.6) + PAD * 2;
    const diamondW = Math.ceil(maxX - minX + PAD * 2);
    const W = Math.max(diamondW, captionW);
    const H = Math.ceil(headroom + maxY + PAD + 10);

    // Centre the diamond when the caption is what widened the canvas.
    const ox = (W - (maxX - minX)) / 2 - minX;
    const oy = headroom;

    // Painter's algorithm: smaller (col + row) is further back.
    const ordered = [...cells].sort((a, b) => a.col + a.row - (b.col + b.row));

    const blocks = ordered
        .map((c) => {
            const cx = ox + (c.col - c.row) * (TILE_W / 2);
            const cy = oy + (c.col + c.row) * (TILE_H / 2);
            const h = c.count === 0 ? MIN_H : MIN_H + (c.count / max) * (MAX_H - MIN_H);

            const base = pal[c.level];
            const f = faces(cx, cy, h);
            const f0 = faces(cx, cy, MIN_H);
            const delay = ((c.col + c.row) * 0.045).toFixed(3);

            const poly = (fill, from, to) => {
                const anim = animate
                    ? `<animate attributeName="points" from="${pts(from)}" to="${pts(to)}" ` +
                      `dur="0.85s" begin="${delay}s" fill="freeze" ` +
                      `calcMode="spline" keyTimes="0;1" keySplines="0.2 0.9 0.3 1"/>`
                    : '';
                return `<polygon points="${pts(animate ? from : to)}" fill="${fill}">${anim}</polygon>`;
            };

            return (
                `<g><title>${c.date}: ${c.count}</title>` +
                poly(shade(base, 0.72), f0.left, f.left) +
                poly(shade(base, 0.55), f0.right, f.right) +
                poly(base, f0.top, f.top) +
                '</g>'
            );
        })
        .join('\n    ');

    const label = (x, y, text, size, weight, opacity = 1) =>
        `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" ` +
        `fill="${fg}" opacity="${opacity}" ` +
        `font-family="Segoe UI, Ubuntu, Helvetica, Arial, sans-serif">${esc(text)}</text>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}: ${total} contributions in the last ${DAYS} days">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  ${label(PAD, 26, title, 15, 600)}
  ${label(PAD, H - PAD + 18, caption, 11, 400, 0.75)}
  <g>
    ${blocks}
  </g>
</svg>
`;
}

// ---------------------------------------------------------------- main

const user = flag('user', process.env.GH_USER || 'deepakvamsi');
const out = flag('out', 'assets/contrib-graph/contributions-3d.svg');

const days = has('mock')
    ? mockDays()
    : await (async () => {
          const token = process.env.GITHUB_TOKEN;
          if (!token) {
              console.error('GITHUB_TOKEN is not set. Use --mock for a preview with synthetic data.');
              process.exit(1);
          }
          return fetchDays(user, token);
      })();

const { mkdirSync, writeFileSync } = await import('fs');
const { dirname } = await import('path');

const title = `@${user} — last ${DAYS} days`;
for (const [suffix, dark] of [
    ['', false],
    ['-dark', true],
]) {
    const file = out.replace(/\.svg$/, `${suffix}.svg`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, render(days, { dark, animate: true, title }));
    console.log(`wrote ${file}`);
}
