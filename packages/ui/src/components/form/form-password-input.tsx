import { CheckCircle2, Circle, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import { z } from 'zod';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { Input } from '../input';
import { Tooltip, TooltipArrow, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip';
import { cn } from '../utils';

type PasswordCriteria = {
  typesCount: number;
  hasPasswordLength: boolean;
  hasLowerCase: boolean;
  hasUpperCase: boolean;
  hasNumber: boolean;
  hasSpecialChar: boolean;
};

const specialChars = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

function validatePassword(password = ''): PasswordCriteria {
  const criteria: PasswordCriteria = {
    hasLowerCase: /[a-z]/.test(password),
    hasUpperCase: /[A-Z]/.test(password),
    hasNumber: /[0-9]/.test(password),
    hasSpecialChar: [...password].some((char) => specialChars.has(char)),
    hasPasswordLength: password.length >= 12,
    typesCount: 0,
  };

  criteria.typesCount = (['hasLowerCase', 'hasUpperCase', 'hasNumber', 'hasSpecialChar'] as const)
    .map((key) => criteria[key])
    .filter(Boolean).length;

  return criteria;
}

const zodValidatePasswordComplexity = () =>
  z
    .string()
    .min(1, 'Password is required')
    .refine(
      (password) => {
        const result = validatePassword(password);
        return result.typesCount >= 3 && result.hasPasswordLength;
      },
      { message: 'Password does not meet complexity requirements' },
    );

const PASSWORD_CRITERIA = [
  {
    key: 'hasPasswordLength' as const,
    text: 'Must be at least 12 characters long',
  },
  {
    key: 'typesCount' as const,
    text: (
      <>
        Contain at least <b>3</b> of the following:
      </>
    ),
    subCriteria: [
      { key: 'hasLowerCase' as const, text: 'Lower case letter' },
      { key: 'hasUpperCase' as const, text: 'Upper case letter' },
      { key: 'hasNumber' as const, text: 'Number' },
      { key: 'hasSpecialChar' as const, text: 'Special character' },
    ],
  },
];

function RequirementItem({
  text,
  valid,
  children,
  colorizeText = true,
}: {
  text: React.ReactNode;
  valid: boolean;
  colorizeText?: boolean;
  children?: { text: React.ReactNode; valid: boolean }[];
}) {
  return (
    <li className="flex flex-col gap-1">
      <div
        className={cn(
          'flex items-center gap-1.5 text-xs',
          colorizeText ? (valid ? 'text-status-online' : 'text-status-offline') : 'text-text-primary',
        )}
      >
        {valid ? (
          <CheckCircle2 className="text-status-online h-5 w-5" />
        ) : (
          <Circle className="text-text-muted h-5 w-5" />
        )}
        {text}
      </div>
      {children && (
        <ul className="space-y-1 pl-5">
          {children.map((child, index) => (
            <RequirementItem key={index} colorizeText={false} {...child} />
          ))}
        </ul>
      )}
    </li>
  );
}

function PasswordChecklist({ criteria }: { criteria?: PasswordCriteria }) {
  return (
    <div className="w-80 p-4">
      <ul className="space-y-2">
        {PASSWORD_CRITERIA.map(({ key, text, subCriteria }) => (
          <RequirementItem
            key={key}
            text={text}
            valid={Boolean(key === 'typesCount' ? criteria?.typesCount && criteria.typesCount >= 3 : criteria?.[key])}
          >
            {subCriteria?.map(({ key, text }) => ({
              text,
              valid: Boolean(criteria?.[key]),
            }))}
          </RequirementItem>
        ))}
      </ul>
    </div>
  );
}

interface FormPasswordInputProps<T extends FieldValues>
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name' | 'type'> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  labelRight?: React.ReactNode;
  description?: string;
  showStrengthChecklist?: boolean;
}

function FormPasswordInput<T extends FieldValues>({
  control,
  name,
  label,
  labelRight,
  description,
  showStrengthChecklist = false,
  className,
  ...inputProps
}: FormPasswordInputProps<T>) {
  const [showPassword, setShowPassword] = useState(false);
  const [focused, setFocused] = useState(false);

  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => {
        const passwordValue = typeof field.value === 'string' ? field.value : '';
        const criteria = validatePassword(passwordValue);

        const inputElement = (
          <Field data-invalid={fieldState.invalid} className={className}>
            {labelRight ? (
              <div className="flex items-center">
                <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
                <div className="ml-auto">{labelRight}</div>
              </div>
            ) : (
              <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
            )}
            <div className="relative">
              <Input
                {...field}
                {...inputProps}
                id={field.name}
                type={showPassword ? 'text' : 'password'}
                aria-invalid={fieldState.invalid}
                onFocus={(e) => {
                  setFocused(true);
                  inputProps.onFocus?.(e);
                }}
                onBlur={(e) => {
                  setFocused(false);
                  field.onBlur();
                  inputProps.onBlur?.(e);
                }}
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPassword((prev) => !prev)}
                className="text-text-muted hover:text-text-primary absolute top-1/2 right-3 -translate-y-1/2"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {description && <FieldDescription>{description}</FieldDescription>}
            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        );

        if (!showStrengthChecklist) {
          return inputElement;
        }

        return (
          <TooltipProvider>
            <Tooltip open={focused}>
              <TooltipTrigger asChild>
                <div>{inputElement}</div>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center" className="rounded-sm p-0">
                <TooltipArrow />
                <PasswordChecklist criteria={criteria} />
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      }}
    />
  );
}

export { FormPasswordInput, specialChars, validatePassword, zodValidatePasswordComplexity };
