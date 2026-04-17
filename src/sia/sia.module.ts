import { Module } from '@nestjs/common';
import { SiaController } from './sia.controller';
import { SiaService } from './sia.service';

@Module({
  controllers: [SiaController],
  providers: [SiaService],
})
export class SiaModule {}
