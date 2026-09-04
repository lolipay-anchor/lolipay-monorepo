import { Injectable } from '@nestjs/common';

@Injectable()
export class DiditRefusalsService {
  private count = 0;
  private lastReason?: string;
  private providerFailures = 0;
  private providerReason?: string;
  private unauthenticated = 0;
  private unauthenticatedReason?: string;
  private overBudget = 0;
  private budgetReason?: string;

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

  budgetExhausted(reason: string): void {
    this.overBudget += 1;
    this.budgetReason = reason;
  }

  providerFailed(reason: string): void {
    this.providerFailures += 1;
    this.providerReason = reason;
  }

  providerAnswered(): void {
    if (this.providerFailures > 0) this.providerFailures -= 1;
    if (this.providerFailures === 0) this.providerReason = undefined;
  }

  spendResumed(): void {
    this.overBudget = 0;
    this.budgetReason = undefined;
  }

  seen(): void {
    if (this.unauthenticated > 0) this.unauthenticated -= 1;
    if (this.unauthenticated === 0) this.unauthenticatedReason = undefined;
  }

  state(): {
    count: number;
    lastReason?: string;
    providerFailures: number;
    providerReason?: string;
    unauthenticated: number;
    unauthenticatedReason?: string;
    overBudget: number;
    budgetReason?: string;
  } {
    return {
      count: this.count,
      lastReason: this.lastReason,
      providerFailures: this.providerFailures,
      providerReason: this.providerReason,
      unauthenticated: this.unauthenticated,
      unauthenticatedReason: this.unauthenticatedReason,
      overBudget: this.overBudget,
      budgetReason: this.budgetReason,
    };
  }
}
