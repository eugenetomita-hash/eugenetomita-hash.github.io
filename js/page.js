// Timeline bar, one-video-at-a-time playback and the clipper's scan strips.
(() => {
  const FPS = 30;
  // The timeline is grouped by what I offer, not by video: one block per kind of work, each video an
  // edit point inside its block. Lengths are the real running times in seconds; the timecode runs on
  // across the whole bar, but each block gets its share of width by weight so short work stays readable.
  const GROUPS = [
    { name: "Long form",      c: "--long",    w: 1.8, clips: [["panel", 374], ["low", 144]] },
    { name: "Short form",     c: "--short",   w: 2, clips: [["garbage", 49], ["criminal", 48], ["hacker", 35], ["glowup", 10], ["hair", 9], ["maneboard", 10], ["mane", 17], ["japan", 34]] },
    { name: "Automation",     c: "--tools",   w: 1,   clips: [["clipper", 60]] },
    { name: "Trailer",        c: "--trailer", w: 1,   clips: [["ronin", 31]] },
  ];
  const CLIPS = [];
  let t = 0, x = 0;
  const W = GROUPS.reduce((a, g) => a + g.w, 0);
  GROUPS.forEach(g => {
    g.start = t; g.x = x / W; g.dur = g.clips.reduce((a, c) => a + c[1], 0); g.width = g.w / W;
    let o = 0;
    g.clips.forEach(([id, dur]) => {
      CLIPS.push({ id, dur, g, start: t + o, off: o, el: document.querySelector(`[data-clip="${id}"]`) });
      o += dur;
    });
    t += g.dur; x += g.w;
  });
  const TOTAL = t;
  // where a moment (seconds into a block) sits along the bar, 0..1
  const at = (g, sec) => g.x + g.width * Math.min(1, Math.max(0, sec / g.dur));

  const tc = s => {
    const f = Math.floor((s % 1) * FPS), whole = Math.floor(s);
    const p = n => String(n).padStart(2, "0");
    return `${p(Math.floor(whole / 3600))}:${p(Math.floor(whole / 60) % 60)}:${p(whole % 60)}:${p(f)}`;
  };
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

  const ruler = document.getElementById("tlRuler"), track = document.getElementById("tlTrack");
  GROUPS.forEach(g => {
    // a tick every 30 s inside the block, and the block's in-point labelled with the running time
    for (let s = 0; s < g.dur; s += 30) {
      const i = document.createElement("i");
      if (s === 0) i.className = "major";
      i.style.left = (at(g, s) * 100) + "%";
      ruler.appendChild(i);
    }
    const em = document.createElement("em");
    em.textContent = mmss(g.start);
    em.style.left = (g.x * 100) + "%";
    ruler.appendChild(em);

    const b = document.createElement("button");
    b.className = "tl-clip";
    b.style.left = `calc(${g.x * 100}% + 1px)`;
    b.style.width = `calc(${g.width * 100}% - 2px)`;
    b.style.setProperty("--c", `var(${g.c})`);
    b.textContent = g.name;
    b.setAttribute("aria-label", `Go to ${g.name}`);
    const first = CLIPS.find(c => c.g === g);
    b.addEventListener("click", () => first.el.scrollIntoView({ behavior: "smooth", block: "center" }));
    // the cuts between videos inside the block
    let o = 0;
    g.clips.slice(0, -1).forEach(([, dur]) => {
      o += dur;
      const cut = document.createElement("i");
      cut.className = "tl-cut";
      cut.style.left = (o / g.dur * 100) + "%";
      b.appendChild(cut);
    });
    g.btn = b;
    track.appendChild(b);
  });

  const head = document.getElementById("tlHead"), tcEl = document.getElementById("tlTc"), nameEl = document.getElementById("tlName");
  const body = head.parentElement;
  let playing = null;
  // clip: the video the moment is in; into: seconds into that video
  const setHead = (clip, into) => {
    const g = clip && clip.g, sec = clip ? clip.off + into : 0;
    head.style.transform = `translateX(${(g ? at(g, sec) : 0) * body.clientWidth}px)`;
    tcEl.textContent = tc(clip ? clip.start + into : 0);
    nameEl.textContent = g ? g.name : "Start";
    GROUPS.forEach(x => x.btn.classList.toggle("on", x === g));
  };
  const fromScroll = () => {
    const mid = innerHeight * 0.5;
    let best = null;
    for (const c of CLIPS) {
      const r = c.el.getBoundingClientRect();
      if (r.top <= mid) best = { c, r };
    }
    if (!best) return setHead(null, 0);
    const p = Math.min(1, Math.max(0, (mid - best.r.top) / Math.max(1, best.r.height)));
    setHead(best.c, p * best.c.dur);
  };
  const tick = () => {
    if (playing && !playing.v.paused) {
      setHead(playing.c, Math.min(playing.v.currentTime, playing.c.dur));
      requestAnimationFrame(tick);
    }
  };
  CLIPS.forEach(c => {
    const v = c.el.querySelector("video");
    if (!v) return;
    v.addEventListener("play", () => {
      document.querySelectorAll("main video").forEach(o => { if (o !== v) o.pause(); });
      playing = { c, v };
      requestAnimationFrame(tick);
    });
    v.addEventListener("pause", () => { if (playing && playing.v === v) playing = null; });
  });
  let raf = 0;
  addEventListener("scroll", () => {
    if (playing && !playing.v.paused) return;
    cancelAnimationFrame(raf); raf = requestAnimationFrame(fromScroll);
  }, { passive: true });
  addEventListener("resize", fromScroll);
  fromScroll();

  // scan strips from the clipper's real scan data
  const rows = document.getElementById("scanRows");
  const MATCH = 40; // the clipper's cut-off: 0.40 similarity
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  const maxBins = Math.max(...(window.SCAN || []).map(x => x.bins.length));
  (window.SCAN || []).forEach(s => {
    const row = document.createElement("div");
    row.className = "scan-row";
    const lab = document.createElement("span");
    lab.textContent = `${fmt.format(new Date(s.start.replace(" ", "T")))}, ${Math.round(s.hours)} h`;
    const cv = document.createElement("canvas");
    cv.setAttribute("role", "img");
    const on = s.bins.filter(x => x >= MATCH).length;
    cv.setAttribute("aria-label", `${Math.round(s.hours)} hours scanned, on camera in ${on} of ${s.bins.length} five-minute stretches`);
    row.append(lab, cv);
    rows.appendChild(row);
    const draw = () => {
      const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      if (!w) return;
      cv.width = w * dpr; cv.height = h * dpr;
      const g = cv.getContext("2d"); g.scale(dpr, dpr);
      const bw = w / maxBins;
      g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--tools").trim();
      s.bins.forEach((v, i) => { if (v >= MATCH) g.fillRect(i * bw, 3, Math.max(1, bw - .4), h - 6); });
    };
    requestAnimationFrame(draw);
    addEventListener("resize", draw);
  });
})();
