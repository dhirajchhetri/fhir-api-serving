import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ClinicalController, FhirController, HealthController } from './api/controllers';
import { JwtAuthGuard, RolesGuard } from './common/auth/guards';
import { loadConfig } from './config';
import { buildServices, GRAPH } from './composition';

@Module({
  controllers: [HealthController, FhirController, ClinicalController],
  providers: [
    {
      provide: GRAPH,
      useFactory: () => buildServices(loadConfig(process.env)),
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
