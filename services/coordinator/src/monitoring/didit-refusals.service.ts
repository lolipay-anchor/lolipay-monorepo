import { Injectable } from '@nestjs/common';

@Injectable()
export class DiditRefusalsService {
  private count = 0;
  private lastReason?: string;
  private providerFailures = 0;
  private providerReason?: string;
  private unauthenticated = 0;
  private unauthenticatedReason?: string;

  record(reason: string): void {
    this.count += 1;
    this.lastReason = reason;
  }

  applied(): void {
    this.count = 0;
    this.lastReason = undefined;
  }

  couldNotAuthenticate(reason: string): void {
    this.unauthenticated += 1;
    this.unauthenticatedReason = reason;
  }

  providerFailed(reason: string): void {
    this.providerFailures += 1;
    this.providerReason = reason;
  }

  providerAnswered(): void {
    this.providerFailures = 0;
    this.providerReason = undefined;
  }

  state(): {
    count: number;
    lastReason?: string;
    providerFailures: number;
    providerReason?: string;
    unauthenticated: number;
    unauthenticatedReason?: string;
  } {
    return {
      count: this.count,
      lastReason: this.lastReason,
      providerFailures: this.providerFailures,
      providerReason: this.providerReason,
      unauthenticated: this.unauthenticated,
      unauthenticatedReason: this.unauthenticatedReason,
    };
  }
}
