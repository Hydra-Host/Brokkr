import type { Deployment } from '@repo/api-client';
import {
  DiagnosticDataView,
  DiagnosticStatusIcon,
  deriveDiagnosticStatus,
  extractDiagnosticErrors,
} from '@repo/domain-ui/components/diagnostic-data-view';
import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/components/tabs';
import { AlertTriangle, CheckCircle } from 'lucide-react';

type DiagnosticEntry = Deployment['deviceDiagnostics'][number];

export function DeviceDiagnosticsCard({ diagnostics }: { diagnostics: DiagnosticEntry[] }) {
  // "Latest first" relies on the API's ordering — no client-side sort.
  const grouped = new Map<string, DiagnosticEntry[]>();
  for (const d of diagnostics) {
    const list = grouped.get(d.type) ?? [];
    list.push(d);
    grouped.set(d.type, list);
  }
  const groupedEntries = [...grouped.entries()];
  const defaultTab = groupedEntries[0]?.[0] ?? '';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Device Diagnostics</CardTitle>
        <CardDescription>Hardware and system diagnostics collected from this deployment</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue={defaultTab}>
          <TabsList className="mb-4 flex-wrap">
            {groupedEntries.map(([type, entries]) => {
              const latest = entries[0];
              if (!latest) return null;
              const status = deriveDiagnosticStatus(latest.data);
              return (
                <TabsTrigger key={type} value={type} className="flex items-center gap-1.5">
                  <DiagnosticStatusIcon status={status} />
                  {type}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {groupedEntries.map(([type, entries]) => {
            const latest = entries[0];
            if (!latest) return null;
            const previous = entries.slice(1);
            const data = latest.data;
            const errors = extractDiagnosticErrors(data);
            const status = deriveDiagnosticStatus(data);
            return (
              <TabsContent key={type} value={type} className="space-y-3">
                <div className="flex items-center justify-between">
                  <Badge variant="outline">{type}</Badge>
                  <span className="text-muted-foreground text-xs">{new Date(latest.createdAt).toLocaleString()}</span>
                </div>

                {errors.length > 0 && (
                  <div className="space-y-2">
                    {errors.map((err, index) => (
                      <div
                        key={`${err}-${index}`}
                        className="flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/5 p-2.5"
                      >
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                        <span className="text-sm">{err}</span>
                      </div>
                    ))}
                  </div>
                )}

                {status === 'pass' && (
                  <div className="flex items-center gap-2 rounded-md border border-green-500/20 bg-green-500/5 p-2.5">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    <span className="text-sm">No issues detected</span>
                  </div>
                )}

                <DiagnosticDataView data={data} />

                <details className="group">
                  <summary className="text-muted-foreground cursor-pointer text-xs hover:underline">Raw JSON</summary>
                  <pre className="bg-muted mt-2 max-h-64 overflow-auto rounded-md p-3 text-xs">
                    {JSON.stringify(data, null, 2)}
                  </pre>
                </details>

                {previous.length > 0 && (
                  <details className="group">
                    <summary className="text-muted-foreground cursor-pointer text-xs hover:underline">
                      {previous.length} previous {previous.length === 1 ? 'run' : 'runs'}
                    </summary>
                    <div className="mt-2 space-y-4">
                      {previous.map((prev) => {
                        const prevData = prev.data;
                        const prevErrors = extractDiagnosticErrors(prevData);
                        return (
                          <div key={prev.id} className="border-muted space-y-2 rounded-md border p-3">
                            <div className="flex items-center justify-between">
                              <span className="text-muted-foreground text-xs">
                                {new Date(prev.createdAt).toLocaleString()}
                              </span>
                              {prevErrors.length > 0 ? (
                                <span className="text-xs text-red-500">{prevErrors.length} issues</span>
                              ) : (
                                <span className="text-xs text-green-500">No issues</span>
                              )}
                            </div>
                            <DiagnosticDataView data={prevData} />
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      </CardContent>
    </Card>
  );
}
