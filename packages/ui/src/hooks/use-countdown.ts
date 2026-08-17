import { useEffect, useState } from 'react';

function formatTimeLeft(difference: number): string {
  if (difference <= 0) return '0s';

  const days = Math.floor(difference / (1000 * 60 * 60 * 24));
  const hours = Math.floor((difference % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((difference % (1000 * 60)) / 1000);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

export function useCountdown(endTime: Date) {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    const calculate = () => formatTimeLeft(endTime.getTime() - Date.now());

    setTimeLeft(calculate());

    const timer = setInterval(() => {
      const newTimeLeft = calculate();
      setTimeLeft(newTimeLeft);

      if (newTimeLeft === '0s') {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [endTime]);

  return { timeLeft };
}
