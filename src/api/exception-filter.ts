import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { DomainError } from '../domain/errors';
import { redactPhi } from '../common/phi/redact';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    const request = host.switchToHttp().getRequest<{ originalUrl?: string; url?: string }>();
    let status = 500;
    let message = 'internal error';
    if (exception instanceof DomainError) {
      status = exception.status;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') message = body;
      else if (body && typeof body === 'object' && 'message' in body) {
        const raw = (body as { message: string | string[] }).message;
        message = Array.isArray(raw) ? raw.join(', ') : raw;
      } else {
        message = exception.message;
      }
    } else if (exception instanceof Error) {
      process.stderr.write(`${JSON.stringify(redactPhi({ event: 'unhandled', name: exception.name }))}\n`);
    }
    const path = request.originalUrl ?? request.url ?? '';
    if (path.startsWith('/fhir/')) {
      response.status(status).type('application/fhir+json').json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: status >= 500 ? 'error' : 'information',
          code: status === 404 ? 'not-found' : status === 401 || status === 403 ? 'security' : 'processing',
          diagnostics: message,
        }],
      });
      return;
    }
    response.status(status).json({ statusCode: status, message });
  }
}
