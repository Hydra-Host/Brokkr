import { ASCII_404S } from '@repo/ui/ascii-art';
import { Button } from '@repo/ui/components/button';
import { MatrixReveal } from '@repo/ui/matrix-reveal';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Home } from 'lucide-react';
import { useMemo } from 'react';

const FUNNY_MESSAGES = [
  'Looks like you took a wrong turn in the datacenter.',
  'This page has been deprovisioned.',
  "The GPU cluster you're looking for has gone offline.",
  'Error: Page not found in any availability zone.',
  'This route was not provisioned.',
  'Segfault in navigation. Core dumped.',
];

export function NotFound() {
  const message = useMemo(() => FUNNY_MESSAGES[Math.floor(Math.random() * FUNNY_MESSAGES.length)], []);
  const asciiArt = useMemo(() => ASCII_404S[Math.floor(Math.random() * ASCII_404S.length)], []);
  const lines = useMemo(() => asciiArt.split('\n'), [asciiArt]);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-8 px-4">
        <MatrixReveal
          lines={lines}
          delay={250}
          className="text-[0.7rem] leading-[0.8rem] sm:text-base sm:leading-tight"
        />

        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-text-primary font-mono text-lg font-medium">Page Not Found</h2>
          <p className="text-text-muted max-w-md font-mono text-sm">{message}</p>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => window.history.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Go Back
          </Button>
          <Button size="sm" asChild>
            <Link to="/">
              <Home className="mr-2 h-4 w-4" />
              Home
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
