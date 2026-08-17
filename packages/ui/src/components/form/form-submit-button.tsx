import { Loader2 } from 'lucide-react';
import { Button, type ButtonProps } from '../button';

interface FormSubmitButtonProps extends Omit<ButtonProps, 'type'> {
  pending?: boolean;
}

function FormSubmitButton({ pending = false, disabled, children, ...buttonProps }: FormSubmitButtonProps) {
  return (
    <Button type="submit" disabled={pending || disabled} {...buttonProps}>
      {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {children}
    </Button>
  );
}

export { FormSubmitButton, type FormSubmitButtonProps };
