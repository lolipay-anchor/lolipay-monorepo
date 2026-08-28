import { KycStatus } from '../generated/prisma/client';

const PROCESSING_STATUSES = ['Not Started', 'In Progress', 'In Review'];
const RETRYABLE_STATUSES = ['Awaiting User', 'Resubmitted', 'Abandoned', 'Expired', 'Kyc Expired'];
const NOT_PERFORMED = 'COULD_NOT_PERFORM_AML_SCREENING';

export interface DiditConclusion {
  status: KycStatus;
  screened: boolean;
  environment?: string;
  providerRef?: string;
  customerRef?: string;
  rejectionReason?: string;
  unrecognisedStatus?: string;
}

function screenings(payload: any): any[] {
  const list = payload?.decision?.aml_screenings;
  return Array.isArray(list) ? list : [];
}

function ranAndFoundNothing(payload: any): boolean {
  const list = screenings(payload);
  if (list.length === 0) return false;
  return list.every(
    (s) =>
      Number(s?.total_hits ?? 0) === 0 &&
      !(Array.isArray(s?.warnings) ? s.warnings : []).includes(NOT_PERFORMED),
  );
}

function foundSomething(payload: any): boolean {
  return screenings(payload).some((s) => Number(s?.total_hits ?? 0) > 0);
}

function documentFailed(payload: any): boolean {
  const list = payload?.decision?.id_verifications;
  return Array.isArray(list) && list.some((d) => d?.status === 'Declined');
}

export function readDiditDecision(payload: any): DiditConclusion {
  const base = {
    screened: false,
    environment: payload?.environment,
    providerRef: payload?.session_id,
    customerRef: payload?.vendor_data,
  };
  const status: unknown = payload?.status;

  if (status === 'Approved') {
    return { ...base, status: 'ACCEPTED', screened: ranAndFoundNothing(payload) };
  }

  if (status === 'Declined') {
    if (foundSomething(payload)) {
      return { ...base, status: 'REJECTED', rejectionReason: 'sanctions or watchlist match' };
    }
    if (documentFailed(payload)) return { ...base, status: 'NEEDS_INFO' };
    return { ...base, status: 'REJECTED', rejectionReason: 'the refusal carried no readable cause' };
  }

  if (typeof status === 'string' && PROCESSING_STATUSES.includes(status)) {
    return { ...base, status: 'PROCESSING' };
  }
  if (typeof status === 'string' && RETRYABLE_STATUSES.includes(status)) {
    return { ...base, status: 'NEEDS_INFO' };
  }
  return { ...base, status: 'PROCESSING', unrecognisedStatus: String(status ?? '') };
}
