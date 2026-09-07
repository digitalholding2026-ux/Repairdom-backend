import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './../generated/prisma/client.js';
import { Pool } from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService) {
    const pool = new Pool({ connectionString: config.get<string>('DATABASE_URL') });
    super({ adapter: new PrismaPg(pool) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}