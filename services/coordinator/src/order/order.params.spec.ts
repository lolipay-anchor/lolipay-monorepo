import { mapRoles, contractIdFor } from './order.params';

describe('mapRoles', () => {
  it('TOP_UP: LP provides USDC + confirms; user pays fiat + receives USDC', () => {
    const r = mapRoles('TOP_UP', 'GUSER', 'GLP');
    expect(r).toEqual({ usdcProvider: 'GLP', usdcRecipient: 'GUSER', confirmer: 'GLP' });
  });
  it('WITHDRAW: user provides USDC + confirms; LP pays fiat + receives USDC', () => {
    expect(mapRoles('WITHDRAW', 'GUSER', 'GLP')).toEqual({ usdcProvider: 'GUSER', usdcRecipient: 'GLP', confirmer: 'GUSER' });
  });
});

describe('contractIdFor', () => {
  const cfg = { escrowContractId: 'CENV_DEFAULT' };

  it('a legacy order (contractId NULL, predates the column) falls back to the env default', () => {
    expect(contractIdFor({ contractId: null }, cfg)).toBe('CENV_DEFAULT');
  });

  it('a legacy order (contractId undefined) also falls back to the env default', () => {
    expect(contractIdFor({}, cfg)).toBe('CENV_DEFAULT');
  });

  it('an order with a snapshotted contractId uses IT, even if the env default has since rotated', () => {
    expect(contractIdFor({ contractId: 'CSNAPSHOTTED' }, { escrowContractId: 'CNEW_ROTATED' })).toBe(
      'CSNAPSHOTTED',
    );
  });
});
