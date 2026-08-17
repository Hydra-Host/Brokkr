import type { NetplanPhase } from '@repo/api-client';
import { isRecord, unwrapErrorMessage } from '@repo/utils';
import { Check, Clipboard, TriangleAlert } from 'lucide-react';
import { useCopyToClipboard } from '../hooks/use-copy-to-clipboard';
import { Alert, AlertDescription, AlertTitle } from './alert';
import { Button } from './button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from './card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectWrapper } from './select';
import { Skeleton } from './skeleton';

export interface NetplanViewerProps {
  phase: NetplanPhase;
  yaml?: string;
  isLoading: boolean;
  error?: unknown;
  onPhaseChange: (phase: NetplanPhase) => void;
}

interface ErrorPresentation {
  title: string;
  fallback: string;
  variant: 'destructive' | 'warning';
}

const ERROR_PRESENTATIONS: Record<number, ErrorPresentation> = {
  401: { title: 'Authentication required', fallback: 'Sign in again to view Netplan.', variant: 'destructive' },
  403: { title: 'Permission denied', fallback: 'You do not have access to this device.', variant: 'destructive' },
  404: { title: 'Netplan unavailable', fallback: 'The device or its Netplan data was not found.', variant: 'warning' },
  422: {
    title: 'Unable to render Netplan',
    fallback: 'The device networking data is incomplete or inconsistent.',
    variant: 'warning',
  },
  502: {
    title: 'Netplan service unavailable',
    fallback: 'The upstream renderer could not complete the request.',
    variant: 'warning',
  },
  503: {
    title: 'Netplan proxy not configured',
    fallback: 'The admin Netplan proxy is not configured on this environment.',
    variant: 'warning',
  },
};

function ErrorState({ error }: { error: unknown }) {
  const status = isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
  const presentation = ERROR_PRESENTATIONS[status ?? 0] ?? {
    title: 'Failed to load Netplan',
    fallback: 'The Netplan configuration could not be loaded.',
    variant: 'destructive',
  };

  return (
    <Alert variant={presentation.variant}>
      <TriangleAlert className="h-4 w-4" />
      <AlertTitle>{presentation.title}</AlertTitle>
      <AlertDescription>{unwrapErrorMessage(error, presentation.fallback)}</AlertDescription>
    </Alert>
  );
}

export function NetplanViewer({ phase, yaml, isLoading, error, onPhaseChange }: NetplanViewerProps) {
  const { copy, copied } = useCopyToClipboard();

  const handlePhaseChange = (value: string) => onPhaseChange(value as NetplanPhase);

  return (
    <Card>
      <CardHeader className="grid-cols-[1fr_auto]">
        <CardTitle>Netplan</CardTitle>
        <CardDescription>Rendered network configuration for the selected boot phase.</CardDescription>
        <CardAction className="flex items-end gap-2">
          <SelectWrapper label="Phase" className="w-44">
            <Select value={phase} onValueChange={handlePhaseChange} disabled={isLoading}>
              <SelectTrigger aria-label="Netplan phase">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="live">Live / rescue</SelectItem>
                <SelectItem value="deploy">Deploy / target OS</SelectItem>
              </SelectContent>
            </Select>
          </SelectWrapper>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mb-px"
            disabled={!yaml || isLoading}
            onClick={() => yaml && void copy(yaml)}
          >
            {copied ? <Check className="mr-2 h-4 w-4" /> : <Clipboard className="mr-2 h-4 w-4" />}
            {copied ? 'Copied' : 'Copy YAML'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2" role="status" aria-label="Loading Netplan">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : error ? (
          <ErrorState error={error} />
        ) : yaml ? (
          <pre className="bg-bg-secondary border-border max-h-[70vh] overflow-auto rounded-sm border p-4 text-xs leading-5 whitespace-pre">
            <code>{yaml}</code>
          </pre>
        ) : (
          <ErrorState error={new Error('No Netplan configuration was returned.')} />
        )}
      </CardContent>
    </Card>
  );
}
