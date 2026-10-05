(function () {
  var sky = document.getElementById('sky');
  var jen = document.getElementById('jennifer');
  var jenFace = document.getElementById('jennifer-face');
  var kissesEl = document.getElementById('kisses');
  var kisses = 0;
  var drimUrls = [];
  var jenUrl = null;
  var MAX_FALLERS = 14;

  function release(url) { if (url) URL.revokeObjectURL(url); }

  function spawn() {
    if (document.hidden || sky.querySelectorAll('.faller').length >= MAX_FALLERS) return;
    var el = document.createElement('div');
    el.className = 'faller';
    var isDrim = Math.random() < 0.4;
    if (isDrim && drimUrls.length) {
      var img = document.createElement('img');
      img.src = drimUrls[Math.floor(Math.random() * drimUrls.length)];
      img.alt = 'drim';
      el.appendChild(img);
    } else {
      el.textContent = isDrim ? '😎' : '🐰';
    }
    el.style.left = Math.max(0, Math.random() * (sky.clientWidth - 56)) + 'px';
    el.style.setProperty('--drop', (sky.clientHeight + 140) + 'px');
    el.style.animationDuration = (4 + Math.random() * 4) + 's';
    el.addEventListener('animationend', function () { el.remove(); });
    el.addEventListener('click', function () { send(el); });
    sky.appendChild(el);
  }

  function send(el) {
    if (el.classList.contains('sent')) return;
    var sr = sky.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    el.style.left = (r.left - sr.left) + 'px';
    el.style.top = (r.top - sr.top) + 'px';
    el.classList.add('sent');
    void el.offsetWidth;
    el.style.left = (sky.clientWidth / 2 - 28) + 'px';
    el.style.top = (sky.clientHeight - 100) + 'px';
    setTimeout(function () {
      el.remove();
      kisses++;
      kissesEl.textContent = kisses;
      var k = document.createElement('span');
      k.className = 'kiss';
      k.textContent = '💋';
      k.style.left = (sky.clientWidth / 2 - 16 + (Math.random() * 60 - 30)) + 'px';
      k.style.top = (sky.clientHeight - 130) + 'px';
      sky.appendChild(k);
      setTimeout(function () { k.remove(); }, 1000);
    }, 600);
  }

  function imagesOnly(files) {
    return Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type); });
  }

  document.getElementById('drim-files').addEventListener('change', function (e) {
    imagesOnly(e.target.files).forEach(function (f) { drimUrls.push(URL.createObjectURL(f)); });
    e.target.value = '';
  });

  document.getElementById('jen-file').addEventListener('change', function (e) {
    var f = imagesOnly(e.target.files)[0];
    e.target.value = '';
    if (!f) return;
    release(jenUrl);
    jenUrl = URL.createObjectURL(f);
    var img = document.createElement('img');
    img.src = jenUrl;
    img.alt = 'Jennifer';
    jen.textContent = '';
    jen.appendChild(img);
  });

  document.getElementById('reset').addEventListener('click', function () {
    drimUrls.forEach(release);
    drimUrls = [];
    release(jenUrl);
    jenUrl = null;
    jen.textContent = '';
    jen.appendChild(jenFace);
  });

  setInterval(spawn, 700);
})();
