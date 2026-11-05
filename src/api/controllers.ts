import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthedRequest, Public, Roles } from '../common/auth/guards';
import { Principal } from '../common/auth/principal';
import { GRAPH, ServiceGraph } from '../composition';
import { AuthzError } from '../domain/errors';
import { requirePurpose } from './access';

@Controller()
export class HealthController {
  constructor(@Inject(GRAPH) private readonly graph: ServiceGraph) {}

  @Public()
  @Get('health')
  health(): Record<string, string> {
    return {
      status: 'ok',
      fhir: this.graph.config.fhirBackend,
      analytics: this.graph.config.analyticsBackend,
      risk: this.graph.config.riskBackend,
    };
  }
}

@Controller('fhir/r4')
export class FhirController {
  constructor(@Inject(GRAPH) private readonly graph: ServiceGraph) {}

  @Public()
  @Get('metadata')
  metadata(): Record<string, unknown> {
    return this.graph.fhirRead.capability();
  }

  @Get(':type')
  search(
    @Req() req: Request,
    @Param('type') type: string,
    @Query() query: Record<string, string>,
    @Headers('x-purpose-of-use') purpose?: string,
  ): Promise<Record<string, unknown>> {
    return this.graph.fhirRead.search(principal(req), purpose, type, query);
  }

  @Get(':type/:id')
  read(
    @Req() req: Request,
    @Param('type') type: string,
    @Param('id') id: string,
    @Headers('x-purpose-of-use') purpose?: string,
  ): Promise<unknown> {
    return this.graph.fhirRead.read(principal(req), purpose, type, id);
  }
}

@Controller('api/v1')
export class ClinicalController {
  constructor(@Inject(GRAPH) private readonly graph: ServiceGraph) {}

  @Get('patients/:id/summary')
  @Roles('clinician', 'patient')
  summary(
    @Req() req: Request,
    @Param('id') id: string,
    @Headers('x-purpose-of-use') purpose?: string,
  ): Promise<Record<string, unknown>> {
    return this.graph.clinical.summary(principal(req), purpose, id);
  }

  @Post('wounds/:id/assessments')
  @Roles('clinician')
  assess(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-purpose-of-use') purpose?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<{ assessmentId: string }> {
    return this.graph.clinical.recordAssessment(principal(req), purpose, id, body, idempotencyKey);
  }

  @Get('tasks')
  @Roles('clinician', 'patient')
  tasks(
    @Req() req: Request,
    @Query('facilityId') facilityId: string | undefined,
    @Headers('x-purpose-of-use') purpose?: string,
  ): Promise<{ tasks: unknown[] }> {
    return this.graph.clinical.listTasks(principal(req), purpose, facilityId);
  }

  @Post('tasks/:id/complete')
  @Roles('clinician')
  complete(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { completedAt?: string },
    @Headers('x-purpose-of-use') purpose?: string,
  ): Promise<unknown> {
    return this.graph.clinical.completeTask(principal(req), purpose, id, body?.completedAt);
  }

  @Get('patients/:patientId/wounds/:woundId/risk')
  @Roles('clinician', 'patient')
  risk(
    @Req() req: Request,
    @Param('patientId') patientId: string,
    @Param('woundId') woundId: string,
    @Headers('x-purpose-of-use') purpose?: string,
  ): Promise<Record<string, unknown>> {
    return this.graph.clinical.risk(principal(req), purpose, patientId, woundId);
  }

  @Get('metrics')
  @Roles('analyst')
  metrics(@Req() req: Request, @Headers('x-purpose-of-use') purpose?: string): unknown {
    requirePurpose(principal(req), purpose);
    return { metrics: this.graph.analytics.listMetrics() };
  }

  @Post('analytics/query')
  @HttpCode(200)
  @Roles('analyst')
  query(
    @Req() req: Request,
    @Body() body: {
      metric?: string;
      search?: string;
      dimensions?: string[];
      filters?: Record<string, string | string[]>;
      timeRange?: { start: string; end: string };
    },
    @Headers('x-purpose-of-use') purpose?: string,
  ): Promise<unknown> {
    const actor = principal(req);
    requirePurpose(actor, purpose);
    if (!actor.scopes.includes('user/Analytics.query')) {
      throw new AuthzError('missing scope user/Analytics.query');
    }
    return this.graph.analytics.query(
      { tenantId: actor.tenantId, facilityIds: actor.role === 'analyst' ? undefined : actor.facilityIds },
      body ?? {},
    );
  }

  @Get('audit')
  @Roles('auditor')
  async audit(@Req() req: Request, @Headers('x-purpose-of-use') purpose?: string): Promise<{ records: unknown[] }> {
    const actor = principal(req);
    requirePurpose(actor, purpose);
    const records = await this.graph.audit.list(actor.tenantId);
    return { records };
  }
}

function principal(req: Request): Principal {
  return (req as AuthedRequest).principal;
}
