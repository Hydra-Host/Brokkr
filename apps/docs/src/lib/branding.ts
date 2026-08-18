export const BRAND_NAME = import.meta.env.VITE_BRAND_NAME?.trim() || 'BoSS';
export const COMPANY_NAME = import.meta.env.VITE_COMPANY_NAME?.trim() || BRAND_NAME;
export const SUPPORT_EMAIL = import.meta.env.VITE_SUPPORT_EMAIL?.trim() || 'support@example.com';
export const LEGAL_EMAIL = import.meta.env.VITE_LEGAL_EMAIL?.trim() || 'legal@example.com';

const DEFAULT_COMPANY_URL = 'https://example.com';

function normalizeCompanyUrl(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed) {
    try {
      const { protocol } = new URL(trimmed);
      if (protocol === 'http:' || protocol === 'https:') {
        return trimmed.replace(/\/+$/, '');
      }
    } catch (error) {
      console.warn('Invalid company URL', error);
    }
  }
  return DEFAULT_COMPANY_URL;
}

export const COMPANY_URL = normalizeCompanyUrl(import.meta.env.VITE_COMPANY_URL);
export const TERMS_URL = import.meta.env.VITE_TERMS_URL?.trim() || `${COMPANY_URL}/terms`;
export const PRIVACY_URL = import.meta.env.VITE_PRIVACY_URL?.trim() || `${COMPANY_URL}/privacy`;
export const SECURITY_URL = import.meta.env.VITE_SECURITY_URL?.trim() || COMPANY_URL;
export const HELPDESK_URL = import.meta.env.VITE_HELPDESK_URL?.trim() || '';
