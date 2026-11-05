import { redactPhi } from './redact';

export type LogSink = (line: string) => void;

/** Structured logger that redacts known PHI fields before anything is written. */
export class PhiLogger {
  private sink: LogSink;

  constructor(sink?: LogSink) {
    this.sink = sink ?? ((line) => process.stdout.write(`${line}\n`));
  }

  setSink(sink: LogSink): void {
    this.sink = sink;
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.write('info', event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write('error', event, fields);
  }

  private write(level: string, event: string, fields: Record<string, unknown>): void {
    const line = JSON.stringify(redactPhi({ level, event, ...fields }));
    this.sink(line);
  }
}
