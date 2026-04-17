import { Module } from '@nestjs/common';
import { StorjController } from './storj.controller';
import { StorjService } from './storj.service';

@Module({
  controllers: [StorjController],
  providers: [StorjService],
})
export class StorjModule {}
