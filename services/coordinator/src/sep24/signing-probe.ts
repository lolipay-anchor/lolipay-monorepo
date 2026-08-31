export const SIGNING_PROBE_PATH = 'signing-probe';

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
sends nothing to the server. Open it in the browser you would use for a withdrawal, and if a wallet
extension is installed, press the button.</p>
<div id="out"><div class="row wait">checking…</div></div>
<p><button id="go" disabled>Ask the wallet to sign a test call</button></p>
<p>Network: <code>${networkPassphrase}</code><br>Escrow: <code>${escrowContractId}</code></p>
<script>
const out = document.getElementById('out');
const go = document.getElementById('go');
const rows = [];
function paint(){ out.innerHTML = rows.map(r => '<div class="row ' + r.k + '">' + r.t + '</div>').join(''); }
function say(k, t){ rows.push({k, t}); paint(); }

const injected = [];
for (const name of ['freighterApi','freighter','stellar','rabetApi','lobstrApi','xBullSDK','albedo']) {
  if (typeof window[name] !== 'undefined') injected.push(name);
}
if (injected.length) {
  say('yes', 'An injected wallet API IS present on this page: <code>' + injected.join(', ') + '</code>');
  go.disabled = false;
} else {
  say('no', 'No injected wallet API is reachable from this page. A withdrawal cannot be signed here.');
}
say('wait', 'Page origin: <code>' + location.origin + '</code> — opened as ' + (window.opener ? 'a POPUP with an opener' : 'a normal tab'));

go.addEventListener('click', async () => {
  go.disabled = true;
  try {
    const api = window.freighterApi || window.freighter;
    if (!api) { say('no', 'The button found no Freighter-shaped API to call.'); return; }
    const connected = api.isConnected ? await api.isConnected() : true;
    say(connected ? 'yes' : 'no', 'isConnected() → <code>' + JSON.stringify(connected) + '</code>');
    const addr = api.getAddress ? await api.getAddress() : (api.getPublicKey ? { address: await api.getPublicKey() } : null);
    say(addr ? 'yes' : 'no', 'address → <code>' + JSON.stringify(addr) + '</code>');
    say('yes', 'A wallet answered this page. Signing a real Soroban invocation is therefore reachable from a SEP-24 popup in THIS browser.');
  } catch (e) {
    say('no', 'The wallet refused or errored: <code>' + (e && e.message ? e.message : String(e)) + '</code>');
  }
});
</script>
</body>
</html>`;
}
