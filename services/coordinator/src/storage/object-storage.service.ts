import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Client } from 'minio';
import type { Readable } from 'stream';
import { AppConfigService } from '../config/app-config.service';

@Injectable()
export class ObjectStorageService {
  private readonly logger = new Logger(ObjectStorageService.name);
  private readonly client: Client;
  private readonly bucket: string;

  constructor(cfg: AppConfigService) {
    this.bucket = cfg.minioBucket;
    this.client = new Client({
      endPoint: cfg.minioEndpoint,
      port: cfg.minioPort,
      useSSL: cfg.minioUseSSL,
      accessKey: cfg.minioAccessKey,
      secretKey: cfg.minioSecretKey,
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket);
        this.logger.log(`created MinIO bucket "${this.bucket}"`);
      } else {
        this.logger.log(`MinIO bucket "${this.bucket}" is ready`);
      }
    } catch (err) {
      this.logger.error(`MinIO bucket check/create failed: ${errorMessage(err)}`);
      throw err;
    }
  }

  async putObject(key: string, buffer: Buffer, contentType: string): Promise<void> {
    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': contentType,
    });
  }

  async getObjectStream(key: string): Promise<Readable> {
    try {
      return await this.client.getObject(this.bucket, key);
    } catch (err) {
      if (isNotFound(err)) throw new NotFoundException('object not found');
      throw err;
    }
  }

  async statObject(key: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, key);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async removeObject(key: string): Promise<void> {
    try {
      await this.client.removeObject(this.bucket, key);
    } catch (err) {
      if (isNotFound(err)) return;
      this.logger.warn(`could not remove object "${key}": ${errorMessage(err)}`);
    }
  }
}

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code === 'NoSuchKey' || code === 'NotFound';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
