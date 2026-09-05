import { KycStatus } from '../generated/prisma/client';
import {
  HIT_REFUSAL,
  SCREENING_DID_NOT_RUN,
  SCREENING_REQUIRED_FAILED,
  UNREADABLE_DECLINE,
  UNREADABLE_SCREENING,
} from './screening-requirement';

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

function purelyNotPerformed(entry: any): boolean {
  if (!entry?.warnings || emptyOrAbsent(entry.warnings)) return false;
  const list = Array.isArray(entry.warnings) ? entry.warnings : [entry.warnings];
  return list.every((w: unknown) => w === NOT_PERFORMED) && entry.total_hits === 0 && emptyOrAbsent(entry.hits);
}

function noScreeningDelivered(payload: any): boolean {
  return emptyOrAbsent(payload?.decision?.aml_screenings);
}

function ranAndFoundNothing(payload: any): boolean {
  const list = screenings(payload);
  if (list.length === 0) return false;
  return list.every(cleared);
}

function onlyCouldNotScreen(payload: any): boolean {
  const list = screenings(payload);
  if (list.length === 0) return false;
  return list.every((s) => cleared(s) || purelyNotPerformed(s)) && list.some(purelyNotPerformed);
}

function adverse(entry: any): boolean {
  if (cleared(entry)) return false;
  if (purelyNotPerformed(entry)) return false;
  return true;
}

function hitsPresent(entry: any): boolean {
  if (typeof entry?.total_hits === 'number' && entry.total_hits > 0) return true;
  return Array.isArray(entry?.hits) && entry.hits.length > 0;
}

function foundSomething(payload: any): boolean {
  return screenings(payload).some(adverse);
}

function foundHits(payload: any): boolean {
  return screenings(payload).some(hitsPresent);
}

function documentFailed(payload: any): boolean {
  const list = payload?.decision?.id_verifications;
  return Array.isArray(list) && list.some((d) => d?.status !== PASSED_DOCUMENT);
}

export function readDiditDecision(payload: any, requireAml = true): DiditConclusion {
  const base = {
    screened: false,
    environment: payload?.environment,
    providerRef: payload?.session_id,
    customerRef: payload?.vendor_data,
  };
  const status: unknown = payload?.status;

  if (status === 'Approved') {
    if (foundHits(payload)) {
      return { ...base, status: 'REJECTED', rejectionReason: HIT_REFUSAL };
    }
    if (noScreeningDelivered(payload)) return { ...base, status: 'ACCEPTED' };
    if (ranAndFoundNothing(payload)) return { ...base, status: 'ACCEPTED', screened: true };
    if (onlyCouldNotScreen(payload)) return { ...base, status: 'NEEDS_INFO', rejectionReason: SCREENING_DID_NOT_RUN };
    return { ...base, status: 'NEEDS_INFO', rejectionReason: UNREADABLE_SCREENING };
  }

  if (status === 'Declined') {
    if (foundHits(payload)) {
      return { ...base, status: 'REJECTED', rejectionReason: HIT_REFUSAL };
    }
    if (foundSomething(payload)) {
      return { ...base, status: 'NEEDS_INFO', rejectionReason: UNREADABLE_SCREENING };
    }
    if (documentFailed(payload)) return { ...base, status: 'NEEDS_INFO' };
    if (onlyCouldNotScreen(payload)) {
      return requireAml
        ? { ...base, status: 'REJECTED', rejectionReason: SCREENING_REQUIRED_FAILED }
        : { ...base, status: 'NEEDS_INFO', rejectionReason: SCREENING_DID_NOT_RUN };
    }
    return { ...base, status: 'REJECTED', rejectionReason: UNREADABLE_DECLINE };
  }

  if (typeof status === 'string' && PROCESSING_STATUSES.includes(status)) {
    return { ...base, status: 'PROCESSING' };
  }
  if (typeof status === 'string' && RETRYABLE_STATUSES.includes(status)) {
    return { ...base, status: 'NEEDS_INFO' };
  }
  return { ...base, status: 'PROCESSING', unrecognisedStatus: String(status ?? '') };
}
