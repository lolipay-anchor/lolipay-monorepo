export const FUND_SCRIPT_PATH = 'fund.js';
export const RELEASE_SCRIPT_PATH = 'release.js';

export function renderSignScript(id: string, kind: 'fund' | 'release', rpcUrl: string): string {
  const txPath = kind === 'fund' ? 'fund-tx' : 'release-tx';
  const done = kind === 'fund'
    ? 'Your USDC is in escrow. Taking you to the next step…'
    : 'Confirmed. The escrow has been released and this withdrawal is finished.';
  return `(function () {
  var out = document.getElementById('out');
  var go = document.getElementById('go');
  var base = ${JSON.stringify('/sep24/interactive/' + id)};
  var RPC = ${JSON.stringify(rpcUrl)};
  function say(t) { out.textContent = t; }

  function ask(type, extra, timeoutMs) {
    return new Promise(function (resolve) {
      var messageId = Date.now() + Math.random();
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onReply);
        resolve(null);
      }, timeoutMs);
      function onReply(ev) {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d.source !== 'FREIGHTER_EXTERNAL_MSG_RESPONSE') return;
        if (d.messagedId !== messageId && d.messageId !== messageId) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onReply);
        resolve(d);
      }
      window.addEventListener('message', onReply, false);
      var msg = { source: 'FREIGHTER_EXTERNAL_MSG_REQUEST', messageId: messageId, type: type };
      for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k]; }
      window.postMessage(msg, window.location.origin);
    });
  }

  say('Checking for a wallet in this browser…');
  ask('REQUEST_CONNECTION_STATUS', {}, 4000).then(function (reply) {
    if (!reply || !reply.isConnected) {
      say('No wallet answered this page. This withdrawal needs a browser wallet that can sign a Soroban call. Open this link in a browser where yours is installed.');
      go.disabled = true;
      return;
    }
    say('A wallet is ready. Press the button when you are.');
  });

  function rpc(method, params) {
    return fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }),
    }).then(function (res) { return res.json(); });
  }

  function confirmed(hash) {
    var deadline = Date.now() + 90000;
    function look() {
      return rpc('getTransaction', { hash: hash }).then(function (j) {
        var status = j && j.result && j.result.status;
        if (status === 'SUCCESS') return true;
        if (status === 'FAILED') {
          throw new Error('the network applied it and it failed — nothing moved');
        }
        if (Date.now() > deadline) {
          throw new Error('the network has not confirmed it yet — reload this page in a moment to see where it stands');
        }
        return new Promise(function (r) { setTimeout(r, 2000); }).then(look);
      });
    }
    return look();
  }

  go.addEventListener('click', function () {
    go.disabled = true;
    say('Asking your wallet for its address…');
    ask('REQUEST_ACCESS', {}, 120000)
      .then(function (access) {
        if (!access || !access.publicKey) throw new Error('the wallet did not give an address');
        say('Building the transaction…');
        return fetch(base + '/${txPath}', { credentials: 'same-origin' }).then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok || !j.xdr) throw new Error(j.message || 'this anchor could not build it');
            return j;
          });
        });
      })
      .then(function (built) {
        say('Your wallet should be asking you to approve it now.');
        return ask('SUBMIT_TRANSACTION', {
          transactionXdr: built.xdr,
          networkPassphrase: built.networkPassphrase,
        }, 180000).then(function (signed) {
          if (!signed) throw new Error('the wallet never answered');
          if (signed.apiError || !signed.signedTransaction) throw new Error('the wallet refused');
          return { signed: signed.signedTransaction, networkPassphrase: built.networkPassphrase };
        });
      })
      .then(function (r) {
        say('Sending it to the network…');
        return rpc('sendTransaction', { transaction: r.signed }).then(function (j) {
          var status = j && j.result && j.result.status;
          if (j && j.error) throw new Error(j.error.message || 'the network refused it');
          if (status !== 'PENDING' && status !== 'SUCCESS') {
            throw new Error('the network answered ' + status);
          }
          return j.result.hash;
        });
      })
      .then(function (hash) {
        say('Waiting for the network to apply it…');
        return confirmed(hash);
      })
      .then(function () {
        say(${JSON.stringify(done)});
        setTimeout(function () { window.location.reload(); }, 1500);
      })
      .catch(function (e) {
        say('That did not go through: ' + (e && e.message ? e.message : String(e)) + ' — you can press the button again.');
        go.disabled = false;
      });
  });
})();`;
}
