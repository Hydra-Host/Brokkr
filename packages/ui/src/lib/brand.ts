let brandName = 'Platform';
let helpdeskUrl = '';

export function configureUiBrand(opts: { name?: string; helpdeskUrl?: string }): void {
  if (opts.name) brandName = opts.name;
  if (opts.helpdeskUrl !== undefined) helpdeskUrl = opts.helpdeskUrl;
}

export const getUiBrandName = (): string => brandName;
export const getHelpdeskUrl = (): string => helpdeskUrl;
