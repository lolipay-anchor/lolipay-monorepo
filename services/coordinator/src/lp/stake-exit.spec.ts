import { Test } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException, INestApplication } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import request from 'supertest';

import { LpController } from './lp.controller';
import { LpService } from './lp.service';
import { RolesGuard } from '../auth/roles.guard';
import { resolveRole } from '../auth/role.util';
import { LpStatus } from '../generated/prisma/client';

const PROVIDER = 'GPROVIDER...';
const ADMIN_WALLET = 'GADMINWHOISALSOAPROVIDER...';
const EXIT_METHODS = ['buildRequestUnstakeTx', 'buildClaimUnstakeTx', 'getEligibility'] as const;
const EVERY_STATUS = Object.values(LpStatus);
const NON_APPROVED = EVERY_STATUS.filter((s) => s !== 'APPROVED');
const EXPECTED_ROLES: Record<string, string[]> = {
  apply: ['user', 'lp', 'admin'],
  me: ['user', 'lp', 'admin'],
  earnings: ['lp'],
  heartbeat: ['lp'],
  setAvailability: ['lp'],
  addPaymentMethod: ['lp'],
  updatePaymentMethod: ['lp'],
  deletePaymentMethod: ['lp'],
  buildStakeTx: ['lp'],
  buildRequestUnstakeTx: ['user', 'lp', 'admin'],
  buildClaimUnstakeTx: ['user', 'lp', 'admin'],
  getEligibility: ['user', 'lp', 'admin'],
};

function rolesOf(method: keyof LpController): string[] {
  return Reflect.getMetadata('roles', LpController.prototype[method] as any) ?? [];
}

describe('a provider can always reach their own staked money on the way OUT, whatever their status', () => {
  it('reads all four provider statuses, so the per-status cases below are generated rather than silently skipped, and a fifth status forces a decision about whether it can exit', () => {
    expect(EVERY_STATUS).toHaveLength(4);
    expect(NON_APPROVED).toHaveLength(3);
  });

  describe('the routes', () => {
    it('opens the three exit routes to user, lp and admin, so a provider whose status changed can still get their money out', () => {
      for (const m of EXIT_METHODS) {
        expect(rolesOf(m)).toEqual(['user', 'lp', 'admin']);
      }
    });

    it('leaves the stake door bound to lp alone, so the admin wallet and an unapproved provider stay out of the direction that locks money in', () => {
      expect(rolesOf('buildStakeTx')).toEqual(['lp']);
    });

    it('classifies every route on the controller and no others, so a route added or a decorator emptied — which the guard reads as no authorisation at all — cannot slip in unnoticed', () => {
      const actual = Object.getOwnPropertyNames(LpController.prototype).filter((m) => m !== 'constructor');

      expect(actual.sort()).toEqual(Object.keys(EXPECTED_ROLES).sort());

      for (const m of actual) {
        expect(rolesOf(m as keyof LpController)).toEqual(EXPECTED_ROLES[m]);
      }
    });
  });

  describe('the real guard on the real routes', () => {
    let app: INestApplication;

    const lpService = {
      apply: jest.fn(),
      me: jest.fn(),
      getEarnings: jest.fn(),
      heartbeat: jest.fn(),
      setAvailability: jest.fn(),
      addPaymentMethod: jest.fn(),
      updatePaymentMethod: jest.fn(),
      deletePaymentMethod: jest.fn(),
      buildStakeTx: jest.fn(),
      buildRequestUnstakeTx: jest.fn(),
      buildClaimUnstakeTx: jest.fn(),
      getStakeInfo: jest.fn(),
    };

    function prismaFor(status: string | null) {
      return {
        walletLink: { findUnique: jest.fn(async () => ({ status: 'ACTIVE' })) },
        lp: { findUnique: jest.fn(async () => (status === null ? null : { status })) },
      } as any;
    }

    beforeAll(async () => {
      const mod = await Test.createTestingModule({
        controllers: [LpController],
        providers: [{ provide: LpService, useValue: lpService }, Reflector, RolesGuard],
      })
        .overrideGuard(AuthGuard('jwt'))
        .useValue({
          canActivate: (ctx: ExecutionContext) => {
            const req = ctx.switchToHttp().getRequest();
            req.user = { address: PROVIDER, role: req.headers['x-test-role'] };
            return true;
          },
        })
        .compile();

      app = mod.createNestApplication();
      await app.init();
    });

    afterAll(() => app.close());
    beforeEach(() => jest.clearAllMocks());

    it('lets an APPROVED provider stake, because they are the only ones matching can ever pick', async () => {
      const role = await resolveRole(PROVIDER, prismaFor('APPROVED'), [ADMIN_WALLET], 'session');
      expect(role).toBe('lp');
      lpService.buildStakeTx.mockResolvedValue({ xdr: 'x', networkPassphrase: 'n' });

      await request(app.getHttpServer())
        .get('/lp/tx/stake?amount=1000000000')
        .set('x-test-role', role)
        .expect(200);

      expect(lpService.buildStakeTx).toHaveBeenCalledWith(PROVIDER, '1000000000');
    });

    for (const status of NON_APPROVED) {
      it(`refuses a ${status} provider at the stake door, because matching can never pick them and staking would only lock their own USDC behind the cooldown`, async () => {
        const role = await resolveRole(PROVIDER, prismaFor(status), [ADMIN_WALLET], 'session');
        expect(role).toBe('user');

        await request(app.getHttpServer())
          .get('/lp/tx/stake?amount=1000000000')
          .set('x-test-role', role)
          .expect(403);

        expect(lpService.buildStakeTx).not.toHaveBeenCalled();
      });
    }

    it('refuses the admin wallet at the stake door even though it is also an APPROVED provider, because the allowlist decides its role before the provider table is read', async () => {
      const role = await resolveRole(ADMIN_WALLET, prismaFor('APPROVED'), [ADMIN_WALLET], 'session');
      expect(role).toBe('admin');

      await request(app.getHttpServer())
        .get('/lp/tx/stake?amount=1000000000')
        .set('x-test-role', role)
        .expect(403);

      expect(lpService.buildStakeTx).not.toHaveBeenCalled();
    });

    for (const role of ['user', 'admin']) {
      it(`lets the ${role} the stake door refuses claim their unstaked money anyway, which is the whole point of widening the exit`, async () => {
        lpService.buildClaimUnstakeTx.mockResolvedValue({ xdr: 'x', networkPassphrase: 'n' });

        await request(app.getHttpServer())
          .get('/lp/tx/claim-unstake')
          .set('x-test-role', role)
          .expect(200);

        expect(lpService.buildClaimUnstakeTx).toHaveBeenCalledWith(PROVIDER);
      });
    }
  });

  describe('the gate that replaced the role', () => {
    function make(lpRow: any) {
      const prisma: any = { lp: { findUnique: jest.fn(async () => lpRow) } };
      const stellar: any = {
        buildStakeTx: jest.fn(async () => ({ xdr: 'x', networkPassphrase: 'n' })),
        buildRequestUnstakeTx: jest.fn(async () => ({ xdr: 'x', networkPassphrase: 'n' })),
        buildClaimUnstakeTx: jest.fn(async () => ({ xdr: 'x', networkPassphrase: 'n' })),
        getStakeInfo: jest.fn(async () => ({ staked: '0', unbonding: '0', eligible: false })),
      };
      return { svc: new LpService(prisma, stellar), prisma, stellar };
    }

    async function refusal(call: Promise<unknown>) {
      let err: any;
      try {
        await call;
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getStatus()).toBe(403);
      expect(err.message).toBe('this wallet is not a registered provider');
    }

    for (const status of EVERY_STATUS) {
      it(`lets a ${status} provider request an unstake and claim it, because the contract does and the money is theirs`, async () => {
        const { svc, stellar } = make({ id: 'lp1', stellarAddress: 'GLP', status });
        await expect(svc.buildRequestUnstakeTx('GLP', '1')).resolves.toBeTruthy();
        await expect(svc.buildClaimUnstakeTx('GLP')).resolves.toBeTruthy();
        await expect(svc.getStakeInfo('GLP')).resolves.toBeTruthy();
        expect(stellar.buildRequestUnstakeTx).toHaveBeenCalledWith('GLP', '1');
      });
    }

    it('refuses an address that is not a provider at all with a 403, on every one of the four', async () => {
      const { svc, stellar } = make(null);
      await refusal(svc.buildStakeTx('GSTRANGER', '1'));
      await refusal(svc.buildRequestUnstakeTx('GSTRANGER', '1'));
      await refusal(svc.buildClaimUnstakeTx('GSTRANGER'));
      await refusal(svc.getStakeInfo('GSTRANGER'));
      expect(stellar.buildStakeTx).not.toHaveBeenCalled();
      expect(stellar.buildRequestUnstakeTx).not.toHaveBeenCalled();
      expect(stellar.buildClaimUnstakeTx).not.toHaveBeenCalled();
      expect(stellar.getStakeInfo).not.toHaveBeenCalled();
    });

    it('looks the provider up by the caller own address, never by one supplied in the request', async () => {
      const { svc, prisma } = make({ id: 'lp1', stellarAddress: 'GLP', status: 'SUSPENDED' });
      await svc.buildClaimUnstakeTx('GLP');
      expect(prisma.lp.findUnique).toHaveBeenCalledWith({ where: { stellarAddress: 'GLP' }, select: { id: true } });
    });
  });
});
