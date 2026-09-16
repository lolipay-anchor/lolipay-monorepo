import 'reflect-metadata';
import { Sep12Service } from './sep12.service';
import { Sep24Service } from '../sep24/sep24.service';
import { mintInteractiveToken } from '../sep24/interactive-token';
import { acceptedForFunds } from './screening-requirement';

const DAY = 24 * 60 * 60 * 1000;
const PERSON = 'person-1';
const REF = 'GABC';

const stale = () => new Date(Date.now() - 40 * DAY);
const fresh = () => new Date(Date.now() - 60_000);

type Exit = 'VERIFIED' | 'REFUSED' | 'WAITING' | 'ASKED';

function row(over: Record<string, unknown>) {
  return {
    customerRef: REF,
    personId: PERSON,
    status: 'NEEDS_INFO',
    providerRef: null,
    verificationUrl: null,
    rejectionReason: null,
    deliveredAt: null,
    screenedAt: null,
    verifiedAt: null,
    updatedAt: fresh(),
    ...over,
  } as any;
}

function matches(candidate: any, where: any): boolean {
  if (!candidate) return false;
  if (where.status !== undefined && candidate.status !== where.status) return false;
  if (where.customerRef !== undefined && candidate.customerRef !== where.customerRef) return false;
  if (where.personId !== undefined && candidate.personId !== where.personId) return false;
  if (where.screenedAt?.not === null && candidate.screenedAt === null) return false;
  if (where.deliveredAt?.not === null && candidate.deliveredAt === null) return false;
  if (where.NOT?.customerRef !== undefined && candidate.customerRef === where.NOT.customerRef) return false;
  if (
    where.OR !== undefined &&
    !where.OR.some((clause: any) => matches(candidate, clause))
  ) {
    return false;
  }
  return true;
}

const TX = {
  id: 'tx-1',
  stellarAccount: REF,
  personId: PERSON,
  orderId: null,
  startedAt: new Date(),
  flow: 'TOP_UP',
  order: null,
};

function prismaFor(stored: any) {
  return {
    person: { update: jest.fn(async () => ({})) },
    kycVerification: {
      findUnique: jest.fn(async ({ where }: any) => (matches(stored, where) ? stored : null)),
      findFirst: jest.fn(async ({ where }: any) => (matches(stored, where) ? stored : null)),
    },
    sep24Transaction: { findUnique: jest.fn(async () => TX) },
  } as any;
}

const people = { lookupPerson: jest.fn(async () => ({ id: PERSON })) } as any;

function sep12For(stored: any, kycRequireAml: boolean) {
  return new Sep12Service(prismaFor(stored), people, {} as any, { kycRequireAml } as any, {} as any);
}

function sep24For(stored: any, kycRequireAml: boolean) {
  const cfg = {
    anchorBaseUrl: 'https://api.lolipay.app',
    usdcAssetCode: 'USDC',
    usdcAssetIssuer: 'GISSUER',
    jwtSecret: ['unit', 'test', 'key', '0123456789'].join('-'),
    jwtIssuer: 'https://lolipay.app',
    jwtAudience: 'lolipay-app',
    kycRequireAml,
  } as any;
  const svc = new Sep24Service(
    prismaFor(stored),
    cfg,
    {} as any,
    {} as any,
    {} as any,
    people,
    {} as any,
    {} as any,
    { isConfigured: false } as any,
  );
  return { svc, token: mintInteractiveToken(cfg, 'tx-1', REF) };
}

function exitOfCustomer(answer: any): Exit | string {
  if (answer.status === 'REJECTED') return 'REFUSED';
  if (answer.status === 'ACCEPTED') return 'VERIFIED';
  if (answer.status === 'PROCESSING') return 'WAITING';
  if (answer.status === 'NEEDS_INFO') {
    return answer.fields && Object.keys(answer.fields).length > 0
      ? 'ASKED'
      : 'NEEDS_INFO WITH NO FIELDS TO FILL IN';
  }
  return `AN ANSWER NO SEP-12 CLIENT UNDERSTANDS: ${String(answer.status)}`;
}

const SCREEN_EXIT: Record<string, Exit> = {
  'How much would you like to deposit?': 'VERIFIED',
  'Verification refused': 'REFUSED',
  'Verify your identity with Didit': 'WAITING',
  'Checking your identity': 'WAITING',
  'Verify your identity': 'ASKED',
};

function exitOfPopup(html: string): Exit | string {
  const heading = /<h1>([^<]*)<\/h1>/.exec(html)?.[1] ?? '';
  return SCREEN_EXIT[heading] ?? `A SCREEN THIS INVARIANT DOES NOT CLASSIFY: ${heading}`;
}

const SHAPES: { name: string; stored: any; exit: (requireAml: boolean) => Exit }[] = [
  {
    name: 'a wallet that has never submitted anything',
    stored: null,
    exit: () => 'ASKED',
  },
  {
    name: 'a form that arrived incomplete',
    stored: row({ status: 'NEEDS_INFO' }),
    exit: () => 'ASKED',
  },
  {
    name: 'an identity the anchor refused',
    stored: row({ status: 'REJECTED', rejectionReason: 'sanctions or watchlist match', deliveredAt: stale() }),
    exit: () => 'REFUSED',
  },
  {
    name: 'an acceptance the provider delivered and screened',
    stored: row({ status: 'ACCEPTED', deliveredAt: stale(), screenedAt: stale(), verifiedAt: stale() }),
    exit: () => 'VERIFIED',
  },
  {
    name: 'an acceptance the provider delivered without a screening',
    stored: row({ status: 'ACCEPTED', deliveredAt: stale(), screenedAt: null, verifiedAt: stale() }),
    exit: (requireAml) => (requireAml ? 'ASKED' : 'VERIFIED'),
  },
  {
    name: 'an acceptance written seconds ago that no delivery has answered yet',
    stored: row({ status: 'ACCEPTED', verifiedAt: fresh() }),
    exit: () => 'WAITING',
  },
  {
    name: 'an acceptance no delivery ever answered, older than a session can live',
    stored: row({ status: 'ACCEPTED', verifiedAt: stale(), updatedAt: stale() }),
    exit: () => 'ASKED',
  },
  {
    name: 'a session open at the provider',
    stored: row({ status: 'PROCESSING', providerRef: 'session-1', verificationUrl: 'https://verify.didit.me/s/1' }),
    exit: () => 'WAITING',
  },
  {
    name: 'a session the provider never answered, older than a session can live',
    stored: row({
      status: 'PROCESSING',
      providerRef: 'session-1',
      verificationUrl: 'https://verify.didit.me/s/1',
      updatedAt: stale(),
    }),
    exit: () => 'ASKED',
  },
  {
    name: 'a row left processing that names no session at the provider at all',
    stored: row({ status: 'PROCESSING', providerRef: null }),
    exit: () => 'ASKED',
  },
];

function aged(stored: any) {
  const shifted: any = { ...stored };
  for (const field of ['updatedAt', 'verifiedAt', 'deliveredAt', 'screenedAt']) {
    if (shifted[field] instanceof Date) shifted[field] = new Date(shifted[field].getTime() - 40 * DAY);
  }
  return shifted;
}

describe('every KycVerification row sits in exactly one of four states, so nobody is left holding a row that asks nothing of them and lets them do nothing', () => {
  it('enumerates every shape a writer of this table can produce, so a shape dropped from the list fails here rather than going untested', () => {
    expect(SHAPES).toHaveLength(10);
    expect(new Set(SHAPES.map((s) => s.name)).size).toBe(10);
  });

  for (const requireAml of [true, false]) {
    describe(`with KYC_REQUIRE_AML=${requireAml}`, () => {
      for (const shape of SHAPES) {
        it(`answers ${shape.name} with an exit the person can take`, async () => {
          const expected = shape.exit(requireAml);

          const answer = await sep12For(shape.stored, requireAml).get(REF);
          expect({ shape: shape.name, exit: exitOfCustomer(answer) }).toEqual({
            shape: shape.name,
            exit: expected,
          });

          const { svc, token } = sep24For(shape.stored, requireAml);
          expect({ shape: shape.name, exit: exitOfPopup(await svc.renderInteractive('tx-1', token)) }).toEqual({
            shape: shape.name,
            exit: expected,
          });

          if (expected === 'VERIFIED') {
            expect(matches(shape.stored, acceptedForFunds(requireAml))).toBe(true);
          } else {
            expect(matches(shape.stored, acceptedForFunds(requireAml))).toBe(false);
          }
        });
      }

      it('holds no row in WAITING for ever: every waiting shape, once older than a session can live, is asked for its details instead', async () => {
        const waiting = SHAPES.filter((s) => s.exit(requireAml) === 'WAITING');
        expect(waiting.length).toBeGreaterThan(0);

        for (const shape of waiting) {
          const stored = aged(shape.stored);
          expect({ shape: shape.name, exit: exitOfCustomer(await sep12For(stored, requireAml).get(REF)) }).toEqual({
            shape: shape.name,
            exit: 'ASKED',
          });

          const { svc, token } = sep24For(stored, requireAml);
          expect({ shape: shape.name, exit: exitOfPopup(await svc.renderInteractive('tx-1', token)) }).toEqual({
            shape: shape.name,
            exit: 'ASKED',
          });
        }
      });
    });
  }
});
