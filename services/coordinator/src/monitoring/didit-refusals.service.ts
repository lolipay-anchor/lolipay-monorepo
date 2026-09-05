import { Injectable } from '@nestjs/common';

@Injectable()
export class DiditRefusalsService {
  private count = 0;
  private lastReason?: string;
  private outOfSession = 0;
  private outOfSessionReason?: string;
  private providerFailures = 0;
  private providerReason?: string;
  private unauthenticated = 0;
  private unauthenticatedReason?: string;
  private overBudget = 0;
  private budgetReason?: string;
  private performsAml?: boolean;

  record(reason: string): void {
    this.count += 1;
    this.lastReason = reason;
  }

  applied(): void {
    this.count = 0;
    this.lastReason = undefined;
  }

  droppedOutOfSession(reason: string): void {
    this.outOfSession += 1;
    this.outOfSessionReason = reason;
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
    if (this.outOfSession > 0) this.outOfSession -= 1;
    if (this.outOfSession === 0) this.outOfSessionReason = undefined;
  }

  workflowPerformsAml(performs: boolean | undefined): void {
    this.performsAml = performs;
  }

  state(): {
    count: number;
    lastReason?: string;
    outOfSession: number;
    outOfSessionReason?: string;
    providerFailures: number;
    providerReason?: string;
    unauthenticated: number;
    unauthenticatedReason?: string;
    overBudget: number;
    budgetReason?: string;
    performsAml?: boolean;
  } {
    return {
      count: this.count,
      lastReason: this.lastReason,
      outOfSession: this.outOfSession,
      outOfSessionReason: this.outOfSessionReason,
      providerFailures: this.providerFailures,
      providerReason: this.providerReason,
      unauthenticated: this.unauthenticated,
      unauthenticatedReason: this.unauthenticatedReason,
      overBudget: this.overBudget,
      budgetReason: this.budgetReason,
      performsAml: this.performsAml,
    };
  }
}
