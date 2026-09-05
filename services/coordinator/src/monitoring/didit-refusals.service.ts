import { Injectable } from '@nestjs/common';

const OUT_OF_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class DiditRefusalsService {
  private count = 0;
  private lastReason?: string;
  private outOfSessionAt: number[] = [];
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
    this.outOfSessionAt.push(Date.now());
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
  }

  workflowPerformsAml(performs: boolean | undefined): void {
    this.performsAml = performs;
  }

  private outOfSessionInWindow(): number {
    const since = Date.now() - OUT_OF_SESSION_WINDOW_MS;
    this.outOfSessionAt = this.outOfSessionAt.filter((t) => t > since);
    if (this.outOfSessionAt.length === 0) this.outOfSessionReason = undefined;
    return this.outOfSessionAt.length;
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
    const outOfSession = this.outOfSessionInWindow();
    return {
      count: this.count,
      lastReason: this.lastReason,
      outOfSession,
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
