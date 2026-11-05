import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AllExceptionsFilter } from './api/exception-filter';
import { AppModule } from './app.module';
import { GRAPH, ServiceGraph } from './composition';

loadDotenv();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.enableCors();
  app.useGlobalFilters(new AllExceptionsFilter());
  const graph = app.get<ServiceGraph>(GRAPH);
  app.use((req: { method: string; originalUrl?: string; url: string }, res: { statusCode: number; on: (event: string, cb: () => void) => void }, next: () => void) => {
    const started = Date.now();
    res.on('finish', () => {
      const pathOnly = (req.originalUrl ?? req.url).split('?')[0];
      graph.logger.info('http', {
        method: req.method,
        path: pathOnly,
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
    });
    next();
  });
  await app.listen(graph.config.port);
  graph.logger.info('listen', {
    port: graph.config.port,
    fhir: graph.config.fhirBackend,
    analytics: graph.config.analyticsBackend,
    risk: graph.config.riskBackend,
  });
}

void bootstrap();
