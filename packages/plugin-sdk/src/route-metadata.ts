/** Per-route metadata for the host's OpenAPI generator; shape must stay identical to the host's internal `RouteMetadata`. */
export type RouteVisibility = 'public' | 'internal';

export interface RouteMetadata {
  visibility: RouteVisibility;
}
