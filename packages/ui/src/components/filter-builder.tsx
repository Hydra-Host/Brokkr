import { ListFilter, Search, X } from 'lucide-react';
import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ActiveFilter, FilterFieldConfig, FilterOperator } from '../hooks/use-filters';
import { OPERATORS_BY_TYPE, OPERATOR_LABELS, OPERATOR_SYMBOLS } from '../hooks/use-filters';
import { cn } from './utils';

interface FilterBuilderProps {
  fields: FilterFieldConfig[];
  activeFilters: ActiveFilter[];
  onAdd: (field: string, operator: FilterOperator, value: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}

type Step = 'closed' | 'field' | 'operator' | 'value';

interface EditState {
  filterId: string;
  field: FilterFieldConfig;
  operator: FilterOperator;
}

interface ListItem {
  key: string;
  label: string;
  detail?: string;
  onSelect: () => void;
}

function SearchDropdown({
  items,
  totalCount,
  placeholder,
  emptyText = 'No matches',
  highlightIndex,
  onHighlight,
  searchValue,
  onSearchChange,
  onKeyDown,
  inputRef,
  showCustomRow,
  customPrefix,
  customValue,
  onCustomSubmit,
}: {
  items: ListItem[];
  totalCount?: number;
  placeholder: string;
  emptyText?: string;
  highlightIndex: number;
  onHighlight: (i: number) => void;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  showCustomRow?: boolean;
  customPrefix?: string;
  customValue?: string;
  onCustomSubmit?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.children[highlightIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex]);

  const isFiltered = totalCount !== undefined && items.length < totalCount;

  return (
    <div className="border-border bg-bg-secondary absolute top-full left-0 z-[9999] mt-1 w-72 overflow-hidden rounded-sm border font-mono shadow-lg">
      <div className="border-border flex items-center border-b px-2.5">
        <Search className="text-text-dim mr-2 h-3 w-3 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          className="placeholder:text-text-dim flex h-9 w-full bg-transparent py-2 font-mono text-xs outline-none"
          placeholder={placeholder}
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {isFiltered && (
          <span className="text-text-dim ml-auto shrink-0 text-[10px] whitespace-nowrap">
            {items.length}/{totalCount}
          </span>
        )}
      </div>

      <div ref={listRef} className="max-h-80 overflow-y-auto p-1">
        {items.map((item, i) => (
          <button
            key={item.key}
            type="button"
            className={cn(
              'flex w-full cursor-pointer items-center justify-between rounded-sm px-2.5 py-1.5 font-mono text-xs outline-none',
              i === highlightIndex ? 'bg-accent/10 text-text-primary' : 'text-text-primary hover:bg-accent/5',
            )}
            onMouseEnter={() => onHighlight(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => item.onSelect()}
          >
            <span>{item.label}</span>
            {item.detail && <span className="text-text-dim ml-2 text-[10px]">{item.detail}</span>}
          </button>
        ))}

        {showCustomRow && (
          <button
            type="button"
            className={cn(
              'border-border mt-1 flex w-full cursor-pointer items-center gap-2 rounded-sm border-t px-2.5 py-1.5 pt-2 font-mono text-xs outline-none',
              highlightIndex === items.length
                ? 'bg-accent/10 text-text-primary'
                : 'text-text-primary hover:bg-accent/5',
            )}
            onMouseEnter={() => onHighlight(items.length)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCustomSubmit?.()}
          >
            {customPrefix && <span className="text-text-dim">{customPrefix}</span>}
            <span className="text-accent">{customValue}</span>
            <kbd className="border-border bg-bg-primary text-text-dim ml-auto shrink-0 rounded border px-1 text-[9px]">
              enter
            </kbd>
          </button>
        )}

        {items.length === 0 && !showCustomRow && (
          <div className="text-text-dim px-2.5 py-4 text-center text-xs">{emptyText}</div>
        )}
      </div>
    </div>
  );
}

export function FilterBuilder({ fields, activeFilters, onAdd, onRemove, onClear }: FilterBuilderProps) {
  const [step, setStep] = useState<Step>('closed');
  const [selectedField, setSelectedField] = useState<FilterFieldConfig | null>(null);
  const [selectedOperator, setSelectedOperator] = useState<FilterOperator | null>(null);
  const [searchValue, setSearchValue] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [focusedPill, setFocusedPill] = useState<number | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownInputRef = useRef<HTMLInputElement>(null);
  const pillRefs = useRef<Map<number, HTMLElement>>(new Map());

  const isOpen = step !== 'closed';

  const resetDropdown = useCallback(() => {
    setSearchValue('');
    setHighlightIndex(0);
  }, []);

  const resetState = useCallback(() => {
    setStep('closed');
    setSelectedField(null);
    setSelectedOperator(null);
    setEditing(null);
    resetDropdown();
    setFocusedPill(null);
  }, [resetDropdown]);

  const focusDropdown = useCallback(() => {
    setTimeout(() => dropdownInputRef.current?.focus(), 10);
  }, []);

  const focusPill = useCallback((index: number) => {
    setFocusedPill(index);
    setTimeout(() => pillRefs.current.get(index)?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!isOpen && focusedPill === null) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        resetState();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, focusedPill, resetState]);

  useEffect(() => {
    if (isOpen) focusDropdown();
  }, [step, isOpen, focusDropdown]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      if (e.key === ':' && !isEditing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setStep('field');
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    setHighlightIndex(0);
  }, [searchValue]);

  const getFieldLabel = useCallback(
    (fieldName: string) => fields.find((f) => f.field === fieldName)?.label ?? fieldName,
    [fields],
  );

  const getFieldConfig = useCallback(
    (fieldName: string) => fields.find((f) => f.field === fieldName) ?? null,
    [fields],
  );

  const handleFieldSelect = useCallback(
    (field: FilterFieldConfig) => {
      setSelectedField(field);
      resetDropdown();
      if (field.type === 'enum') {
        setSelectedOperator('eq');
        setStep('value');
      } else {
        setStep('operator');
      }
    },
    [resetDropdown],
  );

  const handleOperatorSelect = useCallback(
    (operator: FilterOperator) => {
      setSelectedOperator(operator);
      resetDropdown();
      setStep('value');
    },
    [resetDropdown],
  );

  const handleValueSubmit = useCallback(
    (value: string) => {
      if (!selectedField || !selectedOperator || !value) return;

      if (editing) {
        onRemove(editing.filterId);
      }

      onAdd(selectedField.field, selectedOperator, value);
      setSelectedField(null);
      setSelectedOperator(null);
      setEditing(null);
      resetDropdown();
      setStep('field');
    },
    [selectedField, selectedOperator, editing, onAdd, onRemove, resetDropdown],
  );

  const handleGoBack = useCallback(() => {
    resetDropdown();
    if (step === 'value') {
      if (selectedField?.type === 'enum') {
        setSelectedOperator(null);
        setStep('field');
      } else {
        setSelectedOperator(null);
        setStep('operator');
      }
    } else if (step === 'operator') {
      setSelectedField(null);
      setStep('field');
    } else {
      if (editing) setEditing(null);
      resetState();
    }
  }, [step, selectedField, editing, resetDropdown, resetState]);

  const startEditField = useCallback(
    (filter: ActiveFilter) => {
      setEditing({ filterId: filter.id, field: getFieldConfig(filter.field)!, operator: filter.operator });
      setSelectedField(null);
      setSelectedOperator(null);
      setFocusedPill(null);
      resetDropdown();
      setStep('field');
    },
    [getFieldConfig, resetDropdown],
  );

  const startEditOperator = useCallback(
    (filter: ActiveFilter) => {
      const fieldConfig = getFieldConfig(filter.field);
      if (!fieldConfig) return;
      setEditing({ filterId: filter.id, field: fieldConfig, operator: filter.operator });
      setSelectedField(fieldConfig);
      setSelectedOperator(null);
      setFocusedPill(null);
      resetDropdown();
      setStep('operator');
    },
    [getFieldConfig, resetDropdown],
  );

  const startEditValue = useCallback(
    (filter: ActiveFilter) => {
      const fieldConfig = getFieldConfig(filter.field);
      if (!fieldConfig) return;
      setEditing({ filterId: filter.id, field: fieldConfig, operator: filter.operator });
      setSelectedField(fieldConfig);
      setSelectedOperator(filter.operator);
      setFocusedPill(null);
      resetDropdown();
      setStep('value');
    },
    [getFieldConfig, resetDropdown],
  );

  const getFilteredItems = (): ListItem[] => {
    const query = searchValue.toLowerCase();

    if (step === 'field') {
      return fields
        .filter((f) => f.label.toLowerCase().includes(query))
        .map((f) => ({
          key: f.field,
          label: f.label,
          detail: f.type,
          onSelect: () => handleFieldSelect(f),
        }));
    }

    if (step === 'operator' && selectedField) {
      return OPERATORS_BY_TYPE[selectedField.type]
        .filter((op) => OPERATOR_LABELS[op].toLowerCase().includes(query) || OPERATOR_SYMBOLS[op].includes(query))
        .map((op) => ({
          key: op,
          label: `${OPERATOR_SYMBOLS[op]}  ${OPERATOR_LABELS[op]}`,
          onSelect: () => handleOperatorSelect(op),
        }));
    }

    if (step === 'value' && selectedField) {
      return (selectedField.options ?? [])
        .filter((opt) => opt.toLowerCase().includes(query))
        .map((opt) => ({
          key: opt,
          label: opt,
          onSelect: () => handleValueSubmit(opt),
        }));
    }

    return [];
  };

  const filteredItems = getFilteredItems();
  const allowCustomValue = step === 'value' && selectedField?.type !== 'enum';
  const hasExactMatch = filteredItems.some((item) => item.label.toLowerCase() === searchValue.toLowerCase());
  const showCustomRow = allowCustomValue && !!searchValue.trim() && !hasExactMatch;
  const totalRows = filteredItems.length + (showCustomRow ? 1 : 0);

  const unfilteredCount =
    step === 'field'
      ? fields.length
      : step === 'operator' && selectedField
        ? OPERATORS_BY_TYPE[selectedField.type].length
        : step === 'value' && selectedField
          ? (selectedField.options?.length ?? 0)
          : 0;

  const getDropdownPlaceholder = (): string => {
    if (step === 'field') return 'Search fields...';
    if (step === 'operator' && selectedField) return `${selectedField.label} — pick operator...`;
    if (step === 'value' && selectedField && selectedOperator) {
      return selectedField.options?.length
        ? `Search ${selectedField.label.toLowerCase()} values...`
        : `Type a ${selectedField.label.toLowerCase()} value...`;
    }
    return 'Search...';
  };

  const getInlinePrefix = (): string | null => {
    if (step === 'operator' && selectedField) return selectedField.label;
    if (step === 'value' && selectedField && selectedOperator)
      return `${selectedField.label} ${OPERATOR_SYMBOLS[selectedOperator]}`;
    return null;
  };

  const inlinePrefix = getInlinePrefix();

  const handleDropdownKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, totalRows - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightIndex < filteredItems.length) {
          filteredItems[highlightIndex]?.onSelect();
        } else if (showCustomRow) {
          handleValueSubmit(searchValue.trim());
        }
        break;
      case 'Escape':
        e.preventDefault();
        if (editing) setEditing(null);
        resetState();
        break;
      case 'Backspace':
        if (!searchValue) {
          e.preventDefault();
          if (step !== 'field') {
            handleGoBack();
          } else if (activeFilters.length > 0) {
            if (editing) setEditing(null);
            setStep('closed');
            setSelectedField(null);
            setSelectedOperator(null);
            resetDropdown();
            focusPill(activeFilters.length - 1);
          } else {
            if (editing) setEditing(null);
            resetState();
          }
        }
        break;
    }
  };

  const handlePillKeyDown = (e: React.KeyboardEvent, index: number) => {
    const filter = activeFilters[index];
    if (!filter) return;

    switch (e.key) {
      case 'Backspace':
      case 'Delete':
        e.preventDefault();
        onRemove(filter.id);
        if (activeFilters.length <= 1) {
          setFocusedPill(null);
          setStep('field');
        } else if (index >= activeFilters.length - 1) {
          focusPill(activeFilters.length - 2);
        } else {
          focusPill(index);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (index > 0) focusPill(index - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (index < activeFilters.length - 1) {
          focusPill(index + 1);
        } else {
          setFocusedPill(null);
          setStep('field');
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        startEditValue(filter);
        break;
      case 'Escape':
        e.preventDefault();
        setFocusedPill(null);
        break;
    }
  };

  const handleBarClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-pill]')) return;
    setFocusedPill(null);
    if (step === 'closed') {
      setStep('field');
    } else {
      focusDropdown();
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative min-w-0 flex-1 basis-full md:basis-0"
      role="group"
      aria-label="Active filters"
    >
      <div
        className={cn(
          'peer relative flex min-h-10 cursor-text flex-wrap items-center gap-1.5 px-3 py-1.5 font-mono text-sm [&>[data-pill]]:max-md:w-full',
          'bg-bg-primary text-text-primary',
          'border-text-muted border-t border-r-0 border-b border-l-0',
          isOpen && 'border-accent',
        )}
        onClick={handleBarClick}
      >
        <span
          className={cn(
            'border-text-muted pointer-events-none absolute -top-px left-0 h-2 w-2 border-t border-l',
            isOpen && 'border-accent',
          )}
        />
        <span
          className={cn(
            'border-text-muted pointer-events-none absolute -top-px right-0 h-2 w-2 border-t border-r',
            isOpen && 'border-accent',
          )}
        />
        <span
          className={cn(
            'border-text-muted pointer-events-none absolute -bottom-px left-0 h-2 w-2 border-b border-l',
            isOpen && 'border-accent',
          )}
        />
        <span
          className={cn(
            'border-text-muted pointer-events-none absolute right-0 -bottom-px h-2 w-2 border-r border-b',
            isOpen && 'border-accent',
          )}
        />

        <ListFilter className="text-text-dim h-4 w-4 shrink-0" aria-hidden="true" />

        {activeFilters.map((filter, i) => {
          const isBeingEdited = editing?.filterId === filter.id;
          const isFocused = focusedPill === i;

          return (
            <span
              key={filter.id}
              ref={(el) => {
                if (el) pillRefs.current.set(i, el);
                else pillRefs.current.delete(i);
              }}
              data-pill
              role="option"
              aria-selected={isFocused}
              aria-label={`${getFieldLabel(filter.field)} ${OPERATOR_SYMBOLS[filter.operator]} ${filter.value}`}
              tabIndex={isFocused ? 0 : -1}
              className={cn(
                'inline-flex items-center rounded-sm border font-mono text-xs transition-colors outline-none',
                isBeingEdited
                  ? 'border-accent bg-accent/20 ring-accent animate-pulse ring-1'
                  : isFocused
                    ? 'border-accent bg-accent/15 ring-accent ring-1'
                    : 'border-accent/25 bg-accent/8',
              )}
              onKeyDown={(e) => handlePillKeyDown(e, i)}
              onFocus={() => setFocusedPill(i)}
            >
              <span
                className="border-accent/20 text-accent-dim hover:bg-accent/10 cursor-pointer border-r px-1.5 py-0.5 font-medium transition-colors"
                role="button"
                tabIndex={-1}
                aria-label={`Change field from ${getFieldLabel(filter.field)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  startEditField(filter);
                }}
              >
                {getFieldLabel(filter.field)}
              </span>
              <span
                className="border-accent/20 text-text-dim hover:bg-accent/10 cursor-pointer border-r px-1 py-0.5 transition-colors"
                role="button"
                tabIndex={-1}
                aria-label={`Change operator from ${OPERATOR_LABELS[filter.operator]}`}
                onClick={(e) => {
                  e.stopPropagation();
                  startEditOperator(filter);
                }}
              >
                {OPERATOR_SYMBOLS[filter.operator]}
              </span>
              <span
                className="border-accent/20 text-accent hover:bg-accent/10 cursor-pointer border-r px-1.5 py-0.5 font-semibold transition-colors"
                role="button"
                tabIndex={-1}
                aria-label={`Change value from ${filter.value}`}
                onClick={(e) => {
                  e.stopPropagation();
                  startEditValue(filter);
                }}
              >
                {filter.value}
              </span>
              <span
                className="text-text-dim hover:bg-status-offline/20 hover:text-status-offline cursor-pointer px-1 py-0.5 transition-colors"
                role="button"
                tabIndex={-1}
                aria-label={`Remove ${getFieldLabel(filter.field)} filter`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(filter.id);
                }}
              >
                <X className="h-3 w-3" />
              </span>
            </span>
          );
        })}

        {inlinePrefix && !editing && (
          <span className="text-text-dim font-mono text-xs whitespace-nowrap">{inlinePrefix}</span>
        )}

        {!isOpen && !inlinePrefix && (
          <span className="text-text-dim flex-1 basis-full py-0.5 text-sm md:basis-0">
            {activeFilters.length > 0 ? 'Add filter...' : 'Filter...'}
          </span>
        )}

        {editing && inlinePrefix && (
          <span className="text-text-dim font-mono text-xs whitespace-nowrap">{inlinePrefix}</span>
        )}

        {activeFilters.length > 0 && (
          <button
            type="button"
            className="border-text-dim/30 text-text-dim hover:border-status-offline/50 hover:text-status-offline ml-auto shrink-0 cursor-pointer rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors"
            aria-label="Clear all filters"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
              resetState();
            }}
          >
            Clear
          </button>
        )}

        {!isOpen && activeFilters.length === 0 && (
          <kbd className="border-border bg-bg-primary text-text-dim pointer-events-none shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px]">
            :
          </kbd>
        )}
      </div>

      {isOpen && (
        <SearchDropdown
          items={filteredItems}
          totalCount={unfilteredCount}
          placeholder={getDropdownPlaceholder()}
          highlightIndex={highlightIndex}
          onHighlight={setHighlightIndex}
          searchValue={searchValue}
          onSearchChange={setSearchValue}
          onKeyDown={handleDropdownKeyDown}
          inputRef={dropdownInputRef}
          emptyText={allowCustomValue ? 'Type a value and press Enter' : 'No matches'}
          showCustomRow={showCustomRow}
          customPrefix={
            selectedField && selectedOperator
              ? `${selectedField.label} ${OPERATOR_SYMBOLS[selectedOperator]}`
              : undefined
          }
          customValue={searchValue.trim()}
          onCustomSubmit={() => handleValueSubmit(searchValue.trim())}
        />
      )}
    </div>
  );
}
