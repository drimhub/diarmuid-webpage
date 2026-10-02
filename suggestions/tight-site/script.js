(function () {
  var PHRASES = [
    'This site is tight!', 'This is a tight site!', 'Tight site alert!!!',
    '*~* tight site *~*', 'WELCOME 2 MY TIGHT SITE', 'Totally tight, dude!',
    'Tight. Site. Party.', 'Best viewed in TIGHT-o-vision'
  ];
  var COLORS = ['#ff0', '#0ff', '#f0f', '#0f0', '#f80', '#f66', '#fff'];
  var stage = document.getElementById('stage');
  var clock = document.getElementById('clock');
  var words = [];
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function tick() {
    var d = new Date();
    clock.textContent = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  tick();
  setInterval(tick, 1000);

  PHRASES.forEach(function (text, i) {
    var el = document.createElement('div');
    el.className = 'word';
    el.textContent = text;
    el.style.color = COLORS[i % COLORS.length];
    stage.appendChild(el);
    var w = { el: el, x: Math.random() * 200, y: Math.random() * 200,
      vx: (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random() * 2),
      vy: (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random() * 2), c: i };
    words.push(w);
  });

  function frame() {
    var W = window.innerWidth, H = window.innerHeight;
    words.forEach(function (w) {
      var ew = w.el.offsetWidth, eh = w.el.offsetHeight, hit = false;
      w.x += w.vx; w.y += w.vy;
      if (w.x < 0) { w.x = 0; w.vx = Math.abs(w.vx); hit = true; }
      if (w.x > W - ew) { w.x = Math.max(0, W - ew); w.vx = -Math.abs(w.vx); hit = true; }
      if (w.y < 0) { w.y = 0; w.vy = Math.abs(w.vy); hit = true; }
      if (w.y > H - eh) { w.y = Math.max(0, H - eh); w.vy = -Math.abs(w.vy); hit = true; }
      if (hit) { w.c = (w.c + 1) % COLORS.length; w.el.style.color = COLORS[w.c]; }
      w.el.style.transform = 'translate(' + w.x + 'px,' + w.y + 'px)';
    });
    requestAnimationFrame(frame);
  }
  if (reduce) {
    words.forEach(function (w, i) {
      w.el.style.transform = 'translate(10px,' + (60 + i * 50) + 'px)';
    });
  } else {
    requestAnimationFrame(frame);
  }
})();
