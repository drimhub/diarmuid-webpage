(function () {
  var W = 320, H = 380, SCALE = 40, XK = 0.588, MINLON = -10.8, MAXLAT = 59;
  function proj(lon, lat) {
    return [(lon - MINLON) * XK * SCALE + 14, (MAXLAT - lat) * SCALE * 0.98 + 6];
  }
  function pts(list) {
    return list.map(function (p) { var q = proj(p[0], p[1]); return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ");
  }
  var GB = [[-5.7,50.1],[-4.2,50.35],[-3.4,50.6],[-2.4,50.6],[-1.3,50.75],[0.3,50.75],[1.4,51.1],[0.7,51.4],[1.4,51.4],[1.7,52.7],[0.3,52.9],[0.2,53.5],[-0.1,53.7],[-0.2,54.0],[-1.2,54.6],[-1.6,55.3],[-2.0,55.8],[-2.8,56.0],[-2.5,56.5],[-1.8,57.5],[-3.5,57.7],[-4.0,57.6],[-3.0,58.6],[-5.0,58.6],[-5.8,57.5],[-5.6,56.5],[-5.5,56.0],[-5.1,55.5],[-4.9,55.0],[-5.1,54.8],[-3.5,54.9],[-3.0,54.9],[-3.4,54.2],[-3.0,53.5],[-3.2,53.35],[-4.6,53.3],[-4.1,52.9],[-4.7,52.8],[-4.1,52.3],[-4.9,52.0],[-5.2,51.8],[-4.0,51.6],[-3.2,51.4],[-2.7,51.5],[-3.0,51.2],[-4.2,51.2],[-5.0,50.6]];
  var IE = [[-6.0,52.2],[-6.1,53.3],[-6.2,54.0],[-5.5,54.5],[-5.8,55.2],[-6.5,55.25],[-7.3,55.35],[-8.3,55.1],[-8.7,54.5],[-10.0,54.2],[-9.8,53.4],[-9.9,52.6],[-10.4,52.1],[-9.5,51.6],[-8.3,51.8],[-7.0,52.1],[-6.4,52.2]];
  var LONDON = proj(-0.12, 51.5);
  var HIT = 11;

  var svg = document.getElementById("map");
  var msg = document.getElementById("msg");
  var again = document.getElementById("again");
  var found = document.getElementById("found");
  var dot = document.getElementById("dot");
  var andy = document.getElementById("andy");
  var won = false;

  document.getElementById("gb").setAttribute("points", pts(GB));
  document.getElementById("ie").setAttribute("points", pts(IE));
  dot.setAttribute("cx", LONDON[0]); dot.setAttribute("cy", LONDON[1]);
  andy.setAttribute("x", LONDON[0]); andy.setAttribute("y", LONDON[1] - 12);

  function say(text, win) {
    msg.textContent = text;
    msg.className = "msg" + (win ? " win" : "");
  }

  svg.addEventListener("click", function (e) {
    if (won) return;
    var r = svg.getBoundingClientRect();
    var x = (e.clientX - r.left) * W / r.width;
    var y = (e.clientY - r.top) * H / r.height;
    var dx = x - LONDON[0], dy = y - LONDON[1];
    if (Math.sqrt(dx * dx + dy * dy) <= HIT) {
      won = true;
      found.hidden = false;
      say("There he is! There's Andy!", true);
      again.hidden = false;
    } else {
      say("No....", false);
    }
  });

  again.addEventListener("click", function () {
    won = false;
    found.hidden = true;
    again.hidden = true;
    say("Where's Andy?", false);
  });
})();
