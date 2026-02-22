const { useState, useEffect, useRef, useCallback } = React;

// ─── Palette: warm stone gallery ───
const C = {
  bg: "#f5f1eb",
  surface: "#fffdf9",
  surfaceAlt: "#eee9e1",
  card: "#fffdf9",
  border: "#ddd7cd",
  borderLight: "#ece7df",

  brand: "#2c2341",
  brandSoft: "rgba(44,35,65,0.06)",

  action: "#c44a2d",
  actionSoft: "rgba(196,74,45,0.07)",

  gold: "#b8892e",
  goldSoft: "rgba(184,137,46,0.09)",
  goldGlow: "rgba(184,137,46,0.18)",

  green: "#3d7a56",
  greenSoft: "rgba(61,122,86,0.07)",

  text: "#1c1916",
  textMid: "#726b62",
  textDim: "#a8a199",
  textInverse: "#faf8f5",

  // CS2 rarity — sacred, never reinterpreted
  rConsumer: "#b0c3d9",
  rIndustrial: "#5e98d9",
  rMilSpec: "#4b69ff",
  rRestricted: "#8847ff",
  rClassified: "#d32ce6",
  rCovert: "#eb4b4b",
  rGold: "#e4ae39",
  rRoblox: "#0085ff",
};

// ─── Items with real Steam CDN images ───
const ITEMS = {
  ak_redline: { n: "AK-47 | Redline", c: "Field-Tested", g: "CS2", r: C.rClassified, v: 42.50, cat: "Rifle",
    img: "https://community.fastly.steamstatic.com/economy/image/-9a81dlWLwJ2UXnDHljBnVJrt6Z-JCjTYBVUhfH_OD0RcLoa-FN_WdGaLO45PTh1RxPfO6LAFgRZRY-dHuLpQvr_h52CHFp7ITtRubupZVZn1vGaK2twgUO-9wmXbkvmpMeqJxjgJbMco6abotu0xQ" },
  awp_asiimov: { n: "AWP | Asiimov", c: "Battle-Scarred", g: "CS2", r: C.rCovert, v: 28.90, cat: "Sniper",
    img: "https://community.fastly.steamstatic.com/economy/image/-9a81dlWLwJ2UXnDHljBnVJrt6Z-JCjTYBVUhfH_OD0RcLoa-FN_WdGaLO45PTh1RxPfO6LAFgRZRY-dHuLpQvb_h56FEhB0IANWtbumIThfwOb3dzxG7eJyJl4XSkab9Y-uExGgFuoZw3riWoY6g3wewgBPiSVWV" },
  butterfly_fade: { n: "★ Butterfly Knife | Fade", c: "Factory New", g: "CS2", r: C.rGold, v: 1850.00, cat: "Knife",
    img: "https://community.fastly.steamstatic.com/economy/image/-9a81dlWLwJ2UXnDHljBnVJrt6Z-JCjTYBVUhfH_OD0RcLoa-FN_WdGaLO45PTh1RxPfO6LAFgRZRY-dHuLpQvb_h52CEhB2PhtWsLBtwZ_KaczJM0hG09oji5NaKl3j1PYTTl2VQ5MBOhuXF-tug0RrirUY_N2HzJ4KUdQY3Yl-E-ljvw-u605e1ot2XnGwj5HeXI3Lbnho" },
  sport_gloves: { n: "Sport Gloves | Hedge Maze", c: "Field-Tested", g: "CS2", r: C.rGold, v: 385.00, cat: "Gloves",
    img: "https://community.fastly.steamstatic.com/economy/image/-9a81dlWLwJ2UXnDHljBnVJrt6Z-JCjTYBVUhfH_OD0RcLoa-FN_WdGaLO45PTh1RxPfO6LAFgRZRY-dHuLpQvb_h52CFzp7L6NFTtbKkJQhhwczFdC9O5dq1lYKGlvL1NbXUk1Rd5cF4j-r--YXygBq38kJoZ2inddOcdgY8aF3Y8lC9xOq5hJK96s7LySdh6CYq4yyIllON0B0faqFnxa-fAhdBAh_0SQ" },
  kara_doppler: { n: "★ Karambit | Doppler", c: "Factory New", g: "CS2", r: C.rGold, v: 920.00, cat: "Knife",
    img: "https://community.fastly.steamstatic.com/economy/image/-9a81dlWLwJ2UXnDHljBnVJrt6Z-JCjTYBVUhfH_OD0RcLoa-FN_WdGaLO45PTh1RxPfO6LAFgRZRY-dHuLpQvb_h52CEhB2PhtWsLBtwZiZNPuidy1G-kpfG4-T2a9P9NLvAz2kB65En2L7Ho9it3g3n80dtMDrwJ4aUdwY8ZlrZ_1S3wue-80cS1vJqYyCV9-n51WbN0fw" },
  deagle_blaze: { n: "Desert Eagle | Blaze", c: "Factory New", g: "CS2", r: C.rRestricted, v: 340.00, cat: "Pistol",
    img: "https://community.fastly.steamstatic.com/economy/image/-9a81dlWLwJ2UXnDHljBnVJrt6Z-JCjTYBVUhfH_OD0RcLoa-FN_WdGaLO45PTh1RxPfO6LAFgRZRY-dHuLpQvb_h52CEhB2PhtRsLBtwdHNd_sTawVLud23loTSkvmiY-iJlD8A7sQg2LvFpI6j0Qzg_UNqYmmxI9fGJFM3M1uG-1jrx-y9h5e4ot2XnGwj5HeXkXjblEE" },
  glock_fade: { n: "Glock-18 | Fade", c: "Factory New", g: "CS2", r: C.rRestricted, v: 1240.00, cat: "Pistol",
    img: "https://community.fastly.steamstatic.com/economy/image/-9a81dlWLwJ2UXnDHljBnVJrt6Z-JCjTYBVUhfH_OD0RcLoa-FN_WdGaLO45PTh1RxPfO6LAFgRZRY-dHuLpQvb_h52CEhB2PhtWsLBtwdOicxPP3dD9S7eKxxoXcx6_wZb_Txm4Eu5Yo2L_Hpd-g2g3i_xFqYG6lJIOXegNoYQ7MrgS_k-i-g5C1u52bnXJl7C0n7SKJzUDk" },
  m4a1_hyper: { n: "M4A1-S | Hyper Beast", c: "Minimal Wear", g: "CS2", r: C.rCovert, v: 38.75, cat: "Rifle",
    img: "https://community.fastly.steamstatic.com/economy/image/-9a81dlWLwJ2UXnDHljBnVJrt6Z-JCjTYBVUhfH_OD0RcLoa-FN_WdGaLO45PTh1RxPfO6LAFgRZRY-dHuLpQvr_h52CHFp7ITtRubupZlNn1vGbKV0gIrgx4T3lYT0YL7QlDABvpUp0u_Epdqi31Xg_0VqZDjxJoOcJgU7Yl-F-FG3k-i-08G46JqJlQ" },
  arcana_jugg: { n: "Bladeform Legacy", c: "Arcana", g: "Dota 2", r: C.rClassified, v: 28.50, cat: "Arcana" },
  roblox_dominus: { n: "Dominus Empyreus", c: "Limited", g: "Roblox", r: C.rRoblox, v: 620.00, cat: "Hat" },
};

const MY_INV = ["sport_gloves", "deagle_blaze", "ak_redline", "awp_asiimov", "m4a1_hyper"];
const MY_LISTINGS = [
  { offer: "sport_gloves", want: "Any CS2 Knife, FT+", cycles: 4 },
  { offer: "deagle_blaze", want: "Butterfly or Karambit", cycles: 1 },
];

const PROPOSAL = {
  id: "CYC-7291", confidence: 87, expires: "23h 14m",
  legs: [
    { user: "You", give: "sport_gloves", get: "kara_doppler", rel: 4.8 },
    { user: "kr4ken_", give: "kara_doppler", get: "glock_fade", rel: 4.6 },
    { user: "silkthread", give: "glock_fade", get: "sport_gloves", rel: 4.9 },
  ],
  fee: 13.48,
};

const MARKET = [
  { user: "fademaster", rel: 4.7, offer: "butterfly_fade", want: "Karambit Doppler + adds", cycles: 3 },
  { user: "neonpixel", rel: 4.3, offer: "kara_doppler", want: "Any Butterfly Knife", cycles: 7 },
  { user: "crystalcove", rel: 4.9, offer: "roblox_dominus", want: "CS2 Knife, any finish", cycles: 2 },
  { user: "tk_trader", rel: 4.5, offer: "m4a1_hyper", want: "AK skins, $35-50 range", cycles: 5 },
  { user: "vaultkeeper", rel: 5.0, offer: "deagle_blaze", want: "Sport Gloves or similar", cycles: 4, house: true },
  { user: "glovegang", rel: 4.4, offer: "glock_fade", want: "Sport Gloves / Specialist", cycles: 4 },
];

const LIVE_FEED = [
  { user: "phantom_x", action: "completed a 3-way cycle", time: "2m ago", value: "$840" },
  { user: "skinvault", action: "listed ★ M9 Bayonet | Lore", time: "4m ago", value: "$520" },
  { user: "nightshift", action: "completed a 2-way swap", time: "7m ago", value: "$190" },
];

// ─── Helpers ───
function fv(v) { return v >= 1000 ? `$${(v/1000).toFixed(1)}k` : `$${v.toFixed(0)}`; }

// Category abstract mark instead of emoji
function CatMark({ cat, rarity, size = 32 }) {
  const shapes = {
    Knife: "M6 2L18 14L14 18L2 6Z",
    Gloves: "M4 8C4 4 8 2 12 2S20 4 20 8V18C20 20 18 22 16 22H8C6 22 4 20 4 18V8Z",
    Rifle: "M2 11H18L22 8V16L18 13H2V11Z",
    Sniper: "M1 12H23M12 4V20M6 7L18 17M18 7L6 17",
    Pistol: "M4 8H16L20 12V18H12L8 14H4V8Z",
    Arcana: "M12 2L22 12L12 22L2 12Z",
    Hat: "M4 14C4 14 4 8 12 8S20 14 20 14H4ZM8 14V20H16V14",
  };
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.3,
      background: `linear-gradient(135deg, ${rarity}18, ${rarity}08)`,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none">
        <path d={shapes[cat] || shapes.Rifle} stroke={rarity} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
      </svg>
    </div>
  );
}

window.App = App;

// Item display — gallery-style with real images
function ItemDisplay({ k, size = "md", glow = false, showPrice = true, onClick }) {
  const it = ITEMS[k];
  if (!it) return null;
  const s = size === "hero" ? 160 : size === "lg" ? 100 : size === "md" ? 72 : 56;
  const [imgOk, setImgOk] = useState(!!it.img);

  return (
    <div onClick={onClick} style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      cursor: onClick ? "pointer" : "default",
    }}>
      <div style={{
        width: s, height: s, borderRadius: s > 100 ? 24 : s > 64 ? 16 : 12,
        background: glow
          ? `radial-gradient(circle at 50% 60%, ${it.r}12 0%, ${C.surfaceAlt} 70%)`
          : C.surfaceAlt,
        border: glow ? `2px solid ${it.r}40` : `1px solid ${C.border}`,
        boxShadow: glow
          ? `0 8px 32px ${it.r}18, 0 2px 8px rgba(0,0,0,0.06)`
          : `0 1px 4px rgba(0,0,0,0.04)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        overflow: "hidden", position: "relative",
        transition: "all 0.3s ease",
      }}>
        {/* Rarity bar — bottom */}
        <div style={{
          position: "absolute", bottom: 0, left: "15%", right: "15%", height: 2,
          background: it.r, borderRadius: 1, opacity: 0.5,
        }} />
        {/* Game badge for non-CS2 */}
        {it.g !== "CS2" && (
          <div style={{
            position: "absolute", top: s > 80 ? 8 : 4, right: s > 80 ? 8 : 4,
            fontSize: s > 80 ? 9 : 7, padding: "2px 6px", borderRadius: 4,
            background: it.r, color: "#fff", fontWeight: 700, letterSpacing: 0.3,
          }}>{it.g}</div>
        )}
        {imgOk ? (
          <img
            src={it.img} alt={it.n}
            style={{ width: s * 0.78, height: s * 0.78, objectFit: "contain" }}
            onError={() => setImgOk(false)}
          />
        ) : (
          <CatMark cat={it.cat} rarity={it.r} size={s * 0.5} />
        )}
      </div>
      {showPrice && (
        <span style={{
          fontSize: s > 80 ? 14 : 11, fontWeight: 700, color: C.text,
          marginTop: s > 80 ? 8 : 5,
        }}>{fv(it.v)}</span>
      )}
    </div>
  );
}

function Pill({ children, color = C.brand, filled = false }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      fontSize: 11, fontWeight: 600,
      color: filled ? "#fff" : color,
      background: filled ? color : `${color}0d`,
      padding: "3px 10px", borderRadius: 20, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function Rel({ s }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      {[1,2,3,4,5].map(i => (
        <span key={i} style={{
          width: 4, height: 4, borderRadius: 2,
          background: i <= Math.round(s) ? C.gold : C.border,
        }} />
      ))}
      <span style={{ fontSize: 10, color: C.textMid, fontWeight: 600, marginLeft: 1 }}>{s.toFixed(1)}</span>
    </span>
  );
}

// ─── Cycle Reveal: items ARE the nodes ───
function CycleItems({ legs }) {
  const ref = useRef(null);
  const anim = useRef(0);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    ctx.scale(dpr, dpr);
    let f = 0;
    const n = legs.length;
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.28;

    // positions for items (drawn by React, this canvas just does connections)
    function draw() {
      f++;
      ctx.clearRect(0, 0, w, h);

      for (let i = 0; i < n; i++) {
        const a1 = (Math.PI * 2 * i) / n - Math.PI / 2;
        const a2 = (Math.PI * 2 * ((i + 1) % n)) / n - Math.PI / 2;
        const x1 = cx + Math.cos(a1) * R, y1 = cy + Math.sin(a1) * R;
        const x2 = cx + Math.cos(a2) * R, y2 = cy + Math.sin(a2) * R;
        const ma = (a1 + a2) / 2 + (a2 < a1 ? Math.PI : 0);
        const cpx = cx + Math.cos(ma) * R * 0.35;
        const cpy = cy + Math.sin(ma) * R * 0.35;

        // Soft arc
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo(cpx, cpy, x2, y2);
        ctx.strokeStyle = "rgba(184,137,46,0.15)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Flowing dot
        const t = ((f * 0.005) % 1);
        const px = (1-t)*(1-t)*x1 + 2*(1-t)*t*cpx + t*t*x2;
        const py = (1-t)*(1-t)*y1 + 2*(1-t)*t*cpy + t*t*y2;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(184,137,46,0.5)";
        ctx.fill();

        // Arrow near target
        const at = 0.82;
        const ax = (1-at)*(1-at)*x1 + 2*(1-at)*at*cpx + at*at*x2;
        const ay = (1-at)*(1-at)*y1 + 2*(1-at)*at*cpy + at*at*y2;
        const dx = x2-ax, dy = y2-ay;
        const ang = Math.atan2(dy, dx);
        ctx.beginPath();
        ctx.moveTo(ax + Math.cos(ang)*6, ay + Math.sin(ang)*6);
        ctx.lineTo(ax + Math.cos(ang+2.6)*5, ay + Math.sin(ang+2.6)*5);
        ctx.lineTo(ax + Math.cos(ang-2.6)*5, ay + Math.sin(ang-2.6)*5);
        ctx.fillStyle = "rgba(184,137,46,0.3)";
        ctx.fill();
      }

      anim.current = requestAnimationFrame(draw);
    }
    draw();
    return () => cancelAnimationFrame(anim.current);
  }, [legs]);

  const n = legs.length;
  const positions = legs.map((_, i) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return { x: 50 + Math.cos(a) * 28, y: 50 + Math.sin(a) * 28 };
  });

  return (
    <div style={{ position: "relative", width: "100%", height: 280 }}>
      <canvas ref={ref} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
      {/* Item images overlaid at node positions */}
      {legs.map((leg, i) => {
        const pos = positions[i];
        const it = ITEMS[leg.give];
        return (
          <div key={i} style={{
            position: "absolute",
            left: `${pos.x}%`, top: `${pos.y}%`,
            transform: "translate(-50%, -50%)",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
          }}>
            <ItemDisplay k={leg.give} size="sm" showPrice={false} glow={i === 0} />
            <span style={{
              fontSize: 11, fontWeight: 700,
              color: i === 0 ? C.gold : C.text,
              maxWidth: 80, textAlign: "center", lineHeight: 1.2,
            }}>{leg.user}</span>
          </div>
        );
      })}
      {/* Center label */}
      <div style={{
        position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
        textAlign: "center",
      }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.brand, letterSpacing: -0.3 }}>{n}-way</div>
        <div style={{ fontSize: 10, color: C.textMid, fontWeight: 500 }}>cycle</div>
      </div>
    </div>
  );
}

// ─── Live Pulse ───
function LiveBar() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx(i => (i + 1) % LIVE_FEED.length), 4000);
    return () => clearInterval(t);
  }, []);
  const f = LIVE_FEED[idx];
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, padding: "8px 14px",
      background: C.surface, borderRadius: 12, border: `1px solid ${C.border}`,
      marginBottom: 24, overflow: "hidden",
    }}>
      <div style={{
        width: 6, height: 6, borderRadius: "50%", background: C.green,
        boxShadow: `0 0 6px ${C.green}`,
        animation: "pulse 2s infinite",
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, fontSize: 12, color: C.textMid, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        <span style={{ fontWeight: 700, color: C.text }}>{f.user}</span>{" "}{f.action}
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color: C.gold, flexShrink: 0 }}>{f.value}</span>
      <span style={{ fontSize: 10, color: C.textDim, flexShrink: 0 }}>{f.time}</span>
    </div>
  );
}

// ─── Views ───
function HomeView({ nav }) {
  return (
    <div style={{ padding: "0 20px 120px" }}>
      <LiveBar />

      {/* Cycle Found — hero treatment */}
      <div onClick={() => nav("proposal")} style={{
        background: C.surface, borderRadius: 24, padding: 20, marginBottom: 32,
        border: `1px solid ${C.gold}30`,
        boxShadow: `0 4px 32px ${C.goldGlow}, 0 1px 4px rgba(0,0,0,0.04)`,
        cursor: "pointer", position: "relative", overflow: "hidden",
      }}>
        {/* Top accent */}
        <div style={{ position: "absolute", top: 0, left: "20%", right: "20%", height: 2, background: `linear-gradient(90deg, transparent, ${C.gold}, transparent)`, opacity: 0.5 }} />

        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.gold, boxShadow: `0 0 8px ${C.gold}`, animation: "pulse 2s infinite" }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: C.gold, letterSpacing: 1.2, textTransform: "uppercase" }}>Cycle found</span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: C.textDim }}>23h left</span>
        </div>

        {/* Hero items: give → get */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, marginBottom: 16 }}>
          <ItemDisplay k="sport_gloves" size="lg" showPrice />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <path d="M8 14H20M20 14L15 9M20 14L15 19" stroke={C.gold} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span style={{ fontSize: 10, color: C.textDim }}>3-way</span>
          </div>
          <ItemDisplay k="kara_doppler" size="lg" glow showPrice />
        </div>

        <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
          <Pill color={C.gold}>87% confidence</Pill>
          <Pill color={C.brand}>G1 Escrow</Pill>
        </div>
      </div>

      {/* Your Inventory — larger, scrollable */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
          <h3 style={{ fontSize: 20, fontWeight: 800, color: C.text, margin: 0 }}>Your inventory</h3>
          <span style={{ fontSize: 12, color: C.action, fontWeight: 600, cursor: "pointer" }}>Sync</span>
        </div>
        <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
          {MY_INV.map(k => (
            <div key={k} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 80 }}>
              <ItemDisplay k={k} size="md" showPrice />
              <span style={{ fontSize: 10, color: C.textMid, textAlign: "center", lineHeight: 1.2, maxWidth: 80 }}>
                {ITEMS[k].n.split("|")[1]?.trim() || ITEMS[k].n.split(" ")[0]}
              </span>
            </div>
          ))}
          <div style={{
            width: 72, minWidth: 72, height: 72, borderRadius: 16,
            border: `2px dashed ${C.border}`,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M10 4V16M4 10H16" stroke={C.textDim} strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
        </div>
      </div>

      {/* Listings */}
      <div style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: 20, fontWeight: 800, color: C.text, margin: "0 0 14px" }}>Your listings</h3>
        {MY_LISTINGS.map((l, i) => (
          <div key={i} style={{
            background: C.surface, borderRadius: 16, padding: 16, marginBottom: 10,
            border: `1px solid ${C.border}`, boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
            display: "flex", alignItems: "center", gap: 14,
          }}>
            <ItemDisplay k={l.offer} size="sm" showPrice={false} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{ITEMS[l.offer]?.n}</div>
              <div style={{ fontSize: 12, color: C.textMid, marginTop: 2 }}>Want: {l.want}</div>
              <div style={{ marginTop: 6 }}>
                <Pill color={C.gold}>{l.cycles} potential cycle{l.cycles !== 1 ? "s" : ""}</Pill>
              </div>
            </div>
          </div>
        ))}
        <button style={{
          width: "100%", padding: 16, borderRadius: 16, border: `2px dashed ${C.border}`,
          background: "transparent", color: C.action, fontSize: 14, fontWeight: 700, cursor: "pointer",
        }}>+ New listing</button>
      </div>

      {/* Swap Opps */}
      <div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
          <h3 style={{ fontSize: 20, fontWeight: 800, color: C.text, margin: 0 }}>Opportunities</h3>
          <Pill color={C.gold}>12 matches</Pill>
        </div>
        <p style={{ fontSize: 13, color: C.textMid, margin: "0 0 14px", lineHeight: 1.4 }}>
          Could form cycles with your items
        </p>
        {MARKET.slice(0, 3).map((l, i) => {
          const it = ITEMS[l.offer];
          return (
            <div key={i} style={{
              background: C.surface, borderRadius: 16, padding: 14, marginBottom: 10,
              border: `1px solid ${C.border}`, boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
              display: "flex", gap: 14, cursor: "pointer",
            }}>
              <ItemDisplay k={l.offer} size="sm" showPrice={false} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{it?.n}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                  <span style={{ fontSize: 12, color: C.textMid }}>{l.user}</span>
                  <Rel s={l.rel} />
                </div>
                <div style={{ fontSize: 12, color: C.textMid, marginTop: 3 }}>Wants: {l.want}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", justifyContent: "space-between" }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{fv(it?.v)}</span>
                <Pill color={C.gold}>{l.cycles} cycles</Pill>
              </div>
            </div>
          );
        })}
        <button onClick={() => nav("market")} style={{
          width: "100%", padding: 14, borderRadius: 14, border: "none",
          background: C.surfaceAlt, color: C.textMid, fontSize: 13, fontWeight: 600, cursor: "pointer",
        }}>View all →</button>
      </div>
    </div>
  );
}

function ProposalView({ nav }) {
  const [ok, setOk] = useState(false);
  const [detail, setDetail] = useState(false);
  const you = PROPOSAL.legs[0];
  const give = ITEMS[you.give], get = ITEMS[you.get];
  const spread = ((get.v - give.v) / give.v * 100).toFixed(1);

  return (
    <div style={{ padding: "0 20px 120px" }}>
      <div onClick={() => nav("home")} style={{ fontSize: 13, color: C.textMid, cursor: "pointer", marginBottom: 16 }}>← Back</div>

      <div style={{ textAlign: "center", marginBottom: 6 }}>
        <Pill color={C.brand}>{PROPOSAL.id}</Pill>
      </div>
      <h2 style={{ fontSize: 26, fontWeight: 800, color: C.text, margin: "8px 0 4px", textAlign: "center", letterSpacing: -0.5 }}>Cycle proposal</h2>
      <p style={{ fontSize: 13, color: C.textMid, margin: "0 0 20px", textAlign: "center" }}>
        {PROPOSAL.legs.length} participants · {PROPOSAL.expires} remaining
      </p>

      {/* Cycle viz with real items */}
      <div style={{
        background: C.surface, borderRadius: 24, border: `1px solid ${C.border}`,
        boxShadow: "0 2px 12px rgba(0,0,0,0.04)",
        marginBottom: 20, overflow: "hidden",
      }}>
        <CycleItems legs={PROPOSAL.legs} />
      </div>

      {/* Hero give/get */}
      <div style={{
        background: C.surface, borderRadius: 24, padding: 28, marginBottom: 16,
        border: `1px solid ${C.border}`, boxShadow: "0 2px 12px rgba(0,0,0,0.04)",
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12, fontWeight: 700 }}>You give</div>
            <ItemDisplay k={you.give} size="hero" showPrice />
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginTop: 8 }}>{give.n}</div>
            <div style={{ fontSize: 11, color: C.textMid }}>{give.c}</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, paddingTop: 48 }}>
            <div style={{
              width: 44, height: 44, borderRadius: "50%",
              background: `linear-gradient(135deg, ${C.gold}, ${C.brand})`,
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: `0 4px 16px ${C.goldGlow}`,
            }}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M4 10H16M11 5L16 10L11 15" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <span style={{
              fontSize: 12, fontWeight: 700,
              color: parseFloat(spread) >= 0 ? C.green : C.action,
            }}>
              {parseFloat(spread) >= 0 ? "+" : ""}{spread}%
            </span>
          </div>

          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: C.gold, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12, fontWeight: 700 }}>You get</div>
            <ItemDisplay k={you.get} size="hero" glow showPrice />
            <div style={{ fontSize: 13, fontWeight: 700, color: C.gold, marginTop: 8 }}>{get.n}</div>
            <div style={{ fontSize: 11, color: C.textMid }}>{get.c}</div>
          </div>
        </div>
      </div>

      {/* Expandable detail */}
      <div onClick={() => setDetail(!detail)} style={{
        background: C.surface, borderRadius: 16, padding: 14, marginBottom: 16,
        border: `1px solid ${C.border}`, cursor: "pointer",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Full cycle details</span>
          <span style={{ color: C.textDim, transform: detail ? "rotate(180deg)" : "none", transition: "0.2s", fontSize: 16 }}>⌄</span>
        </div>
        {detail && (
          <div style={{ marginTop: 14 }}>
            {PROPOSAL.legs.map((leg, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 12, padding: "12px 0",
                borderTop: i > 0 ? `1px solid ${C.borderLight}` : "none",
              }}>
                <ItemDisplay k={leg.give} size="sm" showPrice={false} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: i === 0 ? C.gold : C.text }}>{leg.user}</span>
                    <Rel s={leg.rel} />
                  </div>
                  <div style={{ fontSize: 12, color: C.textMid, marginTop: 2 }}>
                    {ITEMS[leg.give]?.n} → <span style={{ color: C.gold, fontWeight: 600 }}>{ITEMS[leg.get]?.n}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Guarantee + Fee */}
      <div style={{ display: "flex", gap: 10, marginBottom: 28 }}>
        <div style={{ flex: 1, background: C.surface, borderRadius: 16, padding: 16, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontWeight: 600 }}>Guarantee</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: C.brand }}>G1</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>Custody Escrow</span>
          </div>
          <div style={{ fontSize: 11, color: C.textMid, marginTop: 4 }}>All items held before any release</div>
        </div>
        <div style={{ flex: 1, background: C.surface, borderRadius: 16, padding: 16, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontWeight: 600 }}>Fee</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>${PROPOSAL.fee}</div>
          <div style={{ fontSize: 11, color: C.textMid, marginTop: 4 }}>3.5% of received value</div>
        </div>
      </div>

      {!ok ? (
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => nav("home")} style={{
            flex: 1, padding: 16, borderRadius: 16, border: `1px solid ${C.border}`,
            background: "transparent", color: C.textMid, fontSize: 15, fontWeight: 700, cursor: "pointer",
          }}>Decline</button>
          <button onClick={() => setOk(true)} style={{
            flex: 2, padding: 16, borderRadius: 16, border: "none",
            background: C.brand, color: "#fff", fontSize: 15, fontWeight: 800,
            cursor: "pointer", boxShadow: `0 4px 20px rgba(44,35,65,0.2)`,
          }}>Accept swap</button>
        </div>
      ) : (
        <div style={{
          background: C.greenSoft, borderRadius: 20, padding: 28, textAlign: "center",
          border: `1px solid ${C.green}20`,
        }}>
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none" style={{ marginBottom: 8 }}>
            <circle cx="18" cy="18" r="18" fill={C.green} opacity="0.12"/>
            <path d="M12 18L16 22L24 14" stroke={C.green} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.green }}>Accepted</div>
          <div style={{ fontSize: 12, color: C.textMid, marginTop: 4 }}>Waiting for participants. Deposit instructions incoming.</div>
        </div>
      )}
    </div>
  );
}

function MarketView({ nav }) {
  const [filt, setFilt] = useState("All");
  const fs = ["All", "CS2", "Roblox", "Dota 2"];
  const list = MARKET.filter(l => filt === "All" || ITEMS[l.offer]?.g === filt);

  return (
    <div style={{ padding: "0 20px 120px" }}>
      <h2 style={{ fontSize: 26, fontWeight: 800, color: C.text, margin: "0 0 2px", letterSpacing: -0.3 }}>Marketplace</h2>
      <p style={{ fontSize: 13, color: C.textMid, margin: "0 0 16px" }}>{MARKET.length} active listings</p>

      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        {fs.map(f => (
          <button key={f} onClick={() => setFilt(f)} style={{
            padding: "7px 16px", borderRadius: 20,
            border: filt === f ? `1.5px solid ${C.brand}` : `1px solid ${C.border}`,
            background: filt === f ? C.brandSoft : "transparent",
            color: filt === f ? C.brand : C.textMid,
            fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}>{f}</button>
        ))}
      </div>

      {/* Trending */}
      <div style={{ background: C.surface, borderRadius: 16, padding: 14, marginBottom: 20, border: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Trending wants</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["Butterfly Knives", "Karambit", "Sport Gloves", "Dominus", "AK $20-50"].map(w => (
            <span key={w} style={{
              padding: "5px 12px", borderRadius: 20, background: C.surfaceAlt,
              fontSize: 11, color: C.text, fontWeight: 500, border: `1px solid ${C.border}`,
            }}>{w}</span>
          ))}
        </div>
      </div>

      {list.map((l, i) => {
        const it = ITEMS[l.offer];
        return (
          <div key={i} style={{
            background: C.surface, borderRadius: 20, padding: 18, marginBottom: 12,
            border: `1px solid ${l.house ? `${C.gold}30` : C.border}`,
            boxShadow: "0 1px 4px rgba(0,0,0,0.03)", cursor: "pointer",
          }}>
            <div style={{ display: "flex", gap: 16 }}>
              <ItemDisplay k={l.offer} size="md" showPrice={false} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 2 }}>{it?.n}</div>
                <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>{it?.c} · {it?.g}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: C.textMid }}>{l.user}</span>
                  <Rel s={l.rel} />
                  {l.house && <Pill color={C.gold} filled>Vault</Pill>}
                </div>
                <div style={{ fontSize: 12, color: C.textMid }}><span style={{ fontWeight: 600, color: C.text }}>Wants:</span> {l.want}</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{fv(it?.v)}</span>
                  <Pill color={C.gold}>{l.cycles} cycles</Pill>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReceiptsView() {
  const receipts = [
    { id: "SWP-4821", date: "Feb 17, 2026", gave: "ak_redline", got: "m4a1_hyper", type: "2-way", val: "$81" },
    { id: "SWP-3190", date: "Feb 14, 2026", gave: "awp_asiimov", got: "arcana_jugg", type: "3-way", val: "$57" },
  ];

  return (
    <div style={{ padding: "0 20px 120px" }}>
      <h2 style={{ fontSize: 26, fontWeight: 800, color: C.text, margin: "0 0 2px", letterSpacing: -0.3 }}>Receipts</h2>
      <p style={{ fontSize: 13, color: C.textMid, margin: "0 0 20px" }}>Verified, signed swap records</p>

      {receipts.map((r, i) => (
        <div key={i} style={{
          background: C.surface, borderRadius: 24, padding: 24, marginBottom: 16,
          border: `1px solid ${C.border}`, boxShadow: "0 2px 12px rgba(0,0,0,0.04)",
          position: "relative", overflow: "hidden",
        }}>
          {/* Decorative corner marks — certificate feel */}
          {[{ top: 12, left: 12 }, { top: 12, right: 12 }, { bottom: 12, left: 12 }, { bottom: 12, right: 12 }].map((pos, j) => (
            <div key={j} style={{
              position: "absolute", ...pos, width: 16, height: 16,
              borderTop: (pos.top !== undefined) ? `1.5px solid ${C.border}` : "none",
              borderBottom: (pos.bottom !== undefined) ? `1.5px solid ${C.border}` : "none",
              borderLeft: (pos.left !== undefined) ? `1.5px solid ${C.border}` : "none",
              borderRight: (pos.right !== undefined) ? `1.5px solid ${C.border}` : "none",
            }} />
          ))}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 600, marginBottom: 2 }}>Swap Receipt</div>
              <span style={{ fontSize: 14, fontWeight: 800, color: C.brand }}>{r.id}</span>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: C.textDim }}>{r.date}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end", marginTop: 2 }}>
                <div style={{ width: 5, height: 5, borderRadius: "50%", background: C.green }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: C.green }}>Verified</span>
              </div>
            </div>
          </div>

          {/* Big item display */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 24, marginBottom: 20 }}>
            <div style={{ textAlign: "center" }}>
              <ItemDisplay k={r.gave} size="lg" showPrice />
              <div style={{ fontSize: 11, fontWeight: 600, color: C.textMid, marginTop: 4 }}>
                {ITEMS[r.gave]?.n}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <path d="M10 16H22M22 16L17 11M22 16L17 21" stroke={C.gold} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <Pill color={C.brand}>{r.type}</Pill>
            </div>
            <div style={{ textAlign: "center" }}>
              <ItemDisplay k={r.got} size="lg" glow showPrice />
              <div style={{ fontSize: 11, fontWeight: 600, color: C.textMid, marginTop: 4 }}>
                {ITEMS[r.got]?.n}
              </div>
            </div>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: C.borderLight, margin: "0 0 16px" }} />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 12, color: C.textMid }}>
              Total value: <span style={{ fontWeight: 700, color: C.text }}>{r.val}</span>
            </div>
            <button style={{
              padding: "8px 20px", borderRadius: 12,
              border: `1px solid ${C.brand}`,
              background: "transparent", color: C.brand,
              fontSize: 12, fontWeight: 700, cursor: "pointer",
            }}>Share</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProfileView() {
  return (
    <div style={{ padding: "0 20px 120px" }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{
          width: 72, height: 72, borderRadius: "50%", margin: "0 auto 12px",
          background: `linear-gradient(135deg, ${C.gold}, ${C.brand})`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 28, color: "#fff", fontWeight: 800,
          boxShadow: `0 4px 20px ${C.goldGlow}`,
        }}>L</div>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: C.text, margin: "0 0 6px" }}>swapmaster_luis</h2>
        <Rel s={4.8} />
        <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 10 }}>
          <Pill color={C.brand}>Tier 2 · Trusted</Pill>
          <Pill color={C.gold} filled>Pro</Pill>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 28 }}>
        {[
          { label: "Completed", val: "23", color: C.brand },
          { label: "Total value", val: "$4.2k", color: C.gold },
          { label: "Disputes", val: "0", color: C.green },
        ].map((s, i) => (
          <div key={i} style={{
            background: C.surface, borderRadius: 16, padding: 16, textAlign: "center",
            border: `1px solid ${C.border}`,
          }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: s.color }}>{s.val}</div>
            <div style={{ fontSize: 10, color: C.textMid, marginTop: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 18, fontWeight: 800, color: C.text, margin: "0 0 12px" }}>Connected platforms</h3>
      {[
        { name: "Steam", detail: "76561198...", ok: true },
        { name: "Roblox", detail: "Connect to expand cycles", ok: false },
      ].map((p, i) => (
        <div key={i} style={{
          background: C.surface, borderRadius: 16, padding: 14, marginBottom: 8,
          border: `1px solid ${p.ok ? `${C.green}20` : C.border}`,
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: 12, background: C.surfaceAlt,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={p.ok ? C.green : C.textDim} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {p.name === "Steam"
                ? <><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>
                : <><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12h8M12 8v8"/></>
              }
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{p.name}</div>
            <div style={{ fontSize: 11, color: C.textMid }}>{p.detail}</div>
          </div>
          {p.ok ? (
            <Pill color={C.green}>Synced</Pill>
          ) : (
            <button style={{
              padding: "6px 14px", borderRadius: 10, border: "none",
              background: C.brand, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer",
            }}>Connect</button>
          )}
        </div>
      ))}

      <h3 style={{ fontSize: 18, fontWeight: 800, color: C.text, margin: "24px 0 12px" }}>Guarantee levels</h3>
      <div style={{ background: C.surface, borderRadius: 20, overflow: "hidden", border: `1px solid ${C.border}` }}>
        {[
          { g: "G1", label: "Custody Escrow", desc: "Steam swaps — full escrow", color: C.brand },
          { g: "G2", label: "Verified Transfer", desc: "Cross-platform — delivery certificates", color: C.gold },
          { g: "G3", label: "Trust-Based", desc: "Unlocks at Tier 3", color: C.textDim },
        ].map((g, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 14, padding: 16,
            borderTop: i > 0 ? `1px solid ${C.borderLight}` : "none",
          }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: g.color, width: 32, textAlign: "center" }}>{g.g}</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{g.label}</div>
              <div style={{ fontSize: 11, color: C.textMid }}>{g.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── App Shell ───
function App() {
  const [view, setView] = useState("home");
  const tabs = [
    { k: "home", l: "Home", d: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z|M9 22V12h6v10" },
    { k: "market", l: "Market", d: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" },
    { k: "receipts", l: "Receipts", d: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" },
    { k: "profile", l: "Profile", d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2|M12 3a4 4 0 100 8 4 4 0 000-8z" },
  ];

  return (
    <div style={{
      background: C.bg, color: C.text, minHeight: "100vh",
      fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
      maxWidth: 480, margin: "0 auto", position: "relative",
    }}>
      {/* Subtle texture overlay */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.015'/%3E%3C/svg%3E")`,
        backgroundSize: "200px 200px",
        opacity: 0.6,
      }} />

      {/* Top bar */}
      <div style={{
        padding: "16px 20px 12px", display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, zIndex: 10,
        background: `linear-gradient(180deg, ${C.bg} 80%, ${C.bg}00)`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect width="28" height="28" rx="8" fill={C.brand}/>
            <path d="M8 14h4l2-4 2 8 2-4h4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: -0.5 }}>
            Swap<span style={{ color: C.brand }}>Graph</span>
          </span>
        </div>
        <div style={{ position: "relative", cursor: "pointer" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={C.textMid} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
          </svg>
          <div style={{ position: "absolute", top: 0, right: 0, width: 7, height: 7, borderRadius: "50%", background: C.action, border: `2px solid ${C.bg}` }} />
        </div>
      </div>

      <div style={{ position: "relative", zIndex: 1 }}>
        {view === "home" && <HomeView nav={setView} />}
        {view === "proposal" && <ProposalView nav={setView} />}
        {view === "market" && <MarketView nav={setView} />}
        {view === "receipts" && <ReceiptsView />}
        {view === "profile" && <ProfileView />}
      </div>

      {/* Tab Bar */}
      <div style={{
        position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
        width: "100%", maxWidth: 480, zIndex: 20,
        background: `linear-gradient(180deg, transparent, ${C.bg} 24%)`,
        paddingTop: 16, paddingBottom: 12,
      }}>
        <div style={{
          margin: "0 14px",
          background: `${C.surface}f0`,
          backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
          borderRadius: 20, border: `1px solid ${C.border}`,
          display: "flex", justifyContent: "space-around",
          padding: "8px 0",
          boxShadow: "0 -2px 20px rgba(0,0,0,0.03)",
        }}>
          {tabs.map(t => {
            const active = view === t.k || (view === "proposal" && t.k === "home");
            const paths = t.d.split("|");
            return (
              <button key={t.k} onClick={() => setView(t.k)} style={{
                background: "none", border: "none", cursor: "pointer",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                padding: "4px 16px",
                color: active ? C.brand : C.textDim,
                transition: "color 0.15s",
              }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {paths.map((d, i) => <path key={i} d={d} />)}
                </svg>
                <span style={{ fontSize: 10, fontWeight: 700 }}>{t.l}</span>
                {active && <div style={{ width: 4, height: 4, borderRadius: 2, background: C.brand, marginTop: -1 }} />}
              </button>
            );
          })}
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800&display=swap');
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.3 } }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        ::-webkit-scrollbar { display: none; }
        body { margin: 0; background: ${C.bg}; }
      `}</style>
    </div>
  );
}
