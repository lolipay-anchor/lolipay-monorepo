import { readDiditDecision } from './didit-decision';

const clean = { status: 'Approved', total_hits: 0, hits: [], warnings: [] };
const hit = { status: 'Declined', total_hits: 2, hits: [{ sanction_matches: [{}] }], warnings: [] };
const unperformed = { status: 'Declined', total_hits: 0, hits: [], warnings: ['COULD_NOT_PERFORM_AML_SCREENING'] };

const payload = (over: Record<string, unknown> = {}) => ({
  status: 'Approved',
  session_id: 'sess-1',
  vendor_data: 'GABC',
  environment: 'sandbox',
  decision: { aml_screenings: [clean] },
  ...over,
});

describe('what the anchor concludes from a delivery', () => {
  it('accepts an approved customer whose screening ran and found nothing', () => {
    expect(readDiditDecision(payload())).toEqual({
      status: 'ACCEPTED',
      screened: true,
      environment: 'sandbox',
      providerRef: 'sess-1',
      customerRef: 'GABC',
    });
  });

  it('does not call a customer screened when the workflow carried no screening at all', () => {
    const res = readDiditDecision(payload({ decision: { aml_screenings: [] } }));
    expect(res.status).toBe('ACCEPTED');
    expect(res.screened).toBe(false);
  });

  it('does not call a customer screened when the decision has no screening key', () => {
    expect(readDiditDecision(payload({ decision: {} })).screened).toBe(false);
  });

  it('does not call a customer screened when the screening could not be performed', () => {
    expect(readDiditDecision(payload({ decision: { aml_screenings: [unperformed] } })).screened).toBe(false);
  });

  it('does not call a customer screened when any one of several screenings found a hit', () => {
    const res = readDiditDecision(payload({ decision: { aml_screenings: [clean, hit] } }));
    expect(res.screened).toBe(false);
  });

  it('refuses an identity the screening found on a list', () => {
    const res = readDiditDecision(payload({ status: 'Declined', decision: { aml_screenings: [hit] } }));
    expect(res.status).toBe('REJECTED');
    expect(res.screened).toBe(false);
  });

  it('lets a customer try again when only the document failed', () => {
    const res = readDiditDecision(
      payload({ status: 'Declined', decision: { aml_screenings: [clean], id_verifications: [{ status: 'Declined' }] } }),
    );
    expect(res.status).toBe('NEEDS_INFO');
  });

  it('refuses rather than invites a retry when a refusal cannot be explained', () => {
    expect(readDiditDecision(payload({ status: 'Declined', decision: {} })).status).toBe('REJECTED');
  });

  it.each([
    ['In Review', 'PROCESSING'],
    ['Not Started', 'PROCESSING'],
    ['In Progress', 'PROCESSING'],
    ['Awaiting User', 'NEEDS_INFO'],
    ['Resubmitted', 'NEEDS_INFO'],
    ['Abandoned', 'NEEDS_INFO'],
    ['Expired', 'NEEDS_INFO'],
    ['Kyc Expired', 'NEEDS_INFO'],
  ])('maps %s to %s', (status, expected) => {
    expect(readDiditDecision(payload({ status })).status).toBe(expected);
  });

  it.each(['approved', 'APPROVED', 'Somethingelse', ''])(
    'refuses to guess at the unrecognised status %s, and says it did not understand',
    (status) => {
      const res = readDiditDecision(payload({ status }));
      expect(res.status).toBe('PROCESSING');
      expect(res.unrecognisedStatus).toBe(status);
    },
  );

  it('carries the environment through, because a mocked approval must never look real', () => {
    expect(readDiditDecision(payload({ environment: 'live' })).environment).toBe('live');
    expect(readDiditDecision(payload({ environment: undefined })).environment).toBeUndefined();
  });

  it('never reports a customer reference the delivery did not carry', () => {
    expect(readDiditDecision(payload({ vendor_data: undefined })).customerRef).toBeUndefined();
  });
});
