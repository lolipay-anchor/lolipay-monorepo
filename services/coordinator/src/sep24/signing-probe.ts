export const SIGNING_PROBE_PATH = 'signing-probe';
export const SIGNING_PROBE_SCRIPT_PATH = 'signing-probe.js';

export function renderSigningProbe(networkPassphrase: string, escrowContractId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lolipay — can this browser sign a Soroban call?</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#111}
h1{font-size:1.25rem}
.row{padding:.6rem .8rem;border:1px solid #ddd;border-radius:.5rem;margin:.5rem 0}
.yes{background:#e8f6ec;border-color:#9ad0aa}
.no{background:#fdecec;border-color:#e0a0a0}
.wait{background:#f6f6f6}
button{font:inherit;padding:.6rem 1rem;border-radius:.5rem;border:1px solid #888;background:#fff;cursor:pointer}
code{background:#f2f2f2;padding:.1rem .3rem;border-radius:.2rem;word-break:break-all}
</style>
</head>
<body>
<h1>Can a wallet sign a Soroban call from this page?</h1>
<p>This page answers one question and does nothing else. It moves no money, stores nothing, and
sends nothing to the server. Open it in the browser you would use for a withdrawal, then press the
button.</p>
<div id="out"><div class="row no">The script did not run. If you see this after the page has
loaded, JavaScript was blocked — which is itself the answer, and it is a header this anchor
controls.</div></div>
<p><button id="go">Ask again</button>
<button id="pop">Re-run inside a popup, the way SEP-24 opens it</button></p>
<p>Network: <code>${networkPassphrase}</code><br>Escrow: <code>${escrowContractId}</code></p>
<script src="/sep24/${SIGNING_PROBE_SCRIPT_PATH}"></script>
</body>
</html>`;
}

export function renderSigningProbeScript(): string {
  return `(function () {
  var out = document.getElementById('out');
  var go = document.getElementById('go');
  var rows = [];
  function paint() {
    out.innerHTML = rows.map(function (r) { return '<div class="row ' + r.k + '">' + r.t + '</div>'; }).join('');
  }
  function say(k, t) { rows.push({ k: k, t: t }); paint(); }

  var GLOBALS = ['freighterApi', 'freighter', 'stellar', 'rabetApi', 'lobstrApi', 'xBullSDK', 'albedo', 'diam'];

  function globalsPresent() {
    var found = [];
    for (var i = 0; i < GLOBALS.length; i++) {
      if (typeof window[GLOBALS[i]] !== 'undefined') found.push(GLOBALS[i] + '=' + typeof window[GLOBALS[i]]);
    }
    return found;
  }

  function askFreighter() {
    return new Promise(function (resolve) {
      var messageId = Date.now() + Math.random();
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        window.removeEventListener('message', onReply);
        resolve(null);
      }, 3000);
      function onReply(ev) {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d.source !== 'FREIGHTER_EXTERNAL_MSG_RESPONSE') return;
        if (d.messagedId !== messageId && d.messageId !== messageId) return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onReply);
        resolve(d);
      }
      window.addEventListener('message', onReply, false);
      window.postMessage(
        { source: 'FREIGHTER_EXTERNAL_MSG_REQUEST', messageId: messageId, type: 'REQUEST_CONNECTION_STATUS' },
        window.location.origin
      );
    });
  }

  function run() {
    rows = [];
    var inPopup = !!window.opener;
    say(inPopup ? 'yes' : 'wait', 'Running on <code>' + location.origin + '</code>, opened as <b>' + (inPopup ? 'a POPUP with an opener — the same context SEP-24 uses' : 'a normal tab. SEP-24 opens a popup, so press the popup button below to test the real context') + '</b>.');
    var g = globalsPresent();
    say(g.length ? 'yes' : 'wait', g.length ? 'Injected globals: <code>' + g.join(', ') + '</code>' : 'No injected wallet global. That alone proves nothing — Freighter 6 answers over postMessage, not a global.');
    say('wait', 'Asking Freighter over its real channel (REQUEST_CONNECTION_STATUS), 3s timeout…');
    askFreighter().then(function (reply) {
      if (!reply) {
        say('no', 'No answer. Either no Freighter extension is installed in this browser, or it does not reach this page.');
        say('wait', '<b>The control that tells those apart:</b> open <code>https://app.lolipay.app</code> in <b>this same browser</b> and try to connect a wallet. If it connects there and not here, the extension is blocked on this origin. If it connects nowhere, no wallet is installed here.');
        return;
      }
      say('yes', 'Freighter ANSWERED: <code>' + JSON.stringify(reply).slice(0, 300) + '</code>');
      say('yes', 'A wallet is reachable from the anchor\\'s own page. A Soroban signature is therefore possible from a SEP-24 popup in this browser.');
    });
  }

  go.addEventListener('click', run);

  var pop = document.getElementById('pop');
  if (pop) {
    pop.addEventListener('click', function () {
      window.open(location.href, 'lolipay-signing-probe', 'width=520,height=720');
    });
  }

  run();
})();`;
}
