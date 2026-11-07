// The sound of the path: the game's calm songs taking turns (as its "calm" mood plays them),
// with a soft wind under them. Browsers only let sound start after the visitor does something,
// so it starts on the first click, tap or key press (or at once, where the browser allows it).
// The button in the top bar turns it off and on; the choice is remembered.
const ogg = new Audio().canPlayType('audio/ogg; codecs="vorbis"') !== "";
const file = n => `audio/${n}.${ogg ? "ogg" : "mp3"}`;
const SONGS = ["mist_over_the_bamboo_path", "still_waters_remember"];
const MUSIC = 0.32, WIND = 0.2, GAP = 5; // volumes, and seconds of quiet between songs

export function startSound(button) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) { button.hidden = true; return; }
  const ctx = new Ctx();
  const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
  const music = ctx.createGain(); music.gain.value = MUSIC; music.connect(master);
  const wind = ctx.createGain(); wind.gain.value = WIND; wind.connect(master);
  const load = n => fetch(file(n)).then(r => r.arrayBuffer()).then(b => new Promise((ok, no) => ctx.decodeAudioData(b, ok, no)));

  let on = localStorage.getItem("sound") !== "off";
  let started = false, song = 0, songs = null;

  const playSong = () => {
    if (!songs) return;
    const s = ctx.createBufferSource(); s.buffer = songs[song % songs.length]; song++;
    s.connect(music); s.start();
    s.onended = () => setTimeout(playSong, GAP * 1000);
  };
  const begin = async () => {
    if (started) return;
    started = true;
    const [w, ...list] = await Promise.all([load("wind_bed"), ...SONGS.map(load)]);
    songs = list;
    const s = ctx.createBufferSource(); s.buffer = w; s.loop = true; s.connect(wind); s.start(); // the wind never stops
    playSong();
  };
  const fade = (to, secs) => {
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t); master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(to, t + secs);
  };
  const show = () => { button.setAttribute("aria-pressed", String(on)); button.textContent = on ? "Sound on" : "Sound off"; };
  const wake = () => {
    if (!on) return;
    ctx.resume().then(() => { begin(); fade(1, 3); });
  };
  show();

  // try at once (some browsers allow it for a site you've visited), else on the first gesture
  wake();
  const first = () => { wake(); if (ctx.state === "running") for (const e of ["pointerdown", "keydown", "touchend"]) removeEventListener(e, first, true); };
  for (const e of ["pointerdown", "keydown", "touchend"]) addEventListener(e, first, true);

  button.addEventListener("click", e => {
    e.stopPropagation();
    on = !on; localStorage.setItem("sound", on ? "on" : "off"); show();
    if (on) wake(); else fade(0, 0.6);
  });
  // quiet while the tab is hidden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) ctx.suspend(); else if (on && started) ctx.resume();
  });
}
