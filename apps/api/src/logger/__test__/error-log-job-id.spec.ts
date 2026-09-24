import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const BRIDGE_ROOT = join(__dirname, '..', '..', 'brokkr-bridge');

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function isLoggerErrorCall(node: ts.Node, file: ts.SourceFile): node is ts.CallExpression {
  return ts.isCallExpression(node) && /\blogger\s*\.\s*error$/.test(node.expression.getText(file));
}

function isBareValue(arg: ts.Expression): boolean {
  if (ts.isIdentifier(arg)) return arg.text !== 'undefined';
  return ts.isPropertyAccessExpression(arg) && !/^(stack|trace)$/i.test(arg.name.text);
}

function idShapedTraceArgs(source: string): number[] {
  const file = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (isLoggerErrorCall(node, file)) {
      const trace = node.arguments[1];
      if (trace !== undefined && isBareValue(trace)) {
        lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

describe('logger.error call sites under brokkr-bridge', () => {
  it('flags a bare value passed as the trace argument, whatever it is named', () => {
    const singleLine = 'this.logger.error(`job ${jobId} failed`, jobId);';
    const otherName = 'this.logger.error(`job failed`, correlationRef);';
    const multiLine = [
      'this.logger.error(',
      '  `step failed: ${data.error?.message ?? "unknown"}`,',
      '  data.plan_id,',
      ');',
    ].join('\n');
    expect(idShapedTraceArgs(singleLine)).toEqual([1]);
    expect(idShapedTraceArgs(otherName)).toEqual([1]);
    expect(idShapedTraceArgs(multiLine)).toEqual([1]);
  });

  it('accepts undefined, a stack, a string or a call as the trace argument', () => {
    const source = [
      'this.logger.error(`a`, undefined, jobId);',
      'this.logger.error(`b`, error.stack, jobId);',
      'this.logger.error(`c`, `trace ${x}`, jobId);',
      'this.logger.error(`d`, getErrorMessage(error), jobId);',
    ].join('\n');
    expect(idShapedTraceArgs(source)).toEqual([]);
  });

  it('accepts an id passed as the third argument', () => {
    const source = ['this.logger.error(', '  `step failed for ${planId}`,', '  undefined,', '  planId,', ');'].join(
      '\n',
    );
    expect(idShapedTraceArgs(source)).toEqual([]);
  });

  it('never passes the job id where the trace goes', () => {
    const offenders = listTsFiles(BRIDGE_ROOT).flatMap((file) =>
      idShapedTraceArgs(readFileSync(file, 'utf8')).map((line) => `${relative(BRIDGE_ROOT, file)}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
