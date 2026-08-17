import { useEffect, useState } from 'react';

export function useTypewriter(text: string, speed = 40) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    setCount(0);
  }, [text]);

  useEffect(() => {
    if (count < text.length) {
      const timer = setTimeout(() => setCount((c) => c + 1), speed);
      return () => clearTimeout(timer);
    }
  }, [count, text.length, speed]);

  return {
    displayText: text.slice(0, count),
    remainingText: text.slice(count),
    isTyping: count < text.length,
  };
}
