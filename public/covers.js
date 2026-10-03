// Generated cover art, one motif per topic, seeded by the story id so a story always gets the same
// picture. No remote images. The markup is built only from numbers and constants (never from story
// text), which is what makes assigning it with innerHTML safe.

const W = 400;
const H = 250;

function rng(seed) {
  let a = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    a ^= seed.charCodeAt(i);
    a = Math.imul(a, 16777619);
  }
  return () => {
    a += 0x6d2b79f5;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// [dark, light] gradient stops, all in the green-teal family
const HUE = {
  ai: ['#032b22', '#12a47a'],
  econ: ['#04261f', '#0e8f68'],
  crypto: ['#06231f', '#1db8a0'],
  mkt: ['#0a2a1b', '#3aa660'],
  re: ['#052920', '#1a9d82'],
  trade: ['#032a2b', '#0f9ba0'],
  startup: ['#0b2b18', '#4cbf6b'],
  fin: ['#052b21', '#17a67d'],
};

export const MOTIF_OF = {
  'AI & Tech': 'ai',
  Economics: 'econ',
  Crypto: 'crypto',
  Marketing: 'mkt',
  'Real Estate': 're',
  'Global Trade': 'trade',
  'VC & Startups': 'startup',
  General: 'fin',
};

const f0 = (n) => n.toFixed(0);

const MOTIF = {
  ai(r) {
    const n = [];
    for (let i = 0; i < 16; i++) n.push([20 + r() * 360, 15 + r() * 220, 2.5 + r() * 4]);
    let o = '';
    for (let i = 0; i < n.length; i++)
      for (let j = i + 1; j < n.length; j++) {
        const d = Math.hypot(n[i][0] - n[j][0], n[i][1] - n[j][1]);
        if (d < 125) o += `<path d="M${f0(n[i][0])} ${f0(n[i][1])}L${f0(n[j][0])} ${f0(n[j][1])}" stroke="#fff" stroke-opacity="${(0.34 - d / 420).toFixed(2)}"/>`;
      }
    return o + n.map((p) => `<circle cx="${f0(p[0])}" cy="${f0(p[1])}" r="${p[2].toFixed(1)}" fill="#fff" fill-opacity=".8"/>`).join('');
  },
  econ(r) {
    let o = '';
    for (let i = 1; i < 5; i++) o += `<path d="M0 ${i * 50}H400" stroke="#fff" stroke-opacity=".12"/>`;
    const line = (y0, drift, op, w) => {
      let y = y0;
      let d = `M0 ${f0(y)}`;
      for (let x = 40; x <= 400; x += 40) {
        y = Math.max(20, Math.min(230, y - drift + (r() - 0.5) * 46));
        d += `L${x} ${f0(y)}`;
      }
      return `<path d="${d}L400 250L0 250Z" fill="#fff" fill-opacity="${(op / 6).toFixed(2)}"/><path d="${d}" fill="none" stroke="#fff" stroke-opacity="${op}" stroke-width="${w}" stroke-linejoin="round"/>`;
    };
    return o + line(200, 4, 0.3, 1.5) + line(215, 15, 0.9, 3);
  },
  fin(r) {
    let o = '';
    for (let i = 1; i < 5; i++) o += `<path d="M0 ${i * 50}H400" stroke="#fff" stroke-opacity=".1"/>`;
    let y = 150 + r() * 30;
    for (let x = 22; x < 400; x += 27) {
      const up = r() > 0.42;
      const hgt = 14 + r() * 46;
      const top = Math.max(24, Math.min(200, y - (up ? hgt : 0)));
      const wick = 8 + r() * 18;
      o += `<path d="M${x} ${f0(top - wick)}V${f0(top + hgt + wick)}" stroke="#fff" stroke-opacity=".6"/><rect x="${x - 7}" y="${f0(top)}" width="14" height="${f0(hgt)}" rx="2" fill="#fff" fill-opacity="${up ? '.85' : '.22'}" stroke="#fff" stroke-opacity=".6"/>`;
      y = up ? top : top + hgt;
      y = Math.max(50, Math.min(210, y));
    }
    return o;
  },
  crypto(r) {
    let o = '';
    const R = 27;
    const hx = R * Math.sqrt(3);
    for (let row = -1; row < 7; row++)
      for (let col = -1; col < 9; col++) {
        const cx = col * hx + (row % 2 ? hx / 2 : 0);
        const cy = row * R * 1.5;
        let p = '';
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 180) * (60 * k - 30);
          p += `${k ? 'L' : 'M'}${(cx + R * Math.cos(a)).toFixed(1)} ${(cy + R * Math.sin(a)).toFixed(1)}`;
        }
        const f = r();
        o += `<path d="${p}Z" fill="#fff" fill-opacity="${f > 0.8 ? 0.34 : f > 0.6 ? 0.12 : 0}" stroke="#fff" stroke-opacity=".2"/>`;
      }
    return o;
  },
  mkt(r) {
    let o = '';
    const cx = 250 + r() * 90;
    const cy = 70 + r() * 70;
    for (let i = 1; i < 7; i++) o += `<circle cx="${f0(cx)}" cy="${f0(cy)}" r="${i * 26}" fill="none" stroke="#fff" stroke-opacity="${(0.5 - i * 0.06).toFixed(2)}" stroke-width="${i === 2 ? 3 : 1.2}"/>`;
    o += `<circle cx="${f0(cx)}" cy="${f0(cy)}" r="9" fill="#fff"/>`;
    for (let i = 0; i < 9; i++) {
      const a = -0.15 - i * 0.11;
      o += `<path d="M30 230L${f0(30 + Math.cos(a) * 460)} ${f0(230 + Math.sin(a) * 460)}" stroke="#fff" stroke-opacity="${(0.07 + r() * 0.2).toFixed(2)}"/>`;
    }
    return o;
  },
  re(r) {
    let o = '';
    let x = -6;
    while (x < 400) {
      const w = 26 + r() * 40;
      const hgt = 50 + r() * 150;
      const op = 0.1 + r() * 0.22;
      o += `<rect x="${f0(x)}" y="${f0(250 - hgt)}" width="${f0(w)}" height="${f0(hgt)}" fill="#fff" fill-opacity="${op.toFixed(2)}"/>`;
      for (let wy = 250 - hgt + 10; wy < 240; wy += 14) for (let wx = x + 6; wx < x + w - 6; wx += 10) if (r() > 0.5) o += `<rect x="${f0(wx)}" y="${f0(wy)}" width="4" height="6" fill="#fff" fill-opacity=".6"/>`;
      x += w + 4;
    }
    return o;
  },
  trade(r) {
    const cx = 260 + r() * 50;
    const cy = 120 + r() * 20;
    const R = 100;
    let o = `<circle cx="${f0(cx)}" cy="${f0(cy)}" r="${R}" fill="#fff" fill-opacity=".07" stroke="#fff" stroke-opacity=".5" stroke-width="1.5"/>`;
    for (const k of [0.3, 0.62, 0.9]) o += `<ellipse cx="${f0(cx)}" cy="${f0(cy)}" rx="${f0(R * k)}" ry="${R}" fill="none" stroke="#fff" stroke-opacity=".24"/>`;
    for (const dy of [-55, 0, 55]) {
      const half = Math.sqrt(R * R - dy * dy);
      o += `<path d="M${f0(cx - half)} ${f0(cy + dy)}H${f0(cx + half)}" stroke="#fff" stroke-opacity=".24"/>`;
    }
    for (let i = 0; i < 4; i++) {
      const x0 = 20 + r() * 80;
      const y0 = 40 + r() * 180;
      const x1 = cx - 60 + r() * 120;
      const y1 = cy - 60 + r() * 120;
      o += `<path d="M${f0(x0)} ${f0(y0)}Q${f0((x0 + x1) / 2)} ${f0(Math.min(y0, y1) - 60)} ${f0(x1)} ${f0(y1)}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.6" stroke-dasharray="5 5"/><circle cx="${f0(x0)}" cy="${f0(y0)}" r="4" fill="#fff"/><circle cx="${f0(x1)}" cy="${f0(y1)}" r="4" fill="#fff"/>`;
    }
    return o;
  },
  startup(r) {
    const ex = 330 + r() * 40;
    const ey = 30 + r() * 30;
    let o = `<path d="M10 235Q${f0(160 + r() * 80)} 230 ${f0(ex)} ${f0(ey)}" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="2.5"/>`;
    for (let i = 1; i <= 6; i++) {
      const k = i / 6;
      o += `<circle cx="${f0(10 + (ex - 10) * k)}" cy="${f0(235 - (235 - ey) * k * k)}" r="${(3 + i * 3.2).toFixed(1)}" fill="#fff" fill-opacity="${(0.1 + k * 0.3).toFixed(2)}" stroke="#fff" stroke-opacity=".55"/>`;
    }
    for (let i = 0; i < 22; i++) o += `<circle cx="${f0(r() * 400)}" cy="${f0(r() * 190)}" r="${(0.8 + r() * 1.4).toFixed(1)}" fill="#fff" fill-opacity=".5"/>`;
    return o;
  },
};

let uid = 0;

/** Markup for one cover: a gradient plus the motif for the story's topic. */
export function coverMarkup(id, category) {
  const key = MOTIF_OF[category] ?? 'fin';
  const [dark, light] = HUE[key];
  const r = rng(String(id));
  const angle = Math.floor(r() * 60) - 30;
  const gid = `cg${++uid}`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><linearGradient id="${gid}" gradientTransform="rotate(${angle} .5 .5)" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#${gid})"/>${MOTIF[key](r)}</svg>`;
}
