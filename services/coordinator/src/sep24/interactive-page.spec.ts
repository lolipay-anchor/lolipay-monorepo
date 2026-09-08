import { REQUIRED_KYC_FIELDS } from '../kyc/kyc-provider';
import { interactiveScreen, escapeHtml, page, formatFiat, formatUsdc, effectiveIdrPerUsdc, settledRefreshSecs, identityField } from './interactive-page';

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

describe('effectiveIdrPerUsdc', () => {
  it.each([
    [16_000_000n, 1_000_0000000n, 16_000n],
    [176_315n, 10_0000000n, 17_632n],
    [1n, 3_0000000n, 0n],
    [1n, 0n, 0n],
  ])('turns %s IDR for %s base units into %s IDR per USDC, rounded to the nearest rupiah, never dividing by zero', (fiat, usdc, expected) => {
    expect(effectiveIdrPerUsdc(fiat, usdc)).toBe(expected);
  });
});

describe('how often the settled screen asks the browser to look again', () => {
  it('keeps refreshing while the anchor still has work to do, and stops once the deposit is over', () => {
    expect(settledRefreshSecs('pending_anchor')).toBe(15);
    expect(settledRefreshSecs('pending_user')).toBe(15);
    expect(settledRefreshSecs('completed')).toBeUndefined();
    expect(settledRefreshSecs('refunded')).toBeUndefined();
    expect(settledRefreshSecs('expired')).toBeUndefined();
  });
});

describe('every screen wears the same small stylesheet', () => {
  it('wraps the body in a main column with the wordmark, a system font, no body margin, and unbreakable addresses that wrap', () => {
    const html = page('T', '<p>x</p>');
    expect(html).toContain('<style>');
    expect(html).toContain('max-width');
    expect(html).toContain('body{margin:0');
    expect(html).toContain('pre,code{white-space:pre-wrap;overflow-wrap:break-word;overflow-wrap:anywhere}');
    expect(html).toContain('input,select{width:100%;font:inherit;font-weight:400;');
    expect(html).toContain('<main><p class="brand">lolipay</p><h1>T</h1>');
    expect(html).toContain('<p>x</p></main>');
    expect(html).not.toContain('http-equiv');
  });
});

describe('the identity form says what to type', () => {
  it('labels the name fields and lets the browser autofill them', () => {
    expect(identityField('first_name')).toBe(
      '<label for="first_name">First name</label><input id="first_name" name="first_name" required autocomplete="given-name">',
    );
    expect(identityField('last_name')).toContain('Last name');
    expect(identityField('last_name')).toContain('autocomplete="family-name"');
  });

  it('asks for the email as an email', () => {
    const html = identityField('email_address');
    expect(html).toContain('Email address');
    expect(html).toContain('type="email"');
    expect(html).toContain('autocomplete="email"');
  });

  it('offers the document types as a list with the Indonesian ID card first, and asks nothing the list already answers', () => {
    const html = identityField('id_type');
    expect(html).toContain('Identity document');
    expect(html).toContain('<select id="id_type" name="id_type">');
    expect(html).toContain('<option value="id_card" selected>KTP / national ID card</option>');
    expect(html).toContain('<option value="passport">Passport</option>');
    expect(html).toContain('<option value="drivers_license">Driving licence</option>');
    expect(html).not.toContain('required');
  });

  it('fills the issuing country with IDN and accepts only a three-letter code', () => {
    expect(identityField('id_country_code')).toBe(
      '<label for="id_country_code">Country that issued it (3-letter code)</label><input id="id_country_code" name="id_country_code" value="IDN" pattern="[A-Za-z]{3}" maxlength="3" autocapitalize="characters" required>',
    );
  });

  it('still renders a labelled required input for a field it has no words for, so a new required field is posted rather than lost', () => {
    const html = identityField('address');
    expect(html).toContain('name="address"');
    expect(html).toContain('<label for="address">address</label>');
    expect(identityField('address_line')).toContain('<label for="address_line">address line</label>');
    expect(html).toContain('required');
  });

  it('renders every required field with its name and a label', () => {
    expect(
      REQUIRED_KYC_FIELDS.every(
        (f) => identityField(f).includes(`name="${f}"`) && /<label[^>]*>[^<]+<\/label>/.test(identityField(f)),
      ),
    ).toBe(true);
  });
});
