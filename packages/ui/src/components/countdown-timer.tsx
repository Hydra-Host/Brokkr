import { useCountdown } from '../hooks/use-countdown';

export function CountdownTimer({ endTime, title, subtext }: { endTime: Date; title: string; subtext: string }) {
  const { timeLeft } = useCountdown(endTime);

  return (
    <div className="flex flex-col items-start justify-between gap-x-8 gap-y-4 rounded-xl bg-red-500/10 px-4 py-4 sm:flex-row sm:items-center sm:px-6 lg:px-8">
      <div className="flex flex-col items-start">
        <h1 className="text-base leading-7 font-bold">{title}</h1>
        <p className="text-muted-foreground text-sm">{subtext}</p>
        <div className="mt-2 text-4xl leading-none font-bold">{timeLeft}</div>
      </div>
    </div>
  );
}
