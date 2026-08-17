import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Heading2, Heading3, Italic, Link2, List, ListOrdered, UnderlineIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { cn } from '../utils';

interface ToolbarButtonProps {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}

function ToolbarButton({ onClick, active, disabled, title, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded p-1.5 transition-colors',
        active ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {children}
    </button>
  );
}

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

function RichTextEditor({ value, onChange, disabled, placeholder, className }: RichTextEditorProps) {
  const lastValueFromEditor = useRef(value || '');

  const editor = useEditor({
    extensions: [StarterKit, Underline, Link.configure({ openOnClick: false })],
    content: value || '',
    editable: !disabled,
    onUpdate: ({ editor: e }) => {
      const html = e.getHTML();
      lastValueFromEditor.current = html;
      onChange(html);
    },
    editorProps: {
      attributes: {
        class: cn(
          'prose prose-sm dark:prose-invert max-w-none min-h-[160px] px-3 py-2 outline-none',
          placeholder && !value && 'before:text-muted-foreground before:content-[attr(data-placeholder)]',
        ),
        ...(placeholder ? { 'data-placeholder': placeholder } : {}),
      },
    },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value !== lastValueFromEditor.current) {
      lastValueFromEditor.current = value;
      editor.commands.setContent(value || '');
    }
  }, [editor, value]);

  const setLink = () => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('URL', previousUrl);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  return (
    <div
      className={cn(
        'border-input rounded-md border bg-transparent',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      {editor && (
        <div className="border-input flex flex-wrap gap-0.5 border-b px-2 py-1.5">
          <ToolbarButton
            title="Bold"
            onClick={() => editor.chain().focus().toggleBold().run()}
            active={editor.isActive('bold')}
            disabled={disabled}
          >
            <Bold className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Italic"
            onClick={() => editor.chain().focus().toggleItalic().run()}
            active={editor.isActive('italic')}
            disabled={disabled}
          >
            <Italic className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Underline"
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            active={editor.isActive('underline')}
            disabled={disabled}
          >
            <UnderlineIcon className="h-4 w-4" />
          </ToolbarButton>
          <div className="bg-border mx-1 my-0.5 w-px" />
          <ToolbarButton
            title="Heading 2"
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            active={editor.isActive('heading', { level: 2 })}
            disabled={disabled}
          >
            <Heading2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Heading 3"
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            active={editor.isActive('heading', { level: 3 })}
            disabled={disabled}
          >
            <Heading3 className="h-4 w-4" />
          </ToolbarButton>
          <div className="bg-border mx-1 my-0.5 w-px" />
          <ToolbarButton
            title="Bullet list"
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            active={editor.isActive('bulletList')}
            disabled={disabled}
          >
            <List className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="Ordered list"
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            active={editor.isActive('orderedList')}
            disabled={disabled}
          >
            <ListOrdered className="h-4 w-4" />
          </ToolbarButton>
          <div className="bg-border mx-1 my-0.5 w-px" />
          <ToolbarButton title="Link" onClick={setLink} active={editor.isActive('link')} disabled={disabled}>
            <Link2 className="h-4 w-4" />
          </ToolbarButton>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

interface FormRichTextEditorProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  description?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

function FormRichTextEditor<T extends FieldValues>({
  control,
  name,
  label,
  description,
  disabled,
  placeholder,
  className,
}: FormRichTextEditorProps<T>) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid} className={className}>
          <FieldLabel>{label}</FieldLabel>
          <RichTextEditor
            value={field.value as string}
            onChange={field.onChange}
            disabled={disabled}
            placeholder={placeholder}
          />
          {description && <FieldDescription>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

export { FormRichTextEditor };
