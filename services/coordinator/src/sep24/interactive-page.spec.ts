import { interactiveScreen, escapeHtml, page, formatFiat, formatUsdc } from './interactive-page';

const at = (kycStatus: any, screened: boolean, orderStatus: any) =>
  interactiveScreen({ kycStatus, screened, orderStatus });

describe('which screen a depositor sees, decided from facts two tables already hold', () => {
  it('asks for identity when there is no KYC record at all', () => {
    expect(at(null, false, null)).toBe('identity');
  });

  it('asks again when the anchor needs more information', () => {
    expect(at('NEEDS_INFO', false, null)).toBe('identity');
  });

  it('waits while the provider is still deciding', () => {
    expect(at('PROCESSING', false, null)).toBe('waiting_on_identity');
  });

  it('waits when identity passed but the screening has not, which is the Free-KYC shape', () => {
    expect(at('ACCEPTED', false, null)).toBe('waiting_on_identity');
  });

  it('is terminal for a refused identity, and stays terminal whatever else is true', () => {
    expect(at('REJECTED', false, null)).toBe('refused');
    expect(at('REJECTED', true, 'FUNDED')).toBe('refused');
  });

  it('asks for an amount only once a screening actually happened', () => {
    expect(at('ACCEPTED', true, null)).toBe('amount');
  });

  it.each(['CREATED', 'MATCHED', 'AWAITING_ONCHAIN'])(
    'waits on the escrow while the order is %s',
    (status) => {
      expect(at('ACCEPTED', true, status)).toBe('waiting_on_escrow');
    },
  );

  it('shows payment instructions only when the escrow actually holds the USDC', () => {
    expect(at('ACCEPTED', true, 'FUNDED')).toBe('instructions');
  });

  it.each(['FIAT_PAID', 'RELEASED', 'REFUNDED', 'DISPUTED', 'EXPIRED', 'CANCELLED'])(
    'reports %s as settled rather than asking for anything',
    (status) => {
      expect(at('ACCEPTED', true, status)).toBe('settled');
    },
  );
});

describe('which screen a withdrawing user sees, which is never the depositor one', () => {
  const w = (orderStatus: any) =>
    interactiveScreen({ kycStatus: 'ACCEPTED', screened: true, orderStatus, flow: 'WITHDRAW' });

  it('waits on the escrow, and shows no button, before a provider is matched', () => {
    expect(w('CREATED')).toBe('waiting_on_escrow');
  });

  it.each(['MATCHED', 'AWAITING_ONCHAIN'])('asks for the funding signature at %s', (status) => {
    expect(w(status)).toBe('sign_funding');
  });

  it('waits for the rupiah at FUNDED, because confirm_and_release refuses that status', () => {
    expect(w('FUNDED')).toBe('waiting_on_fiat');
  });

  it('asks for the release signature at FIAT_PAID, the one status the escrow accepts it at', () => {
    expect(w('FIAT_PAID')).toBe('sign_release');
  });

  it.each(['RELEASED', 'REFUNDED', 'DISPUTED', 'EXPIRED', 'CANCELLED'])(
    'reports %s as settled, with nothing left to sign',
    (status) => {
      expect(w(status)).toBe('settled');
    },
  );
});

describe('what the page puts on screen cannot be turned into markup', () => {
  it('escapes every character that could open a tag or an attribute', () => {
    expect(escapeHtml(`<script>alert("x")&'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;',
    );
  });

  it('escapes a title, so a value that reaches it cannot inject', () => {
    expect(page('<b>hi</b>', '')).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(page('<b>hi</b>', '')).not.toContain('<b>hi</b>');
  });

  it('renders nothing for null rather than the word null', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('polls only when asked to', () => {
    expect(page('t', '')).not.toContain('http-equiv');
    expect(page('t', '', 10)).toContain('content="10"');
  });
});

describe('formatFiat', () => {
  it('renders rupiah with dot thousands from whatever digits it is given', () => {
    expect(formatFiat('Rp 1.234.567')).toBe('1.234.567');
    expect(formatFiat(200000n)).toBe('200.000');
    expect(formatFiat('')).toBe('');
  });
});

describe('formatUsdc', () => {
  it.each([
    [1_000_0000000n, '1000'],
    [85_090_000n, '8.509'],
    [10_0000000n, '10'],
    [1n, '0.0000001'],
    [0n, '0'],
  ])('shows %s base units as %s, no trailing zeros and no dangling point', (units, shown) => {
    expect(formatUsdc(units)).toBe(shown);
  });
});
