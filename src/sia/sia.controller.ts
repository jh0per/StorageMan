import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SiaService } from './sia.service';
import { SiaSummary } from './sia.types';

@Controller('api/sia')
export class SiaController {
  constructor(private readonly siaService: SiaService) {}

  @Get()
  async getSummary(
    @Query('month') month?: string,
    @Query('range') range?: string,
  ): Promise<SiaSummary> {
    if (month !== undefined && range !== undefined) {
      throw new BadRequestException('month and range cannot be used together');
    }
    if (month !== undefined && !/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequestException('month must be in YYYY-MM format');
    }
    if (
      range !== undefined &&
      !['1d', '7d', '1m', '3m', '1y', 'all'].includes(range.toLowerCase())
    ) {
      throw new BadRequestException('range must be one of 1d, 7d, 1m, 3m, 1y, all');
    }

    return this.siaService.fetchSummary(
      month
        ? { month }
        : range
          ? { range: range.toLowerCase() as '1d' | '7d' | '1m' | '3m' | '1y' | 'all' }
          : undefined,
    );
  }

  @Post('announce')
  async announce(@Body() body: { host?: string }): Promise<{ host: string; success: true }> {
    const host = body?.host?.trim();
    if (!host) {
      throw new BadRequestException('host is required');
    }

    return this.siaService.announceHost(host);
  }
}
