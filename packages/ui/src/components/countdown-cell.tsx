import { Clock } from 'lucide-react';
import { useCountdown } from '../hooks/use-countdown';

export function CountdownCell({ endTime }: { endTime: string }) {
  const { timeLeft } = useCountdown(new Date(endTime));
  return (
    <div className="flex items-center gap-1">
      <Clock className="h-3 w-3" />
      <span className="font-mono text-sm">{timeLeft}</span>
    </div>
  );
}
