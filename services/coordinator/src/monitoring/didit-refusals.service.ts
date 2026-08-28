import { Injectable } from '@nestjs/common';

@Injectable()
export class DiditRefusalsService {
  private since = 0;
  private lastReason?: string;

  record(reason: string): void {
    this.since += 1;
    this.lastReason = reason;
  }

  drain(): { count: number; lastReason?: string } {
    const drained = { count: this.since, lastReason: this.lastReason };
    this.since = 0;
    this.lastReason = undefined;
    return drained;
  }
}
