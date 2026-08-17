export interface ErrorResponseBody {
  error: string;
}

export function errorResponse(error: string): ErrorResponseBody {
  return { error };
}
