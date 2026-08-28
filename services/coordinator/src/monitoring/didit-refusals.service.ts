import { Injectable } from '@nestjs/common';

@Injectable()
export class DiditRefusalsService {
  private count = 0;
  private lastReason?: string;

  record(reason: string): void {
    this.count += 1;
    this.lastReason = reason;
  }

  applied(): void {
    this.count = 0;
    this.lastReason = undefined;
  }

  state(): { count: number; lastReason?: string } {
    return { count: this.count, lastReason: this.lastReason };
  }
}
