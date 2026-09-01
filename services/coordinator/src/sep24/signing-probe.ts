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
<p><button id="go">Ask the wallet to identify itself</button></p>
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

  rows = [];
  say('yes', 'The script ran, so this page is allowed to execute JavaScript.');

  var names = ['freighterApi', 'freighter', 'stellar', 'rabetApi', 'lobstrApi', 'xBullSDK', 'albedo', 'diam'];
  var found = [];
  for (var i = 0; i < names.length; i++) {
    if (typeof window[names[i]] !== 'undefined') found.push(names[i]);
  }
  if (found.length) {
    say('yes', 'An injected wallet API IS present: <code>' + found.join(', ') + '</code>');
  } else {
    say('no', 'No injected wallet API is on <code>window</code> right now. Some wallets inject late — press the button to check again.');
  }
  say('wait', 'Origin <code>' + location.origin + '</code>, opened as ' + (window.opener ? 'a popup with an opener' : 'a normal tab') + '.');

  go.addEventListener('click', function () {
    go.disabled = true;
    rows = [];
    say('yes', 'The button works, so the script is running.');
    var again = [];
    for (var j = 0; j < names.length; j++) {
      if (typeof window[names[j]] !== 'undefined') again.push(names[j]);
    }
    if (!again.length) {
      say('no', 'Still no injected wallet API. No wallet extension is reachable from this page in this browser.');
      go.disabled = false;
      return;
    }
    say('yes', 'Injected: <code>' + again.join(', ') + '</code>');
    var api = window.freighterApi || window.freighter;
    if (!api) {
      say('wait', 'A wallet is injected but it is not Freighter-shaped, so this probe cannot interrogate it further.');
      go.disabled = false;
      return;
    }
    Promise.resolve()
      .then(function () { return api.isConnected ? api.isConnected() : true; })
      .then(function (c) { say('yes', 'isConnected() &rarr; <code>' + JSON.stringify(c) + '</code>'); })
      .then(function () {
        if (api.requestAccess) return api.requestAccess();
        if (api.getAddress) return api.getAddress();
        if (api.getPublicKey) return api.getPublicKey();
        return null;
      })
      .then(function (a) {
        say(a ? 'yes' : 'no', 'address &rarr; <code>' + JSON.stringify(a) + '</code>');
        say('yes', 'A wallet answered this page. A Soroban signature is therefore reachable from a SEP-24 popup in THIS browser.');
      })
      .catch(function (e) {
        say('no', 'The wallet refused or errored: <code>' + (e && e.message ? e.message : String(e)) + '</code>');
      })
      .then(function () { go.disabled = false; });
  });
})();`;
}
