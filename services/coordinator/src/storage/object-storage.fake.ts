import { NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';

export class FakeObjectStorage {
  private readonly store = new Map<string, { buffer: Buffer; contentType: string }>();

  readonly removedKeys: string[] = [];

  readonly putKeys: string[] = [];

  async ensureBucket(): Promise<void> {
  }

  async putObject(key: string, buffer: Buffer, contentType: string): Promise<void> {
    this.store.set(key, { buffer: Buffer.from(buffer), contentType });
    this.putKeys.push(key);
  }

  async getObjectStream(key: string): Promise<Readable> {
    const entry = this.store.get(key);
    if (!entry) throw new NotFoundException('object not found');
    return Readable.from(entry.buffer);
  }

  async statObject(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async removeObject(key: string): Promise<void> {
    this.store.delete(key);
    this.removedKeys.push(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  contentOf(key: string): Buffer | undefined {
    return this.store.get(key)?.buffer;
  }

  contentTypeOf(key: string): string | undefined {
    return this.store.get(key)?.contentType;
  }

  keysWithPrefix(prefix: string): string[] {
    return Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
  }

  size(): number {
    return this.store.size;
  }
}
