import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { StorjService, StorjSummaryRange } from './storj.service';
import { StorjSummary } from './storj.types';

const ALLOWED_RANGES: StorjSummaryRange[] = ['1d', '7d', '1m', '3m', '1y', 'all'];

@Controller('api/storj')
export class StorjController {
  constructor(private readonly storjService: StorjService) {}

  @Get()
  async getSummary(@Query('range') range?: string): Promise<StorjSummary> {
    if (range !== undefined) {
      const normalized = range.toLowerCase() as StorjSummaryRange;
      if (!ALLOWED_RANGES.includes(normalized)) {
        throw new BadRequestException('range must be one of 1d, 7d, 1m, 3m, 1y, all');
      }
      return this.storjService.fetchSummary({ range: normalized });
    }
    return this.storjService.fetchSummary();
  }
}
