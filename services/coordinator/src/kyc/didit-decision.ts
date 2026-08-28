import { KycStatus } from '../generated/prisma/client';

const PROCESSING_STATUSES = ['Not Started', 'In Progress', 'In Review'];
const RETRYABLE_STATUSES = ['Awaiting User', 'Resubmitted', 'Abandoned', 'Expired', 'Kyc Expired'];

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

const CLEARED_SCREENING = 'Approved';
const NOT_PERFORMED = 'COULD_NOT_PERFORM_AML_SCREENING';
const PASSED_DOCUMENT = 'Approved';

function emptyOrAbsent(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function cleared(entry: any): boolean {
  if (entry?.status !== CLEARED_SCREENING) return false;
  if (typeof entry.total_hits !== 'number' || entry.total_hits !== 0) return false;
  if (!emptyOrAbsent(entry.hits)) return false;
  if (!emptyOrAbsent(entry.warnings)) return false;
  return true;
}

function ranAndFoundNothing(payload: any): boolean {
  const list = screenings(payload);
  if (list.length === 0) return false;
  return list.every(cleared);
}

function adverse(entry: any): boolean {
  if (cleared(entry)) return false;
  if (entry?.warnings && !emptyOrAbsent(entry.warnings)) {
    const list = Array.isArray(entry.warnings) ? entry.warnings : [entry.warnings];
    if (
      list.every((w: unknown) => w === NOT_PERFORMED) &&
      entry.total_hits === 0 &&
      emptyOrAbsent(entry.hits)
    ) {
      return false;
    }
  }
  return true;
}

function foundSomething(payload: any): boolean {
  return screenings(payload).some(adverse);
}

function couldNotScreen(payload: any): boolean {
  return screenings(payload).some((s) => {
    const list = Array.isArray(s?.warnings) ? s.warnings : [];
    return list.includes(NOT_PERFORMED);
  });
}

function documentFailed(payload: any): boolean {
  const list = payload?.decision?.id_verifications;
  return Array.isArray(list) && list.some((d) => d?.status !== PASSED_DOCUMENT);
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
    if (couldNotScreen(payload)) {
      return {
        ...base,
        status: 'REJECTED',
        rejectionReason: 'the required screening could not be carried out',
      };
    }
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
