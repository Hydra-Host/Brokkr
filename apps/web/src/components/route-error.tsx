import { useRouter } from '@tanstack/react-router';
import { ArrowLeft, Home, RotateCcw } from 'lucide-react';
import { useMemo } from 'react';

import { ERROR_ASCII } from '@repo/ui/ascii-art';
import { Button } from '@repo/ui/components/button';
import { MatrixReveal } from '@repo/ui/matrix-reveal';

const ERROR_MESSAGES = [
  'A critical fault was detected in the system.',
  'The requested resource could not be loaded.',
  'Something went wrong in the datacenter.',
  'Connection to resource interrupted.',
  'Unexpected failure during data retrieval.',
];

interface RouteErrorProps {
  error: Error;
  reset?: () => void;
}

export function RouteError({ error, reset }: RouteErrorProps) {
  const router = useRouter();
  const message = useMemo(() => ERROR_MESSAGES[Math.floor(Math.random() * ERROR_MESSAGES.length)], []);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="flex flex-col items-center gap-8 px-4">
        <MatrixReveal
          lines={ERROR_ASCII}
          delay={250}
          className="text-[0.7rem] leading-[0.8rem] sm:text-base sm:leading-tight"
        />

        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-text-primary font-mono text-lg font-medium">Something Went Wrong</h2>
          <p className="text-text-muted max-w-md font-mono text-sm">{message}</p>
          {error?.message && <p className="text-muted-foreground mt-1 max-w-md font-mono text-xs">{error.message}</p>}
        </div>

        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => router.history.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Go Back
          </Button>
          {reset ? (
            <Button variant="outline" size="sm" onClick={reset}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Try Again
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => router.invalidate()}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Try Again
            </Button>
          )}
          <Button size="sm" asChild>
            <a href="/">
              <Home className="mr-2 h-4 w-4" />
              Home
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
