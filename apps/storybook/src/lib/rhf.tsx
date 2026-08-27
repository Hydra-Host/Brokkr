import React from 'react';
import { useForm, type DefaultValues, type FieldValues, type Resolver, type UseFormReturn } from 'react-hook-form';

// Shared harness for the @repo/ui/form/* stories. Every form component takes
// an explicit `control` from useForm (no FormProvider involved), so a render
// prop handing out the whole form object covers control, setValue, watch, etc.
export function StoryForm<T extends FieldValues>({
  defaultValues,
  resolver,
  children,
  className = 'w-[28rem] space-y-6',
}: {
  defaultValues: DefaultValues<T>;
  resolver?: Resolver<T>;
  children: (form: UseFormReturn<T>) => React.ReactNode;
  className?: string;
}) {
  const form = useForm<T>({ defaultValues, resolver, mode: 'onChange' });
  return (
    <form className={className} onSubmit={form.handleSubmit((values) => console.log('story form submitted', values))}>
      {children(form)}
    </form>
  );
}
