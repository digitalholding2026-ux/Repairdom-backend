import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CollaborationController } from './collaboration.controller.js';
import { CollaborationService } from './collaboration.service.js';

@Module({
  imports: [AuthModule],
  controllers: [CollaborationController],
  providers: [CollaborationService],
})
export class CollaborationModule {}