import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

export function schemaFromUrl(url: string): string | undefined {
  const match = url.match(/[?&]schema=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing env DATABASE_URL');
  return url;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = connectionString();
    super({ adapter: new PrismaPg({ connectionString: url }, { schema: schemaFromUrl(url) }) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
