const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
const ctx = canvas.getContext('2d');
let video = document.querySelector('video'), scene = 'split', paused = false, began = performance.now();
// Pulse Engine: one file whose sound track is in sections. A scene plays one section over and over.
const SOUNDS = { beat: [0, 5.9], tone: [7.2, 10.8], hats: [12.25, 15.9], silence: [16.5, 20.5], blast: [21.3, 25.8], fast: [27.25, 32.9], music: [34.5, 41.9], 'audio-only': [34.5, 41.9] };
let section = null, soundOnly = null;
const media = canvas.captureStream(24);
video.srcObject = media; video.play().catch(() => {});
// A soft round light. Positions are fractions of the frame, the radius is in canvas pixels.
function glow(x, y, radius, color = '#fff6dc') {
  const w = canvas.width, h = canvas.height, g = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, radius);
  g.addColorStop(0, color); g.addColorStop(.55, color); g.addColorStop(1, '#00000000');
  ctx.fillStyle = g; ctx.fillRect(x * w - radius, y * h - radius, radius * 2, radius * 2);
}
// Light Director scenes: lights inside an otherwise dark picture. `s` is seconds since the scene was chosen.
const directed = {
  'sweep-right': s => glow(.08 + .84 * (s % 3) / 3, .38, 46),
  'sweep-left': s => glow(.92 - .84 * (s % 3) / 3, .38, 46),
  // Light Trails: a small light passing close under the top edge, where what it leaves behind can be told from what it lights now.
  comet: s => glow(.08 + .84 * (s % 3) / 3, .2, 30),
  burst: s => { const p = (s % 4 - 1) / .9; if (p >= 0 && p <= 1) glow(.84, .2, 24 + 80 * p, `rgb(255 ${Math.round(245 - 110 * p)} ${Math.round(200 - 170 * p)} / ${1 - p ** 3})`); },
  still: () => { ctx.fillStyle = '#0d1016'; ctx.fillRect(0, 0, canvas.width, canvas.height); glow(.3, .3, 42); },
  cuts: s => {
    const [from, to] = [['#0a2a66', '#2b7fff'], ['#5a1206', '#ff7a2a'], ['#06301a', '#3fd07a'], ['#30303a', '#d8d8e2']][Math.floor(s / .4) % 4];
    const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height); g.addColorStop(0, from); g.addColorStop(1, to);
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
  },
  blink: s => { if (Math.floor(s * 6) % 2) glow(.5, .25, 50); },
  multi: () => { glow(.16, .22, 34, '#ff5a4a'); glow(.84, .22, 34, '#58ff8a'); glow(.5, .84, 34, '#5a8cff'); },
  scope: s => { glow(.1 + .8 * (s % 4) / 4, .5, 40); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, 69); ctx.fillRect(0, 471, canvas.width, 69); },
  // Color Engine 2.0: a night scene at 6–10% brightness, and white highlights inside a red field along the top.
  night: () => { const g = ctx.createLinearGradient(0, 0, canvas.width, 0); g.addColorStop(0, '#04081a'); g.addColorStop(1, '#06140f'); ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height); },
  glare: () => { ctx.fillStyle = '#b01818'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#fff'; for (let x = 0; x < canvas.width; x += 60) ctx.fillRect(x, 0, 30, 90); },
  // Adaptive Brightness: a scene that is bright all over, and a dark one with a single bright window on the top edge and a dim colour along the bottom.
  snow: () => { const g = ctx.createLinearGradient(0, 0, 0, canvas.height); g.addColorStop(0, '#f4f7fb'); g.addColorStop(1, '#cfd9e6'); ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height); },
  lamp: () => { ctx.fillStyle = '#05070b'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#fff3d6'; ctx.fillRect(canvas.width * .4, 0, canvas.width * .2, 90); ctx.fillStyle = '#16233f'; ctx.fillRect(0, canvas.height - 90, canvas.width, 90); },
  caption: s => {
    ctx.fillStyle = '#0b0d12'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (s % 3 < 1.5) { ctx.font = 'bold 34px system-ui'; ctx.textAlign = 'center'; ctx.lineWidth = 5; ctx.strokeStyle = '#000'; ctx.fillStyle = '#fff';
      ctx.strokeText('これは字幕のテストです。光ってはいけません。', canvas.width / 2, canvas.height * .9); ctx.fillText('これは字幕のテストです。光ってはいけません。', canvas.width / 2, canvas.height * .9); ctx.textAlign = 'start'; }
  }
};
function paint(t) {
  const playing = soundOnly || video;
  if (section && playing.currentTime > section[1] - .04) playing.currentTime = section[0];
  if (!paused && directed[scene]) {
    ctx.fillStyle = '#06080c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    // The frame's timestamp can lie just before the click that chose the scene: never hand a scene a negative time.
    directed[scene](Math.max(0, (t - began) / 1000));
  } else if (!paused && !['file', 'cors', 'sound', 'color-p3', 'color-hdr'].includes(scene)) {
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    if (scene !== 'dark') {
      let top = scene === 'bars' ? 69 : 0, height = scene === 'bars' ? 402 : h;
      if (scene === 'pulse') { ctx.fillStyle = Math.floor(t / 1000) % 2 ? '#ffffff' : '#151515'; ctx.fillRect(0, 0, w, h); }
      else {
        const grad = ctx.createLinearGradient(0, 0, w, height);
        grad.addColorStop(0, '#0666dc'); grad.addColorStop(.32, '#08639d'); grad.addColorStop(.52, '#363060'); grad.addColorStop(.73, '#c96225'); grad.addColorStop(1, '#fa9137');
        ctx.fillStyle = grad; ctx.fillRect(0, top, w, height);
        if (scene === 'motion') {
          const x = w * (.5 + Math.sin(t / 2400) * .38), y = h * (.5 + Math.cos(t / 2800) * .3);
          const light = ctx.createRadialGradient(x, y, 0, x, y, 230);
          light.addColorStop(0, '#92ffce'); light.addColorStop(.45, '#19cf9777'); light.addColorStop(1, '#00000000');
          ctx.fillStyle = light; ctx.fillRect(0, 0, w, h);
        }
        ctx.fillStyle = '#02040833'; ctx.beginPath(); ctx.moveTo(0, top + height * .7); ctx.lineTo(w * .18, top + height * .35); ctx.lineTo(w * .4, top + height * .78); ctx.lineTo(w * .63, top + height * .5); ctx.lineTo(w, top + height * .9); ctx.lineTo(w, top + height); ctx.lineTo(0, top + height); ctx.fill();
        ctx.fillStyle = '#ffffffba'; ctx.font = '14px system-ui'; ctx.fillText('E C L I R I M', 37, top + 44);
        ctx.font = '11px system-ui'; ctx.fillText(scene === 'bars' ? 'LETTERBOX / 2.39 : 1' : 'BLUE ←  SPATIAL COLOR  → AMBER', 37, top + height - 38);
      }
    }
  }
  requestAnimationFrame(paint);
}requestAnimationFrame(paint);
document.querySelectorAll('[data-scene]').forEach(button => button.addEventListener('click', async () => {
  scene = button.dataset.scene; paused = false; began = performance.now(); quiet();
  document.querySelectorAll('[data-scene], [data-sound]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  if (scene === 'file' || scene === 'cors') {
    video.srcObject = null; video.removeAttribute('crossorigin');
    video.src = scene === 'cors' ? `http://127.0.0.1:${Number(location.port) + 1}/fixture.webm` : 'fixture.webm';
    video.loop = false;
  } else if (scene.startsWith('color-')) { video.srcObject = null; video.src = `${scene}.mp4`; video.loop = true; } else { video.removeAttribute('src'); video.srcObject = media; }
  await video.play().catch(() => {});
  document.querySelector('#info').textContent = scene === 'cors' ? '別オリジンの動画。直接Canvas解析はSecurityErrorになります。タブ取得またはDRM互換描画を選んで比較できます（この素材にDRMはありません）。' : 'シーンを切り替えました。明るさと外周の色をご確認ください。';
}));
// Back to a silent Lab: the sound scenes are the only ones that unmute the player.
function quiet() {
  section = null; video.muted = true; video.style.display = '';
  if (soundOnly) { soundOnly.pause(); soundOnly.remove(); soundOnly = null; }
}
document.querySelectorAll('[data-sound]').forEach(button => button.addEventListener('click', async () => {
  const name = button.dataset.sound; quiet(); scene = 'sound'; paused = false; section = SOUNDS[name];
  document.querySelectorAll('[data-scene], [data-sound]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  if (name === 'audio-only') {
    // A player with no picture at all: the video is hidden and stopped, and an <audio> element plays instead.
    video.pause(); video.style.display = 'none';
    soundOnly = document.createElement('audio'); soundOnly.src = 'pulse.webm'; document.body.append(soundOnly);
    soundOnly.currentTime = section[0]; await soundOnly.play().catch(() => {});
  } else {
    if (!video.currentSrc.endsWith('/pulse.webm')) { video.srcObject = null; video.src = 'pulse.webm'; }
    video.loop = false; video.muted = false; video.currentTime = section[0]; await video.play().catch(() => {});
  }
  document.querySelector('#info').textContent = '音のテスト。ポップアップで Pulse Engine をオンにすると、音に合わせて光の強さが変わります。色は映像のままです。';
}));
document.querySelector('#play').onclick = () => { if (video.paused) { paused = false; video.play(); } else { paused = true; video.pause(); } };
document.querySelector('#fullscreen').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.querySelector('#player').requestFullscreen();
document.querySelector('#native-fullscreen').onclick = () => video.requestFullscreen();
document.querySelector('#replace').onclick = () => {
  const next = document.createElement('video'); next.controls = true; next.muted = true; next.playsInline = true;
  next.srcObject = media; video.replaceWith(next); video = next; scene = 'motion'; paused = false; video.play();
  history.pushState({}, '', '?spa=' + Date.now());
};
window.addEventListener('pagehide', () => media.getTracks().forEach(t => t.stop()));

// UI Guard: controls and text close to the edges of the page, where the light lies over them. The bar on the left can be faded out.
// They sit where the page has nothing else, so what is found there is theirs alone.
const guardUi = document.createElement('div'); guardUi.id = 'guard-ui'; guardUi.hidden = true;
guardUi.innerHTML = `<div class="g-top"><button id="g-like" aria-label="いいね">♥ <span id="g-count">0</span></button><button>共有</button><input placeholder="検索" aria-label="検索"></div>
  <p class="g-right">右端の文字<br>RIGHT EDGE</p>
  <div class="g-left"><button aria-label="再生">▶</button><div class="g-seek" role="slider" aria-label="音量" tabindex="0"></div><span>42%</span></div>
  <p class="g-ghost">クリックを受け取らない文字</p>`;
document.body.append(guardUi);
guardUi.querySelector('#g-like').addEventListener('click', () => { const count = guardUi.querySelector('#g-count'); count.textContent = String(Number(count.textContent) + 1); });
document.querySelectorAll('[data-ui]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.ui === 'show') guardUi.hidden = !guardUi.hidden; else guardUi.classList.toggle('faded');
  button.setAttribute('aria-pressed', String(button.dataset.ui === 'show' ? !guardUi.hidden : guardUi.classList.contains('faded')));
}));
