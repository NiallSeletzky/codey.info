/* Original fantasy-tavern ambience: browser-generated; no external audio assets. */
(() => {
  'use strict';
  const toggle = document.getElementById('music-toggle');
  const volume = document.getElementById('music-volume');
  const status = document.getElementById('music-status');
  if (!toggle || !volume) return;
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) {
    toggle.disabled = true;
    toggle.textContent = 'Music unavailable';
    if (status) status.textContent = 'This browser cannot play synthesised music.';
    return;
  }
  let context = null, master = null, playing = false, timer = null;
  let nextTime = 0, step = 0;
  const beat = 0.72;
  const melody = [
    440,523.25,659.25,null,587.33,523.25,440,null,
    392,440,523.25,587.33,523.25,null,440,null,
    349.23,440,523.25,null,493.88,440,392,null,
    329.63,392,440,523.25,440,null,392,null
  ];
  const chords = [
    [110,164.81,220],[98,146.83,196],
    [87.31,130.81,174.61],[82.41,123.47,164.81]
  ];
  function tone(hz, when, length, type='sine', level=0.03, attack=0.025) {
    const osc = context.createOscillator(), gain = context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(level, when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + length);
    osc.connect(gain); gain.connect(master);
    osc.start(when); osc.stop(when + length + 0.03);
    osc.addEventListener('ended', () => { osc.disconnect(); gain.disconnect(); }, {once:true});
  }
  function playStep(when) {
    const i = step % melody.length;
    if (i % 8 === 0) chords[Math.floor(i/8)].forEach((hz,index) =>
      tone(hz,when,beat*6,'sine',index === 0 ? 0.018 : 0.009,0.6));
    if (melody[i]) {
      tone(melody[i],when,beat*0.84,'triangle',0.047,0.018);
      if (i % 4 === 0) tone(melody[i]*2,when+0.04,beat*0.55,'sine',0.011,0.012);
    }
    step++;
  }
  function schedule() {
    if (!playing || !context) return;
    while (nextTime < context.currentTime + 0.24) {
      playStep(nextTime); nextTime += beat;
    }
  }
  function showState() {
    toggle.setAttribute('aria-pressed',String(playing));
    toggle.textContent = playing ? '♪ Pause tavern music' : '♪ Play tavern music';
    if (status) status.textContent = playing ? 'Tavern music playing.' : 'Tavern music paused.';
  }
  async function start() {
    try {
      if (!context) {
        context = new Audio();
        master = context.createGain();
        master.gain.value = Number(volume.value)/100;
        master.connect(context.destination);
      }
      await context.resume();
      nextTime = context.currentTime + 0.08;
      playing = true;
      schedule();
      timer = window.setInterval(schedule,90);
      showState();
    } catch (_) {
      playing = false;
      if (status) status.textContent = 'Audio was blocked. Try pressing Play again.';
    }
  }
  async function stop() {
    playing = false;
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    if (context && context.state === 'running') await context.suspend();
    showState();
  }
  toggle.addEventListener('click', () => playing ? stop() : start());
  volume.addEventListener('input', () => {
    if (context && master) master.gain.setTargetAtTime(
      Number(volume.value)/100,context.currentTime,0.05);
  });
  window.addEventListener('pagehide', () => { if (playing) stop(); });
  showState();
})();
