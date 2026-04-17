import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { StorjModule } from './storj/storj.module';
import { SiaModule } from './sia/sia.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      serveStaticOptions: {
        setHeaders: (res: { setHeader(name: string, value: string): void }) => {
          res.setHeader('Cache-Control', 'no-store');
        },
      },
    }),
    StorjModule,
    SiaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
