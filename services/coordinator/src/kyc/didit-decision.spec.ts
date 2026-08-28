import { readDiditDecision } from './didit-decision';

const clean = { status: 'Approved', total_hits: 0, hits: [], warnings: [] };
const hit = { status: 'Declined', total_hits: 2, hits: [{ sanction_matches: [{}] }], warnings: [] };
const belowThreshold = { status: 'Approved', total_hits: 3, hits: [{}], warnings: [] };
const inReview = { status: 'In Review', total_hits: 1, hits: [{}], warnings: [] };
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

  it('does not call a customer screened when the screening carried hits, however the vendor weighed them', () => {
    const res = readDiditDecision(payload({ decision: { aml_screenings: [belowThreshold] } }));
    expect(res.status).toBe('ACCEPTED');
    expect(res.screened).toBe(false);
  });

  it.each([
    ['an entry with nothing in it at all', {}],
    ['a hit count that is not a number', { status: 'Approved', total_hits: '0', hits: [], warnings: [] }],
    ['a hit count that is absent', { status: 'Approved', hits: [], warnings: [] }],
    ['warnings in a shape the anchor cannot read', { status: 'Approved', total_hits: 0, hits: [], warnings: 'none' }],
    ['warnings carrying anything at all', { status: 'Approved', total_hits: 0, hits: [], warnings: [{ code: 'X' }] }],
    ['hits present despite a zero count', { status: 'Approved', total_hits: 0, hits: [{}], warnings: [] }],
  ])('refuses to read %s as a clean screening', (_n, entry) => {
    expect(readDiditDecision(payload({ decision: { aml_screenings: [entry] } })).screened).toBe(false);
  });

  it('does not call a customer screened while a screening is still under review', () => {
    expect(readDiditDecision(payload({ decision: { aml_screenings: [inReview] } })).screened).toBe(false);
  });

  it('does not treat an unrecognised screening verdict as cleared', () => {
    const odd = { status: 'Something', total_hits: 0, hits: [], warnings: [] };
    expect(readDiditDecision(payload({ decision: { aml_screenings: [odd] } })).screened).toBe(false);
  });

  it('does not let a document problem rescue a screening the anchor could not read as clean', () => {
    const res = readDiditDecision(
      payload({ status: 'Declined', decision: { aml_screenings: [belowThreshold], id_verifications: [{ status: 'Expired' }] } }),
    );
    expect(res.status).toBe('REJECTED');
  });

  it.each([['Expired'], ['Not Finished'], ['In Review']])(
    'lets a customer try again when the document outcome was %s rather than a refusal',
    (docStatus) => {
      const res = readDiditDecision(
        payload({ status: 'Declined', decision: { aml_screenings: [clean], id_verifications: [{ status: docStatus }] } }),
      );
      expect(res.status).toBe('NEEDS_INFO');
    },
  );

  it.each([
    ['a screening still under review while the document also failed', inReview, 'Declined'],
    ['a screening the vendor approved over hits, while the document failed', belowThreshold, 'Declined'],
    ['a screening still under review and a document merely expired', inReview, 'Expired'],
  ])('lets an adverse finding dominate: %s', (_n, screening, docStatus) => {
    const res = readDiditDecision(
      payload({ status: 'Declined', decision: { aml_screenings: [screening], id_verifications: [{ status: docStatus }] } }),
    );
    expect(res.status).toBe('REJECTED');
  });

  it('does not tell a customer they matched a watchlist when the screening merely could not run', () => {
    const unperformedEntry = { status: 'Declined', total_hits: 0, hits: [], warnings: ['COULD_NOT_PERFORM_AML_SCREENING'] };
    const res = readDiditDecision(payload({ status: 'Declined', decision: { aml_screenings: [unperformedEntry] } }));
    expect(res.status).toBe('REJECTED');
    expect(res.rejectionReason).not.toContain('watchlist');
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
