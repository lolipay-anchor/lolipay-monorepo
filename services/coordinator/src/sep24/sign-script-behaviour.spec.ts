import vm from 'node:vm';
import { renderSignScript } from './sign-script';

const RPC = 'https://rpc.example.test';

type Reply = { status?: string; error?: any; reject?: boolean };

function run(getTransactionReplies: Reply[]) {
  const said: string[] = [];
  let reloads = 0;
  let clicked: any = null;
  const out = { set textContent(v: string) { said.push(v); }, get textContent() { return said[said.length - 1] ?? ''; } };
  const go = {
    disabled: false,
    addEventListener: (_: string, fn: any) => { clicked = fn; },
  };
  let polls = 0;

  const listeners: any[] = [];
  let clock = 0;
  const sandbox: any = {
    document: { getElementById: (id: string) => (id === 'out' ? out : go) },
    setTimeout: (fn: any, ms: number) => {
      if (ms === 2000 || ms === 5000) {
        clock += ms;
        Promise.resolve().then(fn);
      }
      return 0;
    },
    clearTimeout: () => undefined,
    Promise,
    JSON,
    Date: { now: () => clock },
    Math,
    Object,
    Error,
    fetch: (url: string, init: any) => {
      if (!init || !init.body) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ xdr: 'XDR', networkPassphrase: 'Test SDF Network ; September 2015' }),
        });
      }
      void url;
      const body = JSON.parse(init.body);
      if (body.method === 'sendTransaction') {
        return Promise.resolve({ json: () => Promise.resolve({ result: { status: 'PENDING', hash: 'HASH' } }) });
      }
      const reply = getTransactionReplies[Math.min(polls, getTransactionReplies.length - 1)];
      polls += 1;
      if (reply.reject) return Promise.resolve({ json: () => Promise.reject(new Error('not json')) });
      return Promise.resolve({ json: () => Promise.resolve(reply.error ? { error: reply.error } : { result: { status: reply.status } }) });
    },
  };
  sandbox.window = {
    addEventListener: (_: string, fn: any) => listeners.push(fn),
    removeEventListener: () => undefined,
    postMessage: (msg: any) => {
      const answer =
        msg.type === 'REQUEST_ACCESS'
          ? { publicKey: 'GUSER' }
          : msg.type === 'SUBMIT_TRANSACTION'
            ? { signedTransaction: 'SIGNED' }
            : { isConnected: true };
      for (const fn of [...listeners]) {
        fn({ source: sandbox.window, data: { source: 'FREIGHTER_EXTERNAL_MSG_RESPONSE', messagedId: msg.messageId, ...answer } });
      }
    },
    location: { origin: 'https://anchor.test', reload: () => { reloads += 1; } },
  };

  vm.createContext(sandbox);
  vm.runInContext(renderSignScript('tx-1', 'release', RPC), sandbox);
  return { said, click: () => clicked(), reloads: () => reloads, go, polls: () => polls };
}

const settle = async (h: ReturnType<typeof run>) => {
  await h.click();
  for (let i = 0; i < 3000; i += 1) await Promise.resolve();
};

describe('running the signing script, rather than reading it', () => {
  it('parses', () => {
    expect(() => new Function(renderSignScript('tx-1', 'fund', RPC))).not.toThrow();
  });

  it('says the escrow is released only when the network says SUCCESS', async () => {
    const h = run([{ status: 'SUCCESS' }]);
    await settle(h);
    expect(h.said.join(' | ')).toMatch(/the escrow has been released/i);
    expect(h.said.join(' | ')).not.toMatch(/did not go through/i);
  });

  it('reports a FAILED transaction as failed, and never as finished', async () => {
    const h = run([{ status: 'FAILED' }]);
    await settle(h);
    const all = h.said.join(' | ');
    expect(all).toMatch(/it failed — nothing moved/i);
    expect(all).not.toMatch(/the escrow has been released/i);
  });

  it('does not claim failure when the poll itself keeps erroring, because the money may well have moved', async () => {
    const h = run([{ reject: true }]);
    await settle(h);
    const all = h.said.join(' | ');
    expect(all).toMatch(/has not said yet whether it applied/i);
    expect(all).not.toMatch(/did not go through/i);
    expect(all).not.toMatch(/the escrow has been released/i);
  });

  it('does not claim failure when the network answers a JSON-RPC error object', async () => {
    const h = run([{ error: { message: 'rate limited' } }]);
    await settle(h);
    expect(h.said.join(' | ')).toMatch(/has not said yet whether it applied/i);
  });

  it('hands the page back to the server once, whatever the outcome', async () => {
    for (const replies of [[{ status: 'SUCCESS' }], [{ reject: true }]] as Reply[][]) {
      const h = run(replies);
      await settle(h);
      expect(h.reloads()).toBe(1);
    }
  });
});
